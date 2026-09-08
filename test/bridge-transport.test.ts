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

test("read-only native fork snapshot works while Paseo controller remains attached", async () => {
  const f = await fixture();
  try {
    const manifest = { sessionFile: "same-session", leafId: "active-not-last", messages: [{ role: "assistant", content: [{ type: "toolCall", id: "pending" }] }] };
    let detached = 0;
    f.transport.bind({ command: async cmd => f.transport.send({ id: cmd.id, owner: "controller" }), forkSnapshot: () => manifest,
      attached() {}, detached() { detached++; }, error: error => f.errors.push(error) });
    const observer = net.connect(`${f.socketPath}.fork`);
    let payload = "";
    observer.on("data", chunk => { payload += chunk.toString(); });
    await once(observer, "end");
    assert.deepEqual(JSON.parse(payload).data, manifest);
    assert.equal(detached, 0);
    assert.equal(f.transport.connected, true);
    f.client.write('{"id":99,"type":"get_state"}\n');
    assert.equal((await f.response(99)).owner, "controller");
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("legacy retained transport gains snapshot endpoint without replacing its controller", async () => {
  const f = await fixture();
  try {
    // Reproduce the pre-upgrade object's shape/prototype and absence of .fork.
    const legacy = f.transport as any;
    await new Promise<void>(resolve => legacy.snapshotServer.close(resolve));
    delete legacy.snapshotServer;
    const descriptors = Object.getOwnPropertyDescriptors(BridgeTransport.prototype);
    delete descriptors.ensureForkSnapshotEndpoint;
    descriptors.bind = { value: function(callbacks: any) { this.callbacks = callbacks; if (this.connected) callbacks.attached(); } };
    Object.setPrototypeOf(legacy, Object.create(Object.prototype, descriptors));
    assert.equal(legacy.ensureForkSnapshotEndpoint, undefined);
    const server = legacy.server, client = legacy.client;
    retainBridgeForReload(f.transport, "source", true);
    const retained = takeBridgeAfterReload("same-session")!;
    retained.transport.bind({ command: async cmd => retained.transport.send({ id: cmd.id, owner: "upgraded" }),
      forkSnapshot: () => ({ leafId: "current" }), attached() {}, detached() {}, error: error => f.errors.push(error) });
    assert.equal(legacy.server, server);
    assert.equal(legacy.client, client);
    const observer = net.connect(`${f.socketPath}.fork`);
    let payload = "";
    observer.on("data", chunk => { payload += chunk.toString(); });
    await once(observer, "end");
    assert.equal(JSON.parse(payload).data.leafId, "current");
    f.client.write('{"id":100,"type":"get_state"}\n');
    assert.equal((await f.response(100)).owner, "upgraded");
    assert.deepEqual(f.errors, []);
    retained.transport.close();
    const probe = net.connect(`${f.socketPath}.fork`);
    await once(probe, "error");
    probe.destroy();
  } finally { await f.close(); }
});

test("resolver reads compact live manifest over real side socket with controller attached", async () => {
  const f = await fixture();
  try {
    const { createHash } = await import("node:crypto");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const sessionFile = resolve("same-session");
    const runtimeDir = join(f.root, ".pi", "paseo-bridge", "runtimes");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, createHash("sha256").update(sessionFile).digest("hex") + ".json"), JSON.stringify({ bridgeSocket: f.socketPath }));
    const manifest = { sessionFile, leafId: "active", messages: [{ role: "assistant", content: [] }] };
    f.transport.bind({ command: async cmd => f.transport.send({ id: cmd.id, owner: "unchanged" }), forkSnapshot: () => manifest,
      attached() {}, detached() {}, error: error => f.errors.push(error) });
    const moduleUrl = new URL("../shim/fork-support.js", import.meta.url).href;
    const script = `import { readLiveForkSnapshot } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(readLiveForkSnapshot(${JSON.stringify(sessionFile)})));`;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, HOME: f.root }, timeout: 10000 });
    assert.deepEqual(JSON.parse(stdout), manifest);
    f.client.write('{"id":101,"type":"get_state"}\n');
    assert.equal((await f.response(101)).owner, "unchanged");
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
