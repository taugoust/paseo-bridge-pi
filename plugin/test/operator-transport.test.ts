import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOperator } from "../server/operator-transport.ts";

const base = { version: 1 as const, socketPath: "", capability: "c".repeat(64), agentId: "agent", sessionId: "session", runtimeEpoch: "d".repeat(32) };
async function withSocket(handler: (socket: import("node:net").Socket) => void, run: (path: string) => Promise<unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "permission-gate-test-"));
  const socketPath = join(dir, "operator.sock");
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
  await chmod(socketPath, 0o600);
  try { return await run(socketPath); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
}

test("status omits enabled; explicit set sends boolean and validates matching response", async () => {
  await withSocket((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.endsWith("\n")) return;
      const request = JSON.parse(input);
      assert.equal(request.action, "status");
      assert.equal(Object.hasOwn(request, "enabled"), false);
      socket.end(`${JSON.stringify({ v: 1, type: "permission_gate_mode", id: request.id, success: true, data: { agentId: request.agentId, sessionId: request.sessionId, runtimeEpoch: request.runtimeEpoch, enabled: true } })}\n`);
    });
  }, async (socketPath) => assert.equal(await callOperator({ ...base, socketPath }, "status"), true));

  await withSocket((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (!input.endsWith("\n")) return;
      const request = JSON.parse(input);
      assert.equal(request.action, "set");
      assert.equal(request.enabled, false);
      socket.end(`${JSON.stringify({ v: 1, type: "permission_gate_mode", id: request.id, success: true, data: { agentId: request.agentId, sessionId: request.sessionId, runtimeEpoch: request.runtimeEpoch, enabled: false } })}\n`);
    });
  }, async (socketPath) => assert.equal(await callOperator({ ...base, socketPath }, "set", false), false));
});

test("closed, malformed, stale and mismatched responses reject promptly", async () => {
  await withSocket((socket) => socket.on("data", () => socket.end()), async (socketPath) => {
    await assert.rejects(callOperator({ ...base, socketPath }, "status"), /closed without|closed before/);
  });
  await withSocket((socket) => socket.on("data", () => socket.end("not-json\n")), async (socketPath) => {
    await assert.rejects(callOperator({ ...base, socketPath }, "status"));
  });
  await withSocket((socket) => socket.on("data", (chunk) => {
    const request = JSON.parse(chunk.toString());
    socket.end(`${JSON.stringify({ v: 1, type: "permission_gate_mode", id: request.id, success: true, data: { agentId: request.agentId, sessionId: "old-session", runtimeEpoch: request.runtimeEpoch, enabled: true } })}\n`);
  }), async (socketPath) => {
    await assert.rejects(callOperator({ ...base, socketPath }, "status"));
  });
});

test("silent operator has a bounded timeout", async () => {
  await withSocket((socket) => socket.on("data", () => {}), async (socketPath) => {
    await assert.rejects(callOperator({ ...base, socketPath }, "status", undefined, 30), /timed out/);
  });
});
