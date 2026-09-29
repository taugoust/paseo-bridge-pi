import test from "node:test";
import assert from "node:assert/strict";
import { descriptorMatchesExpectedSession, validateDescriptor, validateWireResponse } from "../shared/wire.ts";

const descriptor = {
  version: 1 as const, socketPath: "/private/operator.sock", capability: "a".repeat(64),
  agentId: "agent-1", sessionId: "session-1", runtimeEpoch: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
};
const response = (id: string, enabled: boolean) => ({
  v: 1, type: "permission_gate_mode", id, success: true,
  data: { agentId: descriptor.agentId, sessionId: descriptor.sessionId, runtimeEpoch: descriptor.runtimeEpoch, enabled },
});

test("descriptor is bound to exact agent and validates private capability shape", () => {
  assert.equal(validateDescriptor(descriptor, "agent-1"), true);
  assert.equal(validateDescriptor(descriptor, "agent-2"), false);
  assert.equal(validateDescriptor({ ...descriptor, capability: "short" }, "agent-1"), false);
  assert.equal(validateDescriptor({ ...descriptor, runtimeEpoch: "" }, "agent-1"), false);
});

test("writes require current session and runtime epoch; reload or adoption blocks stale UI", () => {
  assert.equal(descriptorMatchesExpectedSession(descriptor, "session-1", descriptor.runtimeEpoch), true);
  assert.equal(descriptorMatchesExpectedSession(descriptor, "new-session", descriptor.runtimeEpoch), false);
  assert.equal(descriptorMatchesExpectedSession(descriptor, "session-1", "c".repeat(32)), false);
});

test("wire response requires matching request, agent, session and epoch", () => {
  assert.equal(validateWireResponse(response("req-1", false), "req-1", descriptor), true);
  assert.equal(validateWireResponse(response("wrong", true), "req-1", descriptor), false);
  assert.equal(validateWireResponse({ ...response("req-1", true), data: { ...response("req-1", true).data, agentId: "other" } }, "req-1", descriptor), false);
  assert.equal(validateWireResponse({ ...response("req-1", true), data: { ...response("req-1", true).data, sessionId: "other" } }, "req-1", descriptor), false);
  assert.equal(validateWireResponse({ ...response("req-1", true), data: { ...response("req-1", true).data, runtimeEpoch: "other" } }, "req-1", descriptor), false);
  assert.equal(validateWireResponse({ ...response("req-1", true), extra: true }, "req-1", descriptor), false);
});
