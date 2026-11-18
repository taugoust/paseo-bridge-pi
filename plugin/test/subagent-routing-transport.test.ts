import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, chmod, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subagentRoutingDescriptorPath, readSubagentRoutingDescriptor, validateSubagentRoutingDescriptor } from "../server/subagent-routing-transport.ts";

test("routing discovery accepts only private descriptors for the exact agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "routing-descriptor-")), ops = join(root, "operators");
  try {
    await mkdir(ops, { mode: 0o700 }); await chmod(ops, 0o700);
    const descriptor = { version: 1, socketPath: "/tmp/subagents.sock", capability: "b".repeat(64), agentId: "agent", sessionId: "session", runtimeEpoch: "123e4567-e89b-42d3-a456-426614174000", serviceEpoch: "service" };
    assert.equal(await readSubagentRoutingDescriptor("agent", root), undefined);
    const path = subagentRoutingDescriptorPath("agent", root);
    await writeFile(path, JSON.stringify(descriptor), { mode: 0o600 });
    assert.equal(validateSubagentRoutingDescriptor(await readSubagentRoutingDescriptor("agent", root), "agent"), true);
    assert.equal(validateSubagentRoutingDescriptor(descriptor, "sibling"), false);
    assert.equal(validateSubagentRoutingDescriptor({ ...descriptor, extra: true }, "agent"), false);
    await chmod(path, 0o644);
    assert.equal(await readSubagentRoutingDescriptor("agent", root), undefined);
    await chmod(path, 0o600); await chmod(ops, 0o755);
    assert.equal(await readSubagentRoutingDescriptor("agent", root), undefined);
    await chmod(ops, 0o700); await rm(path); await symlink("/tmp/other-descriptor", path);
    assert.equal(await readSubagentRoutingDescriptor("agent", root), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
