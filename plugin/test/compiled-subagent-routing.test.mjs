import assert from "node:assert/strict";
import test, { after } from "node:test";
import { cp, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const compiler = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compiler, "PASEO_PLUGIN_COMPILER is required");
const require = createRequire(resolve(compiler));
const root = await mkdtemp(resolve(tmpdir(), "subagent-routing-"));
after(() => rm(root, { recursive: true, force: true }));
for (const dir of ["server", "shared"]) await cp(fileURLToPath(new URL(`../${dir}`, import.meta.url)), resolve(root, dir), { recursive: true });
await writeFile(resolve(root, "index.server.ts"), 'export { createSubagentRoutingHandlers } from "./server/subagent-routing"; import { subagentRoutingSetRpc } from "./shared/subagent-routing"; export function setRpc() { return subagentRoutingSetRpc; }');
const { compilePlugin } = await import(pathToFileURL(resolve(compiler)));
const { serverBundle } = await compilePlugin({ server: resolve(root, "index.server.ts") });
const load = name => name === "@getpaseo/plugin" ? { defineRpc: x => x } : require(name);
const { createSubagentRoutingHandlers, setRpc } = (0, eval)(serverBundle)(load);
const runtimeEpoch = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const target = { agentId: "agent", workspaceId: "workspace" };
const descriptor = { version: 1, socketPath: "/tmp/subagents.sock", capability: "a".repeat(64), ...target, sessionId: "session", runtimeEpoch, serviceEpoch: "service" };
delete descriptor.workspaceId;
const snapshot = (selection = null, revision = 1) => ({ protocol: 1, sessionId: "session", serviceEpoch: "service", revision, selection });
const context = { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: { id: "agent", workspaceId: "workspace", provider: "pi" } }) }) } } };
const input = selection => ({ ...target, expectedRuntimeEpoch: runtimeEpoch, request: { expectedSessionId: "session", expectedServiceEpoch: "service", expectedRevision: 1, selection } });

test("routing server forwards snapshots, catalogue, named account selection and clear", async () => {
  const calls = [];
  const handlers = createSubagentRoutingHandlers(async () => ({ ...descriptor }), async (_d, request) => {
    calls.push(request);
    return request.operation === "providers" ? ["claude-bridge", "openai-codex"] : snapshot(request.request?.selection ?? null);
  });
  const result = await handlers.status(target, context);
  assert.equal(result.available, true);
  assert.deepEqual(result.providers, ["claude-bridge", "openai-codex"]);
  assert.equal(result.snapshot.selection, null);
  const selection = { providerId: "openai-codex", accountId: "work" };
  assert.deepEqual((await handlers.set(input(selection), context)).selection, selection);
  assert.equal((await handlers.set(input(null), context)).selection, null);
  assert.deepEqual(calls.map(c => c.operation), ["snapshot", "providers", "set", "set"]);
  assert.deepEqual(calls[2].request, input(selection).request);
});

test("routing RPC permits named accounts only for Codex and rejects unbounded or unknown fields", () => {
  const schema = setRpc().input;
  assert.equal(schema.safeParse(input({ providerId: "openai-codex", accountId: "work" })).success, true);
  assert.equal(schema.safeParse(input({ providerId: "claude-bridge", accountId: null })).success, true);
  assert.equal(schema.safeParse(input({ providerId: "claude-bridge", accountId: "work" })).success, false);
  assert.equal(schema.safeParse(input({ providerId: "x".repeat(257), accountId: null })).success, false);
  assert.equal(schema.safeParse(input({ providerId: "openai-codex", accountId: null, secret: "unexpected" })).success, false);
  assert.equal(schema.safeParse({ ...input(null), request: { ...input(null).request, expectedRevision: -1 } }).success, false);
});

test("routing server rejects stale sessions, epochs, substituted workspaces and services changing during a request", async () => {
  let calls = 0;
  const handlers = createSubagentRoutingHandlers(async () => ({ ...descriptor }), async () => { calls++; return snapshot(); });
  for (const changed of [{ workspaceId: "sibling" }, { agentId: "sibling" }, { expectedRuntimeEpoch: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb" }, { request: { ...input(null).request, expectedServiceEpoch: "reloaded" } }, { request: { ...input(null).request, expectedSessionId: "other" } }])
    await assert.rejects(handlers.set({ ...input(null), ...changed }, context));
  assert.equal(calls, 0);
  let active = descriptor;
  const changing = createSubagentRoutingHandlers(async () => active, async () => { active = { ...descriptor, serviceEpoch: "new" }; return snapshot(); });
  await assert.rejects(changing.set(input(null), context));
  const stale = createSubagentRoutingHandlers(async () => descriptor, async () => { throw Error("stale-selection"); });
  await assert.rejects(stale.set(input(null), context));
  const missing = createSubagentRoutingHandlers(async () => undefined);
  assert.equal((await missing.status(target, context)).available, false);
});
