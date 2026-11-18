import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subagentRoutingDescriptorPath, removeSubagentRoutingDescriptor, validateSubagentRoutingEnvelope, writeSubagentRoutingDescriptor } from "../extension/subagent-routing-operator.js";

test("subagent-routing descriptor is private and envelope accepts only bounded identity-matched operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-routing-"));
  try {
    const descriptor = { version: 1, socketPath: join(root, "bridge.subagent-routing"), capability: "a".repeat(64), agentId: "agent", sessionId: "session", runtimeEpoch: "runtime", serviceEpoch: "service" };
    const file = writeSubagentRoutingDescriptor(root, descriptor);
    assert.equal(file, subagentRoutingDescriptorPath(root, "agent"));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), descriptor);
    const identity = { ...descriptor };
    const frame = (request: unknown) => ({ v: 1, type: "subagent_routing", id: "request-1", capability: identity.capability, agentId: identity.agentId, sessionId: identity.sessionId, runtimeEpoch: identity.runtimeEpoch, serviceEpoch: identity.serviceEpoch, request });
    assert.equal(validateSubagentRoutingEnvelope(frame({ operation: "snapshot", sessionId: "session" }), identity), true);
    assert.equal(validateSubagentRoutingEnvelope(frame({ operation: "providers", sessionId: "session" }), identity), true);
    assert.equal(validateSubagentRoutingEnvelope(frame({ operation: "set", request: { expectedSessionId: "session", expectedServiceEpoch: "service", expectedRevision: 0, selection: { providerId: "vendor:compat", accountId: null } } }), identity), true);
    assert.equal(validateSubagentRoutingEnvelope(frame({ operation: "set", request: { expectedSessionId: "session", expectedServiceEpoch: "service", expectedRevision: 0, selection: { providerId: "openai-codex", accountId: "Named account with spaces" } } }), identity), true);
    for (const request of [
      { operation: "snapshot", sessionId: "other" },
      { operation: "providers", sessionId: "session", extra: true },
      { operation: "set", request: { expectedSessionId: "session", expectedServiceEpoch: "service", expectedRevision: -1, selection: null } },
      { operation: "set", request: { expectedSessionId: "session", expectedServiceEpoch: "service", expectedRevision: 0, selection: { providerId: "bad/name", accountId: null } } },
      { operation: "set", request: { expectedSessionId: "session", expectedServiceEpoch: "service", expectedRevision: 0, selection: { providerId: "vendor", accountId: "named-login" } } },
      { operation: "set", request: { expectedSessionId: "session", expectedServiceEpoch: "service", expectedRevision: 0, selection: { providerId: "openai-codex", accountId: "x".repeat(257) } } },
      { operation: "set", request: { expectedSessionId: "session", expectedServiceEpoch: "service", expectedRevision: 0, selection: { providerId: "openai-codex", accountId: "bad\u0000account" } } },
      { operation: "set", request: { expectedSessionId: "session", expectedServiceEpoch: "service", expectedRevision: 0, selection: { providerId: "session-follow", accountId: null } } },
    ]) assert.equal(validateSubagentRoutingEnvelope(frame(request), identity), false);
    assert.equal(validateSubagentRoutingEnvelope({ ...frame({ operation: "providers", sessionId: "session" }), serviceEpoch: "stale" }, identity), false);
    removeSubagentRoutingDescriptor(root, "agent", "wrong-runtime"); assert.equal((await stat(file)).isFile(), true);
    removeSubagentRoutingDescriptor(root, "agent", "runtime"); await assert.rejects(stat(file));
  } finally { await rm(root, { recursive: true, force: true }); }
});
