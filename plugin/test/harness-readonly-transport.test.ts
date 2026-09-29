import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callHarnessReadOnly, validateHarnessReadOnlyDescriptor } from "../server/harness-readonly-transport.ts";
import { BridgeTransport } from "../../extension/bridge-transport.ts";
import { harnessReadOnlyDescriptorPath, writeHarnessReadOnlyDescriptor } from "../../extension/permission-gate-operator.js";

const base = { version: 1 as const, socketPath: "/tmp/readonly.sock", capability: "a".repeat(64), agentId: "agent", sessionId: "session", runtimeEpoch: "00000000-0000-4000-8000-000000000000" };
async function socketFixture(handle: (socket: import("node:net").Socket) => void, run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "harness-readonly-"));
  const socketPath = join(dir, "readonly.sock");
  const server = createServer(handle);
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  await chmod(socketPath, 0o600);
  try { await run(socketPath); } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
}

test("read-only descriptor accepts only private capability and exact identity fields", () => {
  assert.equal(validateHarnessReadOnlyDescriptor(base, "agent"), true);
  assert.equal(validateHarnessReadOnlyDescriptor({ ...base, agentId: "other" }, "agent"), false);
  assert.equal(validateHarnessReadOnlyDescriptor({ ...base, extra: "secret" }, "agent"), false);
  assert.equal(validateHarnessReadOnlyDescriptor({ ...base, runtimeEpoch: "stale" }, "agent"), false);
});

test("read-only descriptor updates are idempotent and avoid recurring fsync writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-descriptor-"));
  try {
    const descriptor = { ...base };
    writeHarnessReadOnlyDescriptor(dir, descriptor);
    const file = harnessReadOnlyDescriptorPath(dir, descriptor.agentId);
    const before = await (await import("node:fs/promises")).stat(file, { bigint: true });
    writeHarnessReadOnlyDescriptor(dir, descriptor);
    const after = await (await import("node:fs/promises")).stat(file, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("read-only transport binds requests and responses to agent/session/epoch", async () => {
  await socketFixture(socket => {
    let line = "";
    socket.on("data", chunk => {
      line += chunk.toString(); if (!line.endsWith("\n")) return;
      const request = JSON.parse(line);
      assert.deepEqual([request.method, request.payload], ["jobs.list", { sessionId: "session", limit: 10 }]);
      socket.end(`${JSON.stringify({ v: 1, type: "harness_readonly", id: request.id, success: true, agentId: request.agentId, sessionId: request.sessionId, runtimeEpoch: request.runtimeEpoch, data: { items: [] } })}\n`);
    });
  }, async socketPath => {
    const response = await callHarnessReadOnly({ ...base, socketPath }, "jobs.list", { sessionId: "session", limit: 10 });
    assert.deepEqual(response, { items: [] });
  });
  await socketFixture(socket => socket.on("data", chunk => {
    const request = JSON.parse(chunk.toString());
    socket.end(`${JSON.stringify({ v: 1, type: "harness_readonly", id: request.id, success: true, agentId: request.agentId, sessionId: "old", runtimeEpoch: request.runtimeEpoch, data: {} })}\n`);
  }), async socketPath => assert.rejects(callHarnessReadOnly({ ...base, socketPath }, "jobs.list", { sessionId: "session" }), /identity mismatch/));
});

test("retained transport lazily initializes socket state and rejects a stale epoch after rebind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-reload-"));
  const transport = new BridgeTransport(join(dir, "session.jsonl"), join(dir, "bridge.sock"));
  let client: import("node:net").Socket | undefined;
  try {
    let expectedCapability = transport.harnessReadOnlyCapability;
    let expectedEpoch = transport.operatorEpoch;
    const callback = async (request: any) => {
      if (request.capability !== expectedCapability || request.runtimeEpoch !== expectedEpoch) throw new Error("authentication failed");
      return { state: "available" };
    };
    transport.bind({ command: async () => {}, attached() {}, detached() {}, error() {}, harnessReadOnly: callback });
    transport.start();
    client = (await import("node:net")).connect(transport.pipePath);
    await new Promise<void>((resolve, reject) => client!.once("connect", resolve).once("error", reject));
    const oldDescriptor = { ...base, socketPath: `${transport.pipePath}.harness-readonly`, capability: transport.harnessReadOnlyCapability, runtimeEpoch: transport.operatorEpoch };
    (transport as any).readonlySockets = undefined; // retained pre-endpoint instances lack this newly added field
    transport.bind({ command: async () => {}, attached() {}, detached() {}, error() {}, harnessReadOnly: callback });
    expectedCapability = transport.harnessReadOnlyCapability;
    expectedEpoch = transport.operatorEpoch;
    const nextDescriptor = { ...oldDescriptor, capability: transport.harnessReadOnlyCapability, runtimeEpoch: transport.operatorEpoch };
    await assert.rejects(callHarnessReadOnly(oldDescriptor, "status", { sessionId: "session" }), /authentication failed/);
    assert.deepEqual(await callHarnessReadOnly(nextDescriptor, "status", { sessionId: "session" }), { state: "available" });
  } finally { client?.destroy(); transport.close(); await rm(dir, { recursive: true, force: true }); }
});

test("bridge sanitizes read-only errors and preserves a valid request ID", async () => {
  const dir = await mkdtemp(join(tmpdir(), "harness-frame-"));
  const transport = new BridgeTransport(join(dir, "session.jsonl"), join(dir, "bridge.sock"));
  let client: import("node:net").Socket | undefined;
  try {
    transport.bind({ command: async () => {}, attached() {}, detached() {}, error() {},
      harnessReadOnly: async () => { throw new Error("bad\ninput\u0001"); } });
    transport.start();
    client = (await import("node:net")).connect(transport.pipePath);
    await new Promise<void>((resolve, reject) => client!.once("connect", resolve).once("error", reject));
    const descriptor = { ...base, socketPath: `${transport.pipePath}.harness-readonly`, capability: transport.harnessReadOnlyCapability };
    await assert.rejects(callHarnessReadOnly(descriptor, "status", { sessionId: "session" }), /bad input /);
  } finally { client?.destroy(); transport.close(); await rm(dir, { recursive: true, force: true }); }
});
