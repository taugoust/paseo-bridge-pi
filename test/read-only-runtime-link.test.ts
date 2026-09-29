import test from "node:test";
import assert from "node:assert/strict";
import { resolvePaseoChildRuntimeLink } from "../extension/read-only-runtime-link.ts";

const identity = { taskId: `subagent-task-${"1".repeat(24)}`, childId: `subagent-child-${"2".repeat(24)}`,
  groupId: `subagent-job-${"3".repeat(24)}`, runtimeId: "runtime-exact", attempt: 2 };
const record = { lifecycle: "active", managed: true, parentSessionId: "parent-session", ...identity,
  attempt: "2", pid: 123, processStartToken: "boot:456", agentId: "paseo-child", workspaceId: "workspace" };
const token = (pid: number) => pid === 123 ? "boot:456" : null;

test("child navigation link requires exact identities and a live process token", () => {
  assert.deepEqual(resolvePaseoChildRuntimeLink("parent-session", identity, [record], token), {
    available: true, agentId: "paseo-child", workspaceId: "workspace", reason: null,
  });
  assert.equal(resolvePaseoChildRuntimeLink("other-session", identity, [record], token).available, false);
  assert.equal(resolvePaseoChildRuntimeLink("parent-session", { ...identity, attempt: 1 }, [record], token).available, false);
  for (const lifecycle of ["reaped", "reaping", "unknown", undefined]) {
    assert.equal(resolvePaseoChildRuntimeLink("parent-session", identity, [{ ...record, lifecycle }], token).available, false);
  }
  assert.equal(resolvePaseoChildRuntimeLink("parent-session", identity, [record], () => "boot:reused-pid").available, false);
});

test("ambiguous exact live runtime matches never select a guessed Paseo agent", () => {
  const result = resolvePaseoChildRuntimeLink("parent-session", identity, [record, { ...record, agentId: "other" }], token);
  assert.deepEqual(result, { available: false, agentId: null, workspaceId: null, reason: "Child runtime identity is ambiguous." });
});
