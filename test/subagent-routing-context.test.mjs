import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("subagent-routing callback delegates snapshot/set and rejects missing or stale service identity", async () => {
  const source = readFileSync(new URL("../extension/index.ts", import.meta.url), "utf8");
  function declaration(name, startAt = 0) {
    const start = source.indexOf(`function ${name}(`, startAt);
    assert.notEqual(start, -1, `missing ${name}`);
    const brace = source.indexOf("{", start), end = blockEnd(source, brace);
    return source.slice(start, end + 1).replace("(globalThis as Record<string, any>)", "globalThis").replaceAll("(globalThis as any)", "globalThis").replaceAll(" as const", "");
  }
  function blockEnd(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) return i;
    }
    throw new Error("unterminated source block");
  }
  function methodBody(name, endName) {
    const start = source.indexOf(`async ${name}(request: any) {`);
    const marker = source.indexOf(`${endName}() {`, start);
    assert.ok(start >= 0 && marker > start, `missing ${name} callback`);
    const open = source.indexOf("{", start), end = blockEnd(source, open);
    return source.slice(open + 1, end).replaceAll(": unknown", "").replaceAll(": any", "").replaceAll("(globalThis as any)", "globalThis");
  }

  const makeSvcFn = new Function("latestCtx", `${declaration("activeSubagentRoutingService")}; return activeSubagentRoutingService;`);
  const descriptorFn = new Function("transport", "latestCtx", "currentAgentId", "currentSessionFile", "activeSubagentRoutingService", "subagentRoutingSocketPath",
    `${declaration("activeSubagentRoutingDescriptor")}; return activeSubagentRoutingDescriptor;`);
  const callbackBody = methodBody("subagentRouting", "foregroundTasksIdentity");
  const callbackFn = new Function("transport", "latestCtx", "currentAgentId", "currentSessionFile", "activeSubagentRoutingService", "activeSubagentRoutingDescriptor",
    `return async function(request) {${callbackBody}}`);

  const calls = [];
  const staleSelection = new Error();
  const service = {
    protocol: 1, sessionId: "session", serviceEpoch: "service-1",
    async getSnapshot(request) { calls.push(["snapshot", request]); return { protocol: 1, sessionId: "session", serviceEpoch: "service-1", revision: 2, selection: null }; },
    async set(request) {
      calls.push(["set", request]);
      if (request.expectedRevision === 999) throw staleSelection;
      return { protocol: 1, sessionId: "session", serviceEpoch: "service-1", revision: 3, selection: request.selection };
    },
  };
  globalThis.__paeSubagentRoutingV1 = service;
  const latestCtx = {
    sessionManager: { getSessionId: () => "session" },
    modelRegistry: { getAll: () => [
      { provider: "zeta", api: "physical" }, { provider: "alpha", api: "physical" },
      { provider: "zeta", api: "physical" }, { provider: "virtual", api: "pi-virtual" },
    ] },
  };
  const svcFn = makeSvcFn(latestCtx);
  const transport = { connected: true, sessionFile: "file", pipePath: "/tmp/bridge", operatorEpoch: "runtime" };
  const activeService = () => svcFn(latestCtx);
  const makeDescriptor = descriptorFn(transport, latestCtx, "agent", "file", activeService, socket => `${socket}.subagent-routing`);
  const activeDescriptor = () => makeDescriptor();
  const callback = callbackFn(transport, latestCtx, "agent", "file", activeService, activeDescriptor);
  try {
    assert.deepEqual(await callback({ operation: "snapshot", sessionId: "session" }), {
      protocol: 1, sessionId: "session", serviceEpoch: "service-1", revision: 2, selection: null,
    });
    const setRequest = { expectedSessionId: "session", expectedServiceEpoch: "service-1", expectedRevision: 2, selection: { providerId: "vendor", accountId: null } };
    assert.deepEqual(await callback({ operation: "set", request: setRequest }), {
      protocol: 1, sessionId: "session", serviceEpoch: "service-1", revision: 3, selection: setRequest.selection,
    });
    assert.deepEqual(await callback({ operation: "providers", sessionId: "session" }), ["alpha", "zeta"]);
    await assert.rejects(callback({ operation: "set", request: { ...setRequest, expectedRevision: 999 } }), error => error === staleSelection);
    assert.deepEqual(calls, [["snapshot", { sessionId: "session" }], ["set", setRequest], ["set", { ...setRequest, expectedRevision: 999 }]]);

    assert.equal(activeService(), service);
    delete globalThis.__paeSubagentRoutingV1;
    assert.equal(activeService(), undefined);
    await assert.rejects(callback({ operation: "snapshot", sessionId: "session" }));
    globalThis.__paeSubagentRoutingV1 = service;
    await assert.rejects(callback({ operation: "set", request: { ...setRequest, expectedServiceEpoch: "old-epoch" } }));
    assert.equal(calls.length, 3, "stale service epoch must not reach the service");

    service.getSnapshot = async request => {
      calls.push(["snapshot-replaced", request]);
      globalThis.__paeSubagentRoutingV1 = { ...service, serviceEpoch: "replacement" };
      return { protocol: 1, sessionId: "session", serviceEpoch: "service-1", revision: 2, selection: null };
    };
    await assert.rejects(callback({ operation: "snapshot", sessionId: "session" }));
  } finally { delete globalThis.__paeSubagentRoutingV1; }
});
