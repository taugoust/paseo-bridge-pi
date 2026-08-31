import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectAgentArchived,
  parseAgentArchived,
  reconcileForkArchive,
} from "../shim/fork-lifecycle.js";

test("parseAgentArchived recognizes Paseo inspect output", () => {
  assert.equal(parseAgentArchived(JSON.stringify({ Id: "agent-1", Archived: true })), true);
  assert.equal(parseAgentArchived(JSON.stringify({ Id: "agent-1", Archived: false })), false);
  assert.equal(parseAgentArchived("not json"), null);
});

test("inspectAgentArchived fails open across daemon downtime", async () => {
  const execFile = (_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    callback(new Error("daemon unavailable"), "");
  };
  assert.equal(await inspectAgentArchived("agent-1", { execFile }), null);
});

test("reconcileForkArchive kills only an archived owned fork pane", async () => {
  const record = { agentId: "agent-1", forkCreated: true, tmuxPane: "%9" };
  let killed = false;
  assert.equal(await reconcileForkArchive("agent-1", {
    findRuntimeRecord: () => record,
    inspectArchived: async () => true,
    killForkPane: (_agentId: string, options: { runtimeRecord: unknown }) => {
      assert.equal(options.runtimeRecord, record);
      killed = true;
      return true;
    },
  }), "killed");
  assert.equal(killed, true);
});

test("reconcileForkArchive preserves active forks and ordinary sessions", async () => {
  assert.equal(await reconcileForkArchive("agent-1", {
    findRuntimeRecord: () => null,
    inspectArchived: async () => true,
  }), "not-fork");
  assert.equal(await reconcileForkArchive("agent-1", {
    findRuntimeRecord: () => ({ agentId: "agent-1", forkCreated: true }),
    inspectArchived: async () => false,
  }), "active");
  assert.equal(await reconcileForkArchive("agent-1", {
    findRuntimeRecord: () => ({ agentId: "agent-1", forkCreated: true }),
    inspectArchived: async () => null,
  }), "unavailable");
});
