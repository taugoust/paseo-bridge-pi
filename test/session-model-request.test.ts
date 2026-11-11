import { test } from "node:test";
import assert from "node:assert/strict";
import { completeWithSessionModel } from "../extension/session-model-request.ts";
const global = globalThis as any;
function api(t: any, value: any) {
  const previous = global.__paeSessionRoutingV1;
  if (value === undefined) delete global.__paeSessionRoutingV1;
  else global.__paeSessionRoutingV1 = { bindModelRequest: (model: any) => model, ...value };
  t.after(() => { if (previous === undefined) delete global.__paeSessionRoutingV1; else global.__paeSessionRoutingV1 = previous; });
}

test("title requests use registry dispatch instead of bypassing selected-account gates", async t => {
  api(t, undefined);
  const model = { provider: "openai", id: "main" }, calls: any[] = [];
  const ctx = { model, modelRegistry: { find: () => model, streamSimple: (...args: any[]) => { calls.push(args); return { result: async () => ({ content: "title" }) }; } } };
  assert.deepEqual(await completeWithSessionModel(ctx, { messages: [] }, { maxTokens: 1024 }), { content: "title" });
  assert.equal(calls[0][0], model);
  assert.deepEqual(calls[0][2], { maxTokens: 1024 });
});

test("guarded title requests use the captured profile and later ones follow switches", async t => {
  let profile = { providerId: "openai-codex", accountId: "Personal" };
  const references: any[] = [], calls: any[] = [];
  let finish: (value: any) => void = () => {};
  api(t, { protocol: 1, prepareRequest: async () => ({ ...profile }), physicalModelReference: (_ctx: any, captured: any) => { references.push(captured); return { provider: captured.providerId, id: "main" }; } });
  const ctx = { model: { provider: "idle-guard", id: "alias", api: "pi-virtual" }, modelRegistry: {
    find: (provider: string, id: string) => ({ provider, id }),
    streamSimple: (model: any) => { calls.push(model); return { result: () => calls.length === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ content: "second" }) }; },
  } };
  const pending = completeWithSessionModel(ctx, {});
  await new Promise(resolve => setImmediate(resolve));
  profile = { providerId: "openai-codex", accountId: "Work" };
  finish({ content: "first" });
  await pending;
  await completeWithSessionModel(ctx, {});
  assert.deepEqual(calls.map(model => model.provider), ["openai-codex", "openai-codex"]);
  assert.deepEqual(references.map(value => value.accountId), ["Personal", "Work"]);
});

test("missing routing/model rejects rather than falling back to the original model", async t => {
  let calls = 0;
  api(t, { protocol: 1, prepareRequest: async () => { throw new Error("profile unavailable"); }, physicalModelReference: () => ({ provider: "openai-codex", id: "missing" }) });
  const ctx = { model: { provider: "openai", id: "old" }, modelRegistry: { find: () => undefined, streamSimple: () => { calls++; return { result: async () => ({}) }; } } };
  await assert.rejects(completeWithSessionModel(ctx, {}), /profile unavailable/);
  global.__paeSessionRoutingV1.prepareRequest = async () => ({});
  await assert.rejects(completeWithSessionModel(ctx, {}), /Unavailable session model/);
  assert.equal(calls, 0);
});
