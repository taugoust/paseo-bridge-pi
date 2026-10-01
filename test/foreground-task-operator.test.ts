import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foregroundTasksDescriptorPath, removeForegroundTasksDescriptor, writeForegroundTasksDescriptor } from "../extension/foreground-task-operator.js";

test("foreground descriptor is private, stable, agent-keyed, and removed only for its runtime epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "foreground-descriptor-"));
  try {
    const descriptor = { version: 1 as const, socketPath: join(root, "bridge.foreground-tasks"), capability: "a".repeat(64), agentId: "agent-a",
      sessionId: "session-a", runtimeEpoch: "8a990e69-b9c3-4f60-a10c-b55f34d5723d", serviceEpoch: "service-a" };
    const path = writeForegroundTasksDescriptor(root, descriptor);
    assert.equal(path, foregroundTasksDescriptorPath(root, "agent-a"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "operators"))).mode & 0o777, 0o700);
    const before = await stat(path);
    assert.equal(writeForegroundTasksDescriptor(root, descriptor), path);
    assert.equal((await stat(path)).mtimeMs, before.mtimeMs, "unchanged publication avoids descriptor churn");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), descriptor);
    removeForegroundTasksDescriptor(root, "agent-a", "different-runtime");
    assert.equal((await readdir(join(root, "operators"))).length, 1);
    removeForegroundTasksDescriptor(root, "agent-a", descriptor.runtimeEpoch);
    assert.equal((await readdir(join(root, "operators"))).length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
