import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeTransport } from "../extension/bridge-transport.ts";
import { subagentRoutingSocketPath } from "../extension/subagent-routing-operator.js";
import { callSubagentRouting, type SubagentRoutingDescriptor } from "../plugin/server/subagent-routing-transport.ts";

test("subagent-routing relay carries validated read and set requests on an independent socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-routing-socket-")), pipe = join(root, "bridge.sock"), transport = new BridgeTransport("session-file", pipe);
  const identity = { agentId: "agent", sessionId: "session", runtimeEpoch: transport.operatorEpoch, serviceEpoch: "service", capability: transport.subagentRoutingCapability };
  const calls: unknown[] = [];
  transport.bind({ command: async () => {}, attached() {}, detached() {}, error() {},
    subagentRoutingIdentity: () => identity,
    subagentRouting: async request => { calls.push(request); return request; },
  });
  transport.start();
  const descriptor: SubagentRoutingDescriptor = { version: 1, socketPath: subagentRoutingSocketPath(pipe), ...identity };
  async function invoke(request: Record<string, unknown>, capability = identity.capability) {
    return callSubagentRouting({ ...descriptor, capability }, request, 2_000);
  }
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      try { if (((await stat(descriptor.socketPath)).mode & 0o777) === 0o600) break; } catch { /* endpoint is still starting */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const snapshot = await invoke({ operation: "snapshot", sessionId: identity.sessionId });
    assert.deepEqual(snapshot, { operation: "snapshot", sessionId: "session" });
    const setRequest = { operation: "set", request: { expectedSessionId: "session", expectedServiceEpoch: "service", expectedRevision: 0, selection: { providerId: "vendor", accountId: null } } };
    assert.deepEqual(await invoke(setRequest), setRequest);
    assert.deepEqual(await invoke({ operation: "providers", sessionId: "session" }), { operation: "providers", sessionId: "session" });
    await assert.rejects(invoke({ operation: "set", request: { ...setRequest.request, expectedRevision: -1 } }));
    await assert.rejects(invoke({ operation: "snapshot", sessionId: "session" }, "b".repeat(64)));
    assert.equal(calls.length, 3, "invalid frames never reach the service callback");
  } finally { transport.close(); await rm(root, { recursive: true, force: true }); }
});
