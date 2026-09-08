import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { importRetryDelay, paseoImportArgs, retryableWorkspaceImportFailure, workspaceIdForPlacement } from "../extension/import-placement.ts";

const placement = { tmuxSocket: "/run/user/1000/tmux.sock", tmuxServerId: "12:345:678", tmuxWindowId: "@9" };
test("topology import passes the server deterministic workspace from actual placement", () => {
  const expected = "wks_tmux_" + createHash("sha256").update(JSON.stringify([placement.tmuxSocket, placement.tmuxServerId, placement.tmuxWindowId])).digest("hex").slice(0, 24);
  assert.equal(workspaceIdForPlacement(placement), expected);
  assert.deepEqual(paseoImportArgs({ sessionFile: "/session.jsonl", cwd: "/repo", host: "host", topology: true, placement }),
    ["import", "--provider", "pi", "/session.jsonl", "--cwd", "/repo", "--json", "--workspace-id", expected, "--host", "host"]);
  assert.notEqual(workspaceIdForPlacement({ ...placement, tmuxWindowId: "@10" }), expected);
  assert.notEqual(workspaceIdForPlacement({ ...placement, tmuxServerId: "12:999:678" }), expected);
});
test("non-topology imports preserve legacy arguments; missing live topology fails closed", () => {
  assert.deepEqual(paseoImportArgs({ sessionFile: "/s", cwd: "/c", topology: false, placement: {} }), ["import", "--provider", "pi", "/s", "--cwd", "/c", "--json"]);
  assert.throws(() => paseoImportArgs({ sessionFile: "/s", cwd: "/c", topology: true, placement: {} }), /Current tmux workspace identity is unavailable/);
});
test("workspace projection rejection retries are bounded; ambiguous outcomes do not retry", () => {
  assert.equal(retryableWorkspaceImportFailure(1, "Workspace wks_tmux_abc not found"), true);
  assert.equal(retryableWorkspaceImportFailure(1, "Unknown requested workspace"), true);
  assert.equal(retryableWorkspaceImportFailure(0, "workspace malformed response"), false);
  assert.equal(retryableWorkspaceImportFailure(null, "workspace timed out"), false);
  assert.equal(retryableWorkspaceImportFailure(1, "network connection lost"), false);
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(importRetryDelay), [2000, 4000, 8000, 16000, 30000, undefined]);
});
