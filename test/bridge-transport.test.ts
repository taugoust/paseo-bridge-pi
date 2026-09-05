import assert from "node:assert/strict";
import test from "node:test";
import * as net from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeTransport, retainBridgeForReload, takeBridgeAfterReload, discardRetainedBridge } from "../extension/bridge-transport.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-bridge-reload-"));
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\${root.replace(/[^a-z0-9]/gi, "")}` : join(root, "bridge.sock");
  const transport = new BridgeTransport("same-session", socketPath);
  const errors: unknown[] = [];
  let oldCalls = 0;
  transport.bind({ command: async (cmd) => { oldCalls++; transport.send({ id: cmd.id, owner: "old" }); }, attached() {}, detached() {}, error: error => errors.push(error) });
  transport.start();
  const client = net.connect(socketPath);
  const messages: any[] = [];
  let buffer = "";
  client.on("data", chunk => {
    buffer += chunk.toString();
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      messages.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  await once(client, "connect");
  async function response(id: number) {
    const deadline = Date.now() + 2000;
    while (!messages.some(message => message.id === id)) {
      assert(Date.now() < deadline, `missing response ${id}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return messages.find(message => message.id === id);
  }
  return { root, socketPath, transport, client, errors, response, oldCalls: () => oldCalls, async close() {
    discardRetainedBridge();
    client.destroy();
    transport.close();
    await rm(root, { recursive: true, force: true });
  } };
}

test("same-session reload retains the socket and routes subsequent commands only to the new context", async () => {
  const f = await fixture();
  try {
    f.client.write('{"id":1,"type":"get_state"}\n');
    assert.equal((await f.response(1)).owner, "old");
    retainBridgeForReload(f.transport, "existing-agent", true);
    f.client.write('{"id":2,"type":"prompt","message":"do not dispatch during reload"}\n');
    assert.equal((await f.response(2)).success, false);
    assert.equal(f.oldCalls(), 1);
    const retained = takeBridgeAfterReload("same-session");
    assert.equal(retained?.transport, f.transport);
    assert.equal(retained?.agentId, "existing-agent");
    assert.equal(retained?.titleAttempted, true);
    f.transport.bind({ command: async cmd => { f.transport.send({ id: cmd.id, owner: "new", text: cmd.message }); }, attached() {}, detached() {}, error: error => f.errors.push(error) });
    const frame = Buffer.from('{"id":3,"type":"prompt","message":"🌍"}\n');
    const offset = frame.indexOf(Buffer.from("🌍"));
    f.client.write(frame.subarray(0, offset + 1));
    await new Promise(resolve => setTimeout(resolve, 5));
    f.client.write(frame.subarray(offset + 1));
    assert.deepEqual(await f.response(3), { id: 3, owner: "new", text: "🌍" });
    assert.equal(f.oldCalls(), 1);
    assert.equal(f.client.destroyed, false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("a controller can reconnect to the same endpoint if it disconnects during reload", async () => {
  const f = await fixture();
  let replacement: net.Socket | undefined;
  try {
    retainBridgeForReload(f.transport, "existing-agent", true);
    f.client.destroy();
    const deadline = Date.now() + 2000;
    while (f.transport.connected) {
      assert(Date.now() < deadline);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(takeBridgeAfterReload("same-session")?.agentId, "existing-agent");
    f.transport.bind({ command: async cmd => { f.transport.send({ id: cmd.id, owner: "replacement" }); }, attached() {}, detached() {}, error: error => f.errors.push(error) });
    replacement = net.connect(f.socketPath);
    await once(replacement, "connect");
    const reply = once(replacement, "data");
    replacement.write('{"id":5,"type":"get_state"}\n');
    const [data] = await reply;
    assert.equal(JSON.parse(data.toString()).owner, "replacement");
    assert.deepEqual(f.errors, []);
  } finally { replacement?.destroy(); await f.close(); }
});

test("session replacement closes a retained bridge instead of adopting the wrong session", async () => {
  const f = await fixture();
  try {
    const closed = once(f.client, "close");
    retainBridgeForReload(f.transport, null, false);
    assert.equal(takeBridgeAfterReload("different-session"), undefined);
    await closed;
    assert.equal(f.transport.connected, false);
  } finally { await f.close(); }
});

test("a failed or removed extension cannot retain a suspended socket forever", async () => {
  const f = await fixture();
  try {
    const closed = once(f.client, "close");
    retainBridgeForReload(f.transport, null, false, 20);
    await closed;
    assert.equal(takeBridgeAfterReload("same-session"), undefined);
  } finally { await f.close(); }
});

test("a second controller is rejected without disrupting the retained controller", async () => {
  const f = await fixture();
  try {
    const other = net.connect(f.socketPath);
    const [data] = await once(other, "data");
    assert.match(data.toString(), /another controller/);
    other.destroy();
    f.client.write('{"id":4,"type":"get_state"}\n');
    assert.equal((await f.response(4)).owner, "old");
    assert.equal(f.client.destroyed, false);
  } finally { await f.close(); }
});
