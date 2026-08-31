import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTuiArgs,
  buildTuiShellCommand,
  findSourcePane,
  forkStartupTimeoutMs,
  isPaseoGeneratedIntegrationExtension,
  killForkPaneForAgent,
  launchForkTui,
  parseTmuxPanes,
  selectForkTuiBin,
} from "../shim/tmux-fork.js";

test("forkStartupTimeoutMs allows slow supervised startup but remains bounded", () => {
  assert.equal(forkStartupTimeoutMs(undefined), 120_000);
  assert.equal(forkStartupTimeoutMs("45000"), 45_000);
  assert.throws(() => forkStartupTimeoutMs("999"), /between 1000 and 600000/);
  assert.throws(() => forkStartupTimeoutMs("600001"), /between 1000 and 600000/);
  assert.throws(() => forkStartupTimeoutMs("not-a-number"), /between 1000 and 600000/);
});

test("buildTuiArgs replaces RPC state and removes only Paseo's generated integration", () => {
  assert.equal(
    isPaseoGeneratedIntegrationExtension("/tmp/paseo-pi-extension-zj87Qg/paseo-integration.mjs"),
    true,
  );
  assert.equal(isPaseoGeneratedIntegrationExtension("/tmp/custom/paseo-integration.mjs"), false);
  assert.deepEqual(
    buildTuiArgs([
      "--mode", "rpc", "--model", "openai/gpt", "--thinking=high",
      "--session=/old.jsonl",
      "--extension", "/tmp/paseo-pi-extension-zj87Qg/paseo-integration.mjs",
      "--extension", "/tmp/paseo.ts",
      "--extension=/tmp/paseo-pi-extension-other/paseo-integration.mjs",
      "--no-session",
    ], "/new.jsonl"),
    ["--model", "openai/gpt", "--thinking=high", "--extension", "/tmp/paseo.ts", "--session", "/new.jsonl"],
  );
});

test("buildTuiShellCommand quotes fixed environment and arguments", () => {
  assert.equal(
    buildTuiShellCommand({
      agentId: "agent-1",
      socketPath: "/run/user/1000/pi-paseo/agent-1.sock",
      tuiBin: "/run/current system/pi",
      tuiArgs: ["--session", "/tmp/it's.jsonl"],
    }),
    "env PI_PASEO_EXISTING_AGENT_ID='agent-1' PI_PASEO_AGENT_SOCKET='/run/user/1000/pi-paseo/agent-1.sock' PI_PASEO_BRIDGE_NO_IMPORT='1' '/run/current system/pi' '--session' '/tmp/it'\\''s.jsonl'",
  );
});

test("parseTmuxPanes ignores panes without a marked Pi process", () => {
  assert.deepEqual(
    parseTmuxPanes("work\t@1\t%2\t123\nwork\t@1\t%3\t\n"),
    [{ sessionName: "work", windowId: "@1", paneId: "%2", agentPid: 123 }],
  );
});

test("findSourcePane validates the session runtime record against tmux", () => {
  const spawnSync = () => ({ status: 0, stdout: "work\t@2\t%3\t456\n", stderr: "" });
  assert.deepEqual(
    findSourcePane("/sessions/source.jsonl", {
      spawnSync,
      runtimeRecord: { sessionFile: "/sessions/source.jsonl", tmuxPane: "%3", pid: 456, tuiKind: "unsafe" },
    }),
    { sessionName: "work", windowId: "@2", paneId: "%3", agentPid: 456, socketPath: null, tuiKind: "unsafe" },
  );
});

test("findSourcePane uses the source tmux server socket", () => {
  const calls: string[][] = [];
  const spawnSync = (_command: string, args: string[]) => {
    calls.push(args);
    return { status: 0, stdout: "work\t@2\t%3\t456\n", stderr: "" };
  };
  const pane = findSourcePane("/sessions/source.jsonl", {
    spawnSync,
    runtimeRecord: { sessionFile: "/sessions/source.jsonl", tmuxPane: "%3", tmuxSocket: "/run/user/1000/tmux/default", pid: 456, tuiKind: "supervised" },
  });
  assert.deepEqual(calls[0].slice(0, 2), ["-S", "/run/user/1000/tmux/default"]);
  assert.equal(pane.socketPath, "/run/user/1000/tmux/default");
});

test("findSourcePane rejects a stale runtime record", () => {
  const spawnSync = () => ({ status: 0, stdout: "work\t@2\t%3\t999\n", stderr: "" });
  assert.throws(
    () => findSourcePane("/sessions/source.jsonl", {
      spawnSync,
      runtimeRecord: { sessionFile: "/sessions/source.jsonl", tmuxPane: "%3", pid: 456, tuiKind: "supervised" },
    }),
    /stale/,
  );
});

test("findSourcePane rejects records written before trust-mode propagation", () => {
  const spawnSync = () => ({ status: 0, stdout: "work\t@2\t%3\t456\n", stderr: "" });
  assert.throws(
    () => findSourcePane("/sessions/source.jsonl", {
      spawnSync,
      runtimeRecord: { sessionFile: "/sessions/source.jsonl", tmuxPane: "%3", pid: 456 },
    }),
    /reload the source session/,
  );
});

test("selectForkTuiBin preserves the source session trust mode", () => {
  const launchers = { supervised: "/bin/pi", unsafe: "/bin/pi-unsafe" };
  assert.equal(selectForkTuiBin({ tuiKind: "supervised" }, launchers), "/bin/pi");
  assert.equal(selectForkTuiBin({ tuiKind: "unsafe" }, launchers), "/bin/pi-unsafe");
  assert.throws(
    () => selectForkTuiBin({ tuiKind: "unsafe" }, { supervised: "/bin/pi" }),
    /no unsafe Pi TUI launcher/,
  );
});

test("killForkPaneForAgent validates fork ownership and the live Pi marker", () => {
  const calls: string[][] = [];
  const spawnSync = (_command: string, args: string[]) => {
    calls.push(args);
    if (args.includes("display-message")) return { status: 0, stdout: "work\t@2\t%9\t456\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.equal(killForkPaneForAgent("agent-1", {
    spawnSync,
    runtimeRecord: {
      agentId: "agent-1",
      forkCreated: true,
      sessionFile: "/sessions/fork.jsonl",
      tmuxPane: "%9",
      pid: 456,
      tuiKind: "unsafe",
    },
  }), true);
  assert.equal(calls.some((args) => args.includes("kill-pane") && args.includes("%9")), true);
  assert.equal(killForkPaneForAgent("agent-1", {
    spawnSync,
    runtimeRecord: { agentId: "agent-1", forkCreated: false, tmuxPane: "%9" },
  }), false);
});

test("launchForkTui maps same workspaces to a split in the source window", () => {
  const calls: unknown[][] = [];
  const spawnSync = (command: string, args: string[]) => {
    calls.push([command, args]);
    return { status: 0, stdout: "%9\n", stderr: "" };
  };
  const result = launchForkTui({
    placement: "pane",
    sourcePane: { sessionName: "work", windowId: "@2", paneId: "%3", agentPid: 456 },
    sourceSessionFile: "/sessions/source.jsonl",
    forkSessionFile: "/sessions/fork.jsonl",
    cwd: "/repo",
    agentId: "target",
    socketPath: "/tmp/nonexistent-parent-test/agent.sock",
    tuiBin: "/bin/pi",
    rpcArgs: ["--mode", "rpc"],
  }, { spawnSync });
  assert.equal(result.paneId, "%9");
  const args = calls[0][1] as string[];
  assert.deepEqual(args.slice(0, 10), ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", "@2", "-c", "/repo", args[9]]);
  assert.match(args[9], /--session.*fork\.jsonl/);
});

test("launchForkTui maps new workspaces to a new window in the source session", () => {
  const calls: unknown[][] = [];
  const spawnSync = (command: string, args: string[]) => {
    calls.push([command, args]);
    return { status: 0, stdout: "%10\n", stderr: "" };
  };
  launchForkTui({
    placement: "window",
    sourcePane: { sessionName: "work", windowId: "@2", paneId: "%3", agentPid: 456 },
    sourceSessionFile: "/sessions/source.jsonl",
    forkSessionFile: "/sessions/fork.jsonl",
    cwd: "/repo",
    agentId: "target",
    socketPath: "/tmp/nonexistent-parent-test-2/agent.sock",
    tuiBin: "/bin/pi",
    rpcArgs: ["--mode=rpc"],
  }, { spawnSync });
  const args = calls[0][1] as string[];
  assert.equal(args[0], "new-window");
  assert.equal(args[6], "work:");
});
