import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeTransport } from "../extension/bridge-transport.ts";
import {
  subagentRoutingSocketPath,
  writeSubagentRoutingDescriptor,
} from "../extension/subagent-routing-operator.js";
import {
  readAccountControlsDescriptor,
  validateAccountControlsDescriptor,
} from "../plugin/server/account-controls-transport.ts";
import { callBtw } from "../plugin/server/btw-transport.ts";

async function waitForSocket(path: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if (((await stat(path)).mode & 0o777) === 0o600) return;
    } catch {
      // The endpoint is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`socket ${path} never appeared`);
}

test("the relay carries subagent routing requests on its own socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-routing-"));
  const pipe = join(root, "bridge.sock");
  const transport = new BridgeTransport("session-file", pipe);
  const identity = {
    agentId: "agent",
    sessionId: "session",
    runtimeEpoch: transport.operatorEpoch,
    serviceEpoch: "service",
    capability: transport.subagentRoutingCapability,
  };
  const received: any[] = [];
  transport.bind({
    command: async () => {},
    attached() {},
    detached() {},
    error() {},
    subagentRoutingIdentity: () => identity,
    subagentRouting: async (request) => {
      received.push(request);
      return { ok: true };
    },
  });
  transport.start();

  const descriptor = {
    version: 1 as const,
    socketPath: subagentRoutingSocketPath(pipe),
    ...identity,
  };
  type Request = Record<string, unknown>;
  const call = (request: Request, capability = identity.capability) =>
    callBtw({ ...descriptor, capability }, request, 2_000, "subagent_routing");
  const scoped = { sessionId: "session", serviceEpoch: "service" };

  try {
    await waitForSocket(descriptor.socketPath);

    // The descriptor lands where Paseo's existing reader finds it.
    writeSubagentRoutingDescriptor(root, descriptor);
    const read = await readAccountControlsDescriptor("agent", join(root, "subagents"));
    assert.ok(validateAccountControlsDescriptor(read, "agent"));

    for (const operation of ["snapshot", "providers", "set"]) {
      assert.deepEqual(await call({ operation, ...scoped }), { ok: true });
    }
    assert.deepEqual(received.map((request) => request.operation), ["snapshot", "providers", "set"]);

    // Unknown operations, wrong sessions and wrong capabilities never reach Pi.
    await assert.rejects(call({ operation: "start", ...scoped }));
    await assert.rejects(call({ operation: "snapshot", ...scoped, sessionId: "other" }));
    await assert.rejects(call({ operation: "snapshot", ...scoped }, "b".repeat(64)));
    assert.equal(received.length, 3);
  } finally {
    transport.close();
    await rm(root, { recursive: true, force: true });
  }
});
