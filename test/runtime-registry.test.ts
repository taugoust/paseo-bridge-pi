import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertNoLiveRuntimeOwner, claimRuntimeLaunch, harnessRuntimeMetadata, markPaseoAgentPane, clearPaseoAgentPane, validRuntimeReapingEvent, assertRuntimeNotReaped, matchingRuntimeRecords, processStartToken, resolveTmuxIdentity, runtimeOwnerMayBeAlive } from "../shim/runtime-registry.js";
import { killForkPaneForAgent } from "../shim/tmux-fork.js";

const record = { sessionFile: "/project/session.jsonl", agentId: "agent", pid: 123, processStartToken: "boot:1" };
test("live owner blocks fallback; missing/reused process permits it", () => {
  const live = { records: [record], kill() {}, processStartToken: () => "boot:1" };
  assert.throws(() => assertNoLiveRuntimeOwner(record.sessionFile, live), /Refusing to launch a second Pi/);
  assert.doesNotThrow(() => assertNoLiveRuntimeOwner(record.sessionFile, { ...live, ignorePid: 123 }));
  assert.doesNotThrow(() => assertNoLiveRuntimeOwner(record.sessionFile, { ...live, processStartToken: () => "boot:2" }));
  assert.doesNotThrow(() => assertNoLiveRuntimeOwner(record.sessionFile, { ...live, kill() { throw Object.assign(new Error(), { code: "ESRCH" }); } }));
});
test("unknown identity and permission failure are conservative", () => {
  assert.equal(runtimeOwnerMayBeAlive(record, { kill() { throw Object.assign(new Error(), { code: "EPERM" }); } }), true);
  assert.equal(runtimeOwnerMayBeAlive({ pid: 0 }), true);
  assert.equal(runtimeOwnerMayBeAlive(record, { kill() {}, processStartToken: () => null }), true);
  assert.equal(runtimeOwnerMayBeAlive({ pid: 123 }, { kill() {}, processStartToken: () => "new" }), true);
});
test("discovery matches agent alias or canonical path", () => {
  assert.deepEqual(matchingRuntimeRecords("/project/./session.jsonl", null, [record]), [record]);
  assert.deepEqual(matchingRuntimeRecords("/different", "agent", [record]), [record]);
  assert.deepEqual(matchingRuntimeRecords("/different", "other", [record]), []);
});
test("harness metadata explicitly allowlists non-secret fields", () => {
  const metadata = harnessRuntimeMetadata({ PI_HARNESS_RUNTIME_ID: "runtime", PI_HARNESS_TASK_ID: "task", PI_HARNESS_CONTROL_TOKEN: "secret" });
  assert.equal(metadata.managed, true);
  assert.equal(metadata.taskId, "task");
  assert.equal(JSON.stringify(metadata).includes("secret"), false);
  assert.equal(harnessRuntimeMetadata({}).managed, false);
});
test("tmux identity uses stable IDs on the explicitly inherited server", () => {
  const env = { TMUX: "/tmp/server,12,0", TMUX_PANE: "%8" };
  const result = resolveTmuxIdentity(env, (command, args) => {
    assert.equal(command, "tmux");
    assert.deepEqual(args.slice(0, 6), ["-S", "/tmp/server", "display-message", "-p", "-t", "%8"]);
    return { status: 0, stdout: "$2\t@3\t%8\n" };
  }, value => value);
  assert.deepEqual(result, { tmuxSocket: "/tmp/server", tmuxSessionId: "$2", tmuxWindowId: "@3", tmuxPane: "%8" });
  assert.deepEqual(resolveTmuxIdentity(env, () => ({ status: 0, stdout: "$2\t@3\t%9" }), value => value), {});
  assert.deepEqual(resolveTmuxIdentity({}), {});
  assert.equal(resolveTmuxIdentity(env, () => ({ status: 0, stdout: "$2\t@3\t%8\t1\n" }), value => value).infrastructure, true);
});
test("actual pane resolution canonicalizes socket aliases and agent tags use that server", () => {
  const placement = resolveTmuxIdentity({ TMUX: "/alias,1,0", TMUX_PANE: "%5" }, (_command, args) => {
    assert.equal(args[1], "/canonical");
    return { status: 0, stdout: "$1\t@2\t%5\n" };
  }, () => "/canonical");
  assert.equal(placement.tmuxSocket, "/canonical");
  assert.equal(markPaseoAgentPane(placement, "agent", (_command, args) => {
    assert.deepEqual(args, ["-S", "/canonical", "set-option", "-p", "-t", "%5", "@paseo_pi_agent_pid", "42", ";",
      "set-option", "-p", "-t", "%5", "@paseo_pi_agent_start_token", "abc:123", ";",
      "set-option", "-p", "-t", "%5", "@paseo_agent_id", "agent"]);
    return { status: 0 };
  }, { pid: 42, startToken: "abc:123" }), true);
  assert.equal(clearPaseoAgentPane(placement, "agent", (_command, args) => {
    assert.deepEqual(args.slice(0, 6), ["-S", "/canonical", "if-shell", "-F", "-t", "%5"]);
    assert.equal(args[6], "#{&&:#{==:#{@paseo_agent_id},agent},#{&&:#{==:#{@paseo_pi_agent_pid},42},#{==:#{@paseo_pi_agent_start_token},abc:123}}}");
    assert.equal(args[7], "set-option -p -u -t %5 @paseo_agent_id ; set-option -p -u -t %5 @paseo_pi_agent_pid ; set-option -p -u -t %5 @paseo_pi_agent_start_token");
    return { status: 0 };
  }, { pid: 42, startToken: "abc:123" }), true);
});
test("managed children are never reaped by fork archive cleanup", () => {
  assert.equal(killForkPaneForAgent("agent", { runtimeRecord: { ...record, forkCreated: true, managed: true }, spawnSync() { throw new Error("must not touch tmux"); } }), false);
});
test("shim fails closed with a live owner and unavailable socket without spawning Pi", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-owner-test-"));
  try {
    const directory = path.join(home, ".pi", "paseo-bridge", "runtimes");
    fs.mkdirSync(directory, { recursive: true });
    const sessionFile = path.join(home, "session.jsonl");
    fs.writeFileSync(path.join(directory, "owner.json"), JSON.stringify({ sessionFile, pid: process.pid,
      managed: true, bridgeSocket: path.join(home, "missing.sock") }));
    const shim = fileURLToPath(new URL("../shim/pi-paseo-shim.js", import.meta.url));
    const result = spawnSync(process.execPath, [shim, "--mode", "rpc", "--session", sessionFile], {
      env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: home, PI_REAL_BIN: "/must-not-be-launched", PASEO_AGENT_ID: "" },
      input: "", encoding: "utf8", timeout: 10000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Refusing to launch a second Pi/);
    assert.doesNotMatch(result.stderr, /failed to spawn/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
test("allocation claims reject concurrent and unresolved launches", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launch-claim-"));
  try {
    const release = claimRuntimeLaunch("agent", directory);
    assert.throws(() => claimRuntimeLaunch("agent", directory), /already pending or unresolved/);
    release();
    const releaseAgain = claimRuntimeLaunch("agent", directory);
    releaseAgain();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
test("dead managed ownership is unresolved, not automatic revival authority", () => {
  assert.throws(() => assertNoLiveRuntimeOwner(record.sessionFile, { records: [{ ...record, managed: true }],
    kill() { throw Object.assign(new Error(), { code: "ESRCH" }); } }), /unresolved managed/);
});
test("reaping events require the trusted exact runtime and child, with a bounded public epoch", () => {
  const env = { PI_HARNESS_RUNTIME_ID: "runtime", PI_HARNESS_CHILD_ID: "child" };
  const event = { runtimeId: "runtime", childId: "child", workerEpoch: "a".repeat(32) };
  assert.equal(validRuntimeReapingEvent(event, env), true);
  for (const value of [null, [], {}, { ...event, runtimeId: "other" }, { ...event, childId: "other" },
    { ...event, workerEpoch: "bad" }, { ...event, controlToken: "secret" }]) {
    assert.equal(validRuntimeReapingEvent(value, env), false);
  }
  assert.equal(validRuntimeReapingEvent(event, {}), false);
});
test("reaped records reject attachment and fallback, even for the current PID", () => {
  const reaped = { ...record, pid: process.pid, lifecycle: "reaped", managed: true };
  assert.throws(() => assertRuntimeNotReaped([reaped]), /explicitly reaped/);
  assert.throws(() => assertNoLiveRuntimeOwner(record.sessionFile, { records: [reaped], ignorePid: process.pid }), /explicitly reaped/);
  assert.doesNotThrow(() => assertRuntimeNotReaped([{ ...record, lifecycle: "active" }]));
});
test("Linux process identity includes boot and process start", () => {
  if (process.platform === "linux") assert.match(processStartToken()!, /^[a-f0-9-]+:\d+$/);
});
