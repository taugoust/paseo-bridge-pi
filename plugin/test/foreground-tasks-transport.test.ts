import assert from "node:assert/strict";
import test from "node:test";
import * as net from "node:net";
import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { callForegroundTasks, foregroundTasksDescriptorPath, validateForegroundTasksDescriptor, type ForegroundTasksDescriptor } from "../server/foreground-tasks-transport.ts";

function descriptor(socketPath: string, patch: Partial<ForegroundTasksDescriptor> = {}): ForegroundTasksDescriptor {
  return { version: 1, socketPath, capability: "a".repeat(64), agentId: "agent-a", sessionId: "session-a", runtimeEpoch: "8a990e69-b9c3-4f60-a10c-b55f34d5723d", serviceEpoch: "service-epoch", ...patch };
}

test("foreground task descriptors require exact target, private capability, bridge epoch and service epoch", () => {
  const valid = descriptor("/tmp/test.sock");
  assert.equal(validateForegroundTasksDescriptor(valid, "agent-a"), true);
  assert.equal(validateForegroundTasksDescriptor(valid, "agent-b"), false);
  assert.equal(validateForegroundTasksDescriptor({ ...valid, unexpected: true }, "agent-a"), false);
  assert.equal(validateForegroundTasksDescriptor({ ...valid, capability: "short" }, "agent-a"), false);
  assert.equal(validateForegroundTasksDescriptor({ ...valid, runtimeEpoch: "bad" }, "agent-a"), false);
  assert.equal(foregroundTasksDescriptorPath("agent-a").split("/").at(-1), `${createHash("sha256").update("agent-a").digest("hex")}.foreground.json`);
});

test("foreground socket client binds request/response to exact parent and request identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "fg-transport-"));
  const socketPath = join(root, "foreground.sock");
  const server = net.createServer(socket => {
    let input = "";
    socket.on("data", chunk => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const request = JSON.parse(input);
      const reply = { v: 1, type: "foreground_tasks", id: request.id, success: true, agentId: request.agentId, sessionId: request.sessionId,
        runtimeEpoch: request.runtimeEpoch, data: { accepted: true, request: request.request } };
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    await chmod(socketPath, 0o600);
    const target = descriptor(socketPath);
    const result: any = await callForegroundTasks(target, { operation: "prompt", target: { taskId: "t-1", childId: "c-1", workerEpoch: "w-1" }, requestId: "id-1", message: "hello" });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.request, { operation: "prompt", target: { taskId: "t-1", childId: "c-1", workerEpoch: "w-1" }, requestId: "id-1", message: "hello", sessionId: "session-a", epoch: "service-epoch" });
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

test("foreground socket rejects cross-agent, stale-epoch, malformed and unsafe descriptors", async () => {
  const root = await mkdtemp(join(tmpdir(), "fg-reject-"));
  const socketPath = join(root, "foreground.sock");
  let wrong: "agent" | "epoch" | "request" = "agent";
  const server = net.createServer(socket => {
    let input = "";
    socket.on("data", chunk => {
      input += chunk.toString();
      if (!input.includes("\n")) return;
      const req = JSON.parse(input);
      socket.end(`${JSON.stringify({ v: 1, type: "foreground_tasks", id: req.id, success: true,
        agentId: wrong === "agent" ? "other" : req.agentId, sessionId: req.sessionId,
        runtimeEpoch: wrong === "epoch" ? "different" : req.runtimeEpoch, data: wrong === "request" ? { bad: true } : {} })}\n`);
    });
  });
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve)); await chmod(socketPath, 0o600);
    const target = descriptor(socketPath);
    await assert.rejects(callForegroundTasks(target, { operation: "list" }), /identity mismatch/);
    wrong = "epoch"; await assert.rejects(callForegroundTasks(target, { operation: "list" }), /identity mismatch/);
    const regularFile = join(root, "not-a-socket");
    await writeFile(regularFile, "not a socket"); await chmod(regularFile, 0o600);
    await assert.rejects(callForegroundTasks({ ...target, socketPath: regularFile }, { operation: "list" }), /not private/);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});
