import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handlePermissionGateOperatorRequest,
  permissionGateOperatorDescriptorPath,
  removePermissionGateOperatorDescriptor,
  writePermissionGateOperatorDescriptor,
  type PermissionGateOperatorDescriptorV1,
} from "../extension/permission-gate-operator.js";

const descriptor: PermissionGateOperatorDescriptorV1 = {
  version: 1,
  socketPath: "/tmp/pi.sock.operator",
  capability: "a".repeat(64),
  agentId: "agent-1",
  sessionId: "session-1",
  runtimeEpoch: "epoch-1",
};

function identity() {
  let enabled = true;
  let statusCalls = 0;
  let applyCalls = 0;
  return {
    get enabled() { return enabled; },
    get statusCalls() { return statusCalls; },
    get applyCalls() { return applyCalls; },
    descriptor,
    authority: () => ({
      status(sessionId: string) {
        statusCalls++;
        if (sessionId !== "session-1") throw new Error("wrong session");
        return { sessionId, enabled };
      },
      applyMode(sessionId: string, next: boolean) {
        applyCalls++;
        if (sessionId !== "session-1") throw new Error("wrong session");
        enabled = next;
        return { sessionId, enabled };
      },
    }),
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    type: "permission_gate_mode",
    id: "req-1",
    capability: descriptor.capability,
    agentId: descriptor.agentId,
    sessionId: descriptor.sessionId,
    runtimeEpoch: descriptor.runtimeEpoch,
    action: "status",
    ...overrides,
  };
}

test("status is read-only and returns exact agent/session/runtime identity", () => {
  const state = identity();
  const response = handlePermissionGateOperatorRequest(request(), state) as any;
  assert.deepEqual(response, {
    v: 1, type: "permission_gate_mode", id: "req-1", success: true,
    data: { agentId: "agent-1", sessionId: "session-1", runtimeEpoch: "epoch-1", enabled: true },
  });
  assert.equal(state.statusCalls, 1);
  assert.equal(state.applyCalls, 0);
});

test("set remains available during an active run and applies only the mode operation", () => {
  let active = true;
  let enabled = true;
  let applyCalls = 0;
  const service = {
    descriptor,
    authority: () => ({
      status: (sessionId: string) => ({ sessionId, enabled }),
      applyMode: (sessionId: string, next: boolean) => {
        assert.equal(active, true);
        applyCalls++;
        enabled = next;
        return { sessionId, enabled };
      },
    }),
  };
  const response = handlePermissionGateOperatorRequest(request({ action: "set", enabled: false }), service) as any;
  assert.equal(response.success, true);
  assert.deepEqual(response.data, { agentId: "agent-1", sessionId: "session-1", runtimeEpoch: "epoch-1", enabled: false });
  assert.equal(enabled, false);
  assert.equal(applyCalls, 1);
  active = false;
});

test("wrong capability, agent, session, epoch, and unexpected fields fail before authority", () => {
  for (const bad of [
    request({ capability: "b".repeat(64) }),
    request({ agentId: "other-agent" }),
    request({ sessionId: "other-session" }),
    request({ runtimeEpoch: "stale-epoch" }),
    request({ prompt: "must not dispatch" }),
    request({ action: "set", enabled: "false" }),
  ]) {
    const state = identity();
    const response = handlePermissionGateOperatorRequest(bad, state) as any;
    assert.equal(response.success, false);
    assert.equal(state.statusCalls + state.applyCalls, 0);
  }
});

test("authority absence and stale-session exceptions fail closed", () => {
  const absent = handlePermissionGateOperatorRequest(request(), { descriptor, authority: () => undefined }) as any;
  assert.equal(absent.success, false);
  const stale = handlePermissionGateOperatorRequest(request(), {
    descriptor,
    authority: () => ({
      status: () => { throw new Error("stale session"); },
      applyMode: () => { throw new Error("stale session"); },
    }),
  }) as any;
  assert.equal(stale.success, false);
  assert.match(stale.error, /stale session/);
});

test("descriptor is private, keyed by agent, and removed only for its exact epoch", async () => {
  const root = await mkdtemp(join(tmpdir(), "permission-gate-operator-"));
  try {
    const path = writePermissionGateOperatorDescriptor(root, descriptor);
    const directory = await stat(join(root, "operators"));
    const file = await stat(path);
    assert.equal(directory.mode & 0o777, 0o700);
    assert.equal(file.mode & 0o777, 0o600);
    assert.equal(path, permissionGateOperatorDescriptorPath(root, "agent-1"));
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), descriptor);
    removePermissionGateOperatorDescriptor(root, "agent-1", "stale-epoch");
    assert.equal((await readdir(join(root, "operators"))).length, 1);
    removePermissionGateOperatorDescriptor(root, "agent-1", "epoch-1");
    assert.deepEqual(await readdir(join(root, "operators")), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
