import assert from "node:assert/strict";
import test from "node:test";
import { parseTmuxTarget, tmuxServerIdentity, validateTmuxTarget } from "../shim/tmux-target.js";
import { launchForkTui } from "../shim/tmux-fork.js";
const target = { version: 1, tmuxSocket: "/tmp/tmux-target-test.sock", tmuxServerId: "42:123:456", tmuxSessionId: "$1", tmuxWindowId: "@2", projectId: "project", workspaceId: "workspace" };
test("placement requires explicit versioned stable IDs", () => {
  assert.deepEqual(parseTmuxTarget(JSON.stringify(target)), target);
  for (const patch of [{ version: 2 }, { tmuxSocket: "relative" }, { tmuxSessionId: "name" }, { tmuxWindowId: "window" }, { workspaceId: "" }]) {
    assert.throws(() => parseTmuxTarget(JSON.stringify({ ...target, ...patch })), /Invalid/);
  }
  assert.throws(() => parseTmuxTarget(""));
});
test("placement checks server incarnation and target window membership", () => {
  const options = { spawnSync: () => ({ status: 0, stdout: "42\t$1\t@2\n42\t$1\t@3\n" }), serverIdentity: () => "42:123:456" };
  assert.equal(validateTmuxTarget(target, options), target);
  assert.throws(() => validateTmuxTarget(target, { ...options, serverIdentity: () => "42:999:456" }), /incarnation/);
  assert.throws(() => validateTmuxTarget({ ...target, tmuxWindowId: "@4" }, options), /belong/);
  assert.throws(() => validateTmuxTarget(target, { ...options, spawnSync: () => ({ status: 1 }) }), /unavailable/);
});
test("server identity handles process names containing parentheses", () => {
  const fields = Array.from({ length: 20 }, () => "0"); fields[19] = "123";
  assert.equal(tmuxServerIdentity(42, target.tmuxSocket, { readFileSync: () => `42 (tmux (server)) ${fields.join(" ")}`,
    statSync: () => ({ ino: 456, isSocket: () => true }) }), target.tmuxServerId);
});
test("root and fork allocation obey target rather than source window or cwd", () => {
  const calls: any[] = [];
  const launched = launchForkTui({ target, agentId: "test-topology-agent", forkSessionFile: "/tmp/test-topology-session.jsonl",
    sourcePane: { socketPath: "/wrong", sessionName: "wrong", windowId: "@99", tuiKind: "unsafe" },
    placement: "window", cwd: "/work", tuiBin: "/trusted/pi-unsafe", rpcArgs: ["--mode", "rpc"], forkCreated: false,
    socketPath: "/tmp/test-topology-unused.sock" }, {
    serverIdentity: () => target.tmuxServerId,
    spawnSync(command, args) {
      calls.push([command, args]);
      return args.includes("list-windows") ? { status: 0, stdout: "42\t$1\t@2\n" } : { status: 0, stdout: "%8\n" };
    },
  });
  const args = calls[1][1];
  assert.deepEqual(args.slice(0, 3), ["-S", target.tmuxSocket, "split-window"]);
  assert.equal(args[args.indexOf("-t") + 1], "$1:@2");
  assert.match(args.at(-1), /PI_PASEO_FORK_CREATED='0'/);
  assert.match(args.at(-1), /PI_PASEO_TMUX_TARGET=/);
  assert.equal(launched.tmuxSocket, target.tmuxSocket);
  assert.deepEqual(calls[2], ["tmux", ["-S", target.tmuxSocket, "select-layout", "-t", "%8", "tiled"]]);
});
