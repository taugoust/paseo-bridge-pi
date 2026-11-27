import assert from "node:assert/strict";
import test from "node:test";
import {
  availableProviders,
  runSubagentRouting,
  subagentRoutingService,
} from "../extension/subagent-routing.ts";

const globals = globalThis as Record<string, any>;

function fakeService() {
  const calls: unknown[] = [];
  const service = {
    protocol: 1,
    sessionId: "session",
    serviceEpoch: "epoch",
    async getSnapshot(request: unknown) {
      calls.push(["snapshot", request]);
      return { selection: null };
    },
    async set(request: unknown) {
      calls.push(["set", request]);
      return { selection: (request as any).selection };
    },
  };
  return { service, calls };
}

const ctx = {
  modelRegistry: {
    getAvailable: () => [
      { provider: "zeta", api: "physical" },
      { provider: "alpha", api: "physical" },
      { provider: "zeta", api: "physical" },
      { provider: "virtual", api: "pi-virtual" },
    ],
  },
};

test("the service is only used for its own session and protocol", () => {
  const { service } = fakeService();
  try {
    assert.equal(subagentRoutingService("session"), undefined);
    globals.__paeSubagentRoutingV1 = service;
    assert.equal(subagentRoutingService("session"), service);
    assert.equal(subagentRoutingService("other"), undefined);
    assert.equal(subagentRoutingService(undefined), undefined);
    globals.__paeSubagentRoutingV1 = { ...service, protocol: 2 };
    assert.equal(subagentRoutingService("session"), undefined);
  } finally {
    delete globals.__paeSubagentRoutingV1;
  }
});

test("providers are the available physical ones, each once and sorted", () => {
  assert.deepEqual(availableProviders(ctx), ["alpha", "zeta"]);
});

test("requests map onto the service", async () => {
  const { service, calls } = fakeService();
  const identity = { sessionId: "session", serviceEpoch: "epoch" };
  const selection = { providerId: "openai-codex", accountId: null };

  await runSubagentRouting(service as any, ctx, { operation: "snapshot", ...identity });
  const providers = await runSubagentRouting(service as any, ctx, {
    operation: "providers",
    ...identity,
  });
  await runSubagentRouting(service as any, ctx, {
    operation: "set",
    ...identity,
    expectedRevision: 3,
    selection,
  });

  assert.deepEqual(providers, ["alpha", "zeta"]);
  assert.deepEqual(calls, [
    ["snapshot", { sessionId: "session" }],
    ["set", {
      expectedSessionId: "session",
      expectedServiceEpoch: "epoch",
      expectedRevision: 3,
      selection,
    }],
  ]);
  await assert.rejects(runSubagentRouting(service as any, ctx, { operation: "other" } as any));
});
