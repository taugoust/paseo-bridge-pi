import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmuxServerIdentity } from "../shim/tmux-target.js";
import { shellQuote } from "../shim/tmux-fork.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { workspaceIdForPlacement } from "../extension/import-placement.ts";
import { runtimeOwnerMayBeAlive, processStartToken } from "../shim/runtime-registry.js";

const piBin = process.env.TEST_PI_BIN;
async function poll(check: () => boolean, message: string, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function cleanupTmux(tmux: (...args: string[]) => unknown, root: string) {
  const directory = path.join(root, ".pi", "paseo-bridge", "runtimes");
  let owners: any[] = [];
  try { owners = fs.readdirSync(directory).filter(file => file.endsWith(".json")).map(file => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"))); } catch {}
  tmux("kill-server");
  // kill-server acknowledges before Pi finishes its graceful shutdown hooks.
  // Do not race those writers while deleting the private test home.
  await poll(() => owners.every(owner => !runtimeOwnerMayBeAlive(owner)), "test Pi process did not finish shutdown");
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

for (const successor of [false, true, "reused-pid"]) test(`manual Pi returns to shell: ${successor === "reused-pid" ? "PID-reuse tags protected" : successor ? "successor tags protected" : "owned tags cleared"}`, { skip: !piBin, timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-shell-return-"));
  const socket = path.join(root, "tmux.sock");
  const session = path.join(root, "session.jsonl");
  const noPaseo = path.join(root, "paseo-unavailable");
  fs.writeFileSync(noPaseo, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const env = { ...process.env, PASEO_CLI: noPaseo, HOME: root, XDG_RUNTIME_DIR: root, PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_PASEO_BRIDGE: "on", PI_PASEO_BRIDGE_NO_IMPORT: "1", PI_PASEO_BRIDGE_NO_TITLE: "1", PI_TELEMETRY: "0",
    PI_PASEO_EXISTING_AGENT_ID: "manual-agent", PI_PASEO_AGENT_SOCKET: path.join(root, "bridge.sock"), PI_HARNESS_RUNTIME_ID: "", PI_PASEO_TMUX_TARGET: undefined };
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { env, encoding: "utf8", timeout: 5000 });
  try {
    const command = `${shellQuote(piBin!)} --no-extensions --extension ${shellQuote(path.resolve("extension/index.ts"))} --session ${shellQuote(session)}; exec /bin/sh`;
    const start = tmux("new-session", "-d", "-s", "manual", "-x", "160", "-y", "50", command);
    assert.equal(start.status, 0, start.stderr);
    const pane = tmux("display-message", "-p", "#{pane_id}").stdout.trim();
    const directory = path.join(root, ".pi", "paseo-bridge", "runtimes");
    const record = () => {
      try { const file = fs.readdirSync(directory).find(file => file.endsWith(".json")); return file ? JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) : null; } catch { return null; }
    };
    await poll(() => record()?.agentId === "manual-agent", "manual Pi did not start");
    const owner = record();
    const tag = (name: string) => tmux("show-options", "-pqv", "-t", pane, name).stdout.trim();
    assert.equal(tag("@paseo_agent_id"), "manual-agent");
    assert.equal(tag("@paseo_pi_agent_pid"), String(owner.pid));
    assert.equal(tag("@paseo_pi_agent_start_token"), processStartToken(owner.pid));
    if (!successor) {
      const client = net.connect(owner.bridgeSocket);
      let output = "";
      client.on("data", chunk => { output += chunk; });
      client.on("error", () => {});
      await once(client, "connect");
      client.write(JSON.stringify({ id: "reload", type: "prompt", message: "/remote-reload" }) + "\n");
      await poll(() => output.includes("Pi runtime reloaded."), "manual Pi reload did not complete");
      client.destroy();
      assert.equal(tag("@paseo_agent_id"), "manual-agent");
      assert.equal(tag("@paseo_pi_agent_pid"), String(owner.pid));
      assert.equal(tag("@paseo_pi_agent_start_token"), processStartToken(owner.pid));
    }
    const successorPid = successor === "reused-pid" ? owner.pid : process.pid;
    if (successor) {
      assert.equal(tmux("set-option", "-p", "-t", pane, "@paseo_pi_agent_pid", String(successorPid), ";",
        "set-option", "-p", "-t", pane, "@paseo_pi_agent_start_token", processStartToken()!).status, 0);
    }
    process.kill(owner.pid, "SIGTERM");
    await poll(() => !runtimeOwnerMayBeAlive(owner), "manual Pi did not exit");
    assert.equal(record(), null);
    assert.equal(tmux("display-message", "-p", "-t", pane, "#{pane_id}").stdout.trim(), pane, "plain Pi exit must retain its shell pane");
    assert.equal(tag("@paseo_agent_id"), successor ? "manual-agent" : "");
    assert.equal(tag("@paseo_pi_agent_pid"), successor ? String(successorPid) : "");
    assert.equal(tag("@paseo_pi_agent_start_token"), successor ? processStartToken() : "");
  } finally { await cleanupTmux(tmux, root); }
});

for (const explicitReap of [false, true]) test(`staged TUI promotion and ${explicitReap ? "explicit reap tombstone" : "ordinary shutdown cleanup"}`,  { skip: !piBin, timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-promotion-"));
  const socket = path.join(root, "tmux.sock");
  const importLog = path.join(root, "imports");
  const paseo = path.join(root, "paseo-test");
  fs.writeFileSync(paseo, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(importLog)}\nif [ ! -e ${shellQuote(path.join(root, "projected"))} ]; then\n  : > ${shellQuote(path.join(root, "projected"))}\n  printf '%s\\n' 'Workspace is not projected yet' >&2\n  exit 1\nfi\nprintf '%s\\n' '{"agentId":"promoted-agent"}'\n`, { mode: 0o700 });
  const reapFixture = path.join(root, "reap-fixture.ts");
  fs.writeFileSync(reapFixture, `export default function(pi) {
    pi.registerCommand("test-invalid-reap", { handler() {
      pi.events.emit("harness-runtime-reaping", {runtimeId: "wrong", childId: process.env.PI_HARNESS_CHILD_ID, workerEpoch: "a".repeat(32)});
    }});
    pi.registerCommand("test-explicit-reap", { handler(_args, ctx) {
      pi.events.emit("harness-runtime-reaping", {runtimeId: process.env.PI_HARNESS_RUNTIME_ID, childId: process.env.PI_HARNESS_CHILD_ID, workerEpoch: "a".repeat(32)});
      setTimeout(() => ctx.shutdown(), 1000);
    }});
  }`);
  const env = { ...process.env, HOME: root, XDG_RUNTIME_DIR: root, PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_HARNESS_CHILD_ID: "promoted-child",
    PI_PASEO_BRIDGE: "on", PI_PASEO_BRIDGE_NO_IMPORT: "", PI_PASEO_EXISTING_AGENT_ID: "", PASEO_CLI: paseo,
    PI_PASEO_BRIDGE_NO_TITLE: "1", PI_TELEMETRY: "0", PI_HARNESS_RUNTIME_ID: "promoted-runtime", PASEO_TMUX_TOPOLOGY: "1",
    PI_PASEO_TMUX_TARGET: JSON.stringify({ version: 1, tmuxSocket: "/stale.sock", tmuxServerId: "1:2:3", tmuxSessionId: "$99", tmuxWindowId: "@99", projectId: "old-project", workspaceId: "old-workspace" }) };
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { env, encoding: "utf8", timeout: 5000 });
  try {
    assert.equal(tmux("new-session", "-d", "-s", "project", "-x", "160", "-y", "50").status, 0);
    const pane = tmux("display-message", "-p", "#{pane_id}").stdout.trim();
    assert.equal(tmux("set-option", "-p", "-t", pane, "@pi_infrastructure", "1").status, 0);
    const session = path.join(root, "session.jsonl");
    const command = `${shellQuote(piBin!)} --no-extensions --extension ${shellQuote(path.resolve("extension/index.ts"))} --extension ${shellQuote(reapFixture)} --session ${shellQuote(session)}`;
    assert.equal(tmux("respawn-pane", "-k", "-t", pane, command).status, 0);
    const directory = path.join(root, ".pi", "paseo-bridge", "runtimes");
    const record = () => {
      try { const file = fs.readdirSync(directory).find(file => file.endsWith(".json")); return file ? JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) : null; }
      catch { return null; }
    };
    await poll(() => record()?.infrastructure === true, "staged runtime did not start");
    assert.equal(fs.existsSync(importLog), false);
    const targetWindow = tmux("new-window", "-d", "-P", "-F", "#{window_id}").stdout.trim();
    assert.equal(tmux("join-pane", "-d", "-s", pane, "-t", targetWindow).status, 0);
    assert.equal(tmux("set-option", "-p", "-t", pane, "@pi_infrastructure", "0").status, 0);
    await poll(() => record()?.agentId === "promoted-agent" && record()?.tmuxWindowId === targetWindow, "promotion did not refresh/import");
    const imports = fs.readFileSync(importLog, "utf8").trim().split("\n");
    assert.equal(imports.length, 2, "workspace projection failure must retry even without another placement change");
    const expectedWorkspace = workspaceIdForPlacement({ tmuxSocket: fs.realpathSync(socket), tmuxServerId: record().tmuxServerId, tmuxWindowId: targetWindow });
    for (const line of imports) {
      assert.match(line, /import --provider pi/);
      assert(line.includes(`--workspace-id ${expectedWorkspace}`), line);
      assert(!line.includes("old-workspace"));
    }
    assert.equal(record().workspaceId, expectedWorkspace);
    assert.equal(record().projectId, null, "do not publish inherited project identity from another tmux session");
    assert.equal(tmux("show-options", "-p", "-v", "-t", pane, "@paseo_agent_id").stdout.trim(), "promoted-agent");
    assert.equal(record().runtimeId, "promoted-runtime");
    assert.match(record().tmuxServerId, /^\d+:\d+:\d+$/);
    if (!explicitReap) {
      process.kill(record().pid, "SIGTERM");
      await poll(() => record() === null, "graceful managed Pi shutdown did not remove its registry entry");
    } else {
      const workerPid = record().pid;
      const client = net.connect(record().bridgeSocket);
      let output = "";
      client.on("data", chunk => { output += chunk; });
      client.on("error", () => {});
      await once(client, "connect");
      client.write(JSON.stringify({ id: "invalid-reap", type: "prompt", message: "/test-invalid-reap" }) + "\n");
      await poll(() => output.includes('"id":"invalid-reap"'), "invalid reap fixture did not return");
      assert.equal(record().lifecycle, "active");
      client.write(JSON.stringify({ id: "explicit-reap", type: "prompt", message: "/test-explicit-reap" }) + "\n");
      await poll(() => record()?.lifecycle === "reaped", "explicit reap did not persist a tombstone");
      client.write(JSON.stringify({ id: "blocked-wake", type: "prompt", message: "must never reach the model" }) + "\n");
      await poll(() => output.includes('"id":"blocked-wake"'), "attached controller did not receive the reap error");
      const blocked = output.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(frame => frame.id === "blocked-wake");
      assert.equal(blocked.success, false);
      assert.match(blocked.error, /explicitly reaped/);
      await poll(() => { try { process.kill(workerPid, 0); return false; } catch { return true; } }, "reaped Pi did not exit");
      client.destroy();
      assert.equal(record().workerEpoch, "a".repeat(32));
      assert.equal(record().runtimeId, "promoted-runtime");
      assert.equal(record().childId, "promoted-child");
      assert(!output.includes('"type":"agent_start"'), "reap must not wake the model");
      for (const resumeArgs of [["--session", session], []]) {
        const result = spawnSync(process.execPath, [path.resolve("shim/pi-paseo-shim.js"), "--mode", "rpc", ...resumeArgs], {
          env: { ...env, PASEO_AGENT_ID: "promoted-agent", PI_REAL_BIN: "/must-not-launch" }, input: '{"id":"wake","type":"prompt","message":"must not run"}\n',
          encoding: "utf8", timeout: 5000,
        });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /explicitly reaped/);
        assert.doesNotMatch(result.stderr, /failed to spawn/);
      }
      assert.equal(record().lifecycle, "reaped", "shutdown or stale provider reconnect must retain the tombstone");
    }
  } finally { await cleanupTmux(tmux, root); }
});
test("topology root and native fork use real target TUIs and survive shim disconnect", { skip: !piBin, timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-topology-"));
  const socket = path.join(root, "tmux.sock");
  const env = { ...process.env, HOME: root, XDG_RUNTIME_DIR: root, PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_PASEO_BRIDGE: "on", PI_PASEO_BRIDGE_NO_IMPORT: "1", PI_PASEO_BRIDGE_NO_TITLE: "1", PI_TELEMETRY: "0" };
  const tmux = (...args: string[]) => spawnSync("tmux", ["-S", socket, ...args], { env, encoding: "utf8", timeout: 5000 });
  let child;
  try {
    const start = tmux("new-session", "-d", "-s", "project", "-x", "160", "-y", "50");
    assert.equal(start.status, 0, start.stderr);
    const [pid, sessionId, windowId] = tmux("list-windows", "-F", "#{pid}\t#{session_id}\t#{window_id}").stdout.trim().split("\t");
    const target = { version: 1, tmuxSocket: socket, tmuxServerId: tmuxServerIdentity(Number(pid), socket), tmuxSessionId: sessionId,
      tmuxWindowId: windowId, projectId: "project", workspaceId: "workspace" };
    const manager = SessionManager.create(root, path.join(root, "source-sessions"));
    manager.appendMessage({ role: "user", content: "Question", timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fork checkpoint" }], api: "openai-responses", provider: "openai", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    const sourceFile = manager.getSessionFile()!;
    const paseo = path.join(root, "paseo-list");
    fs.writeFileSync(paseo, `#!/bin/sh\nprintf '%s\\n' ${shellQuote(JSON.stringify([{ id: "source-agent", name: "Source", cwd: root, workspaceId: "source-workspace" }, { id: "test-root", name: "Root", cwd: root, workspaceId: "workspace" }]))}\n`, { mode: 0o700 });
    const launcher = path.join(root, "pi-unsafe-test");
    fs.writeFileSync(launcher, `#!/bin/sh\nexec ${shellQuote(piBin!)} --no-extensions --extension ${shellQuote(path.resolve("extension/index.ts"))} "$@"\n`, { mode: 0o700 });
    const supervisedLauncher = path.join(root, "pi-supervised-test");
    fs.writeFileSync(supervisedLauncher, `#!/bin/sh\nexec env PI_SUPERVISED=1 ${shellQuote(launcher)} "$@"\n`, { mode: 0o700 });
    child = spawn(process.execPath, [path.resolve("shim/pi-paseo-shim.js"), "--mode", "rpc"], {
      env: { ...env, PASEO_AGENT_ID: "test-root", PASEO_AGENT_CWD: root, PI_PASEO_TMUX_TARGET: JSON.stringify(target),
        PI_PASEO_ROOT_TUI_KIND: "unsafe", PI_PASEO_UNSAFE_TUI_BIN: launcher, PI_PASEO_TUI_BIN: supervisedLauncher, PASEO_CLI: paseo, PI_REAL_BIN: "/must-never-run-rpc" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    let output = "", errors = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { errors += chunk; });
    child.stdin.write('{"id":"state","type":"get_state"}\n');
    const deadline = Date.now() + 15000;
    while (!output.includes('"id":"state"')) {
      assert(child.exitCode === null && Date.now() < deadline, `${errors}\n${output}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const response = output.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(frame => frame.id === "state");
    assert.equal(response.success, true);
    assert.equal(response.data.isStreaming, false);
    const recordsDir = path.join(root, ".pi", "paseo-bridge", "runtimes");
    const records = fs.readdirSync(recordsDir).filter(file => file.endsWith(".json")).map(file => JSON.parse(fs.readFileSync(path.join(recordsDir, file), "utf8")));
    assert.equal(records.length, 1);
    assert.equal(records[0].tmuxWindowId, windowId);
    assert.equal(records[0].tmuxServerId, target.tmuxServerId);
    assert.equal(records[0].forkCreated, false);
    const cmdline = fs.readFileSync(`/proc/${records[0].pid}/cmdline`, "utf8");
    assert(!cmdline.includes("\0rpc\0"), cmdline);
    assert.equal(tmux("list-panes", "-t", `${sessionId}:${windowId}`, "-F", "#{pane_id}").stdout.trim().split("\n").length, 2);
    const sourceCommand = `env PI_SUPERVISED=1 PI_PASEO_EXISTING_AGENT_ID=source-agent PI_PASEO_AGENT_SOCKET=${shellQuote(path.join(root, "source.sock"))} ${shellQuote(launcher)} --session ${shellQuote(sourceFile)}`;
    assert.equal(tmux("new-window", "-d", sourceCommand).status, 0);
    const readRecords = () => fs.readdirSync(recordsDir).filter(file => file.endsWith(".json")).map(file => JSON.parse(fs.readFileSync(path.join(recordsDir, file), "utf8")));
    await poll(() => readRecords().some(record => record.agentId === "source-agent"), "source TUI did not start");
    const sourceBytes = fs.readFileSync(sourceFile, "utf8");
    child.stdin.write(JSON.stringify({ id: "fork", type: "prompt", message: `<chat-history-summary>\nChat history from a previous Paseo agent.\nSource agent: Source\nSource directory: ${root}\n\n[User] Question\n[Assistant] Fork checkpoint\n</chat-history-summary>` }) + "\n");
    await poll(() => output.includes('"id":"fork"'), `fork did not respond: ${errors}`, 15000);
    const forkResponse = output.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(frame => frame.id === "fork");
    assert.equal(forkResponse.success, true, JSON.stringify(forkResponse));
    assert.equal(forkResponse.data.agentInvoked, false);
    await poll(() => readRecords().some(record => record.agentId === "test-root" && record.forkCreated), "fork bridge did not finish agent adoption");
    const forkRecord = readRecords().find(record => record.agentId === "test-root" && record.forkCreated);
    assert(forkRecord);
    assert.equal(forkRecord.tmuxWindowId, windowId);
    assert.equal(forkRecord.tuiKind, "supervised");
    assert.notEqual(forkRecord.pid, records[0].pid);
    assert.throws(() => process.kill(records[0].pid, 0));
    assert.equal(fs.readFileSync(sourceFile, "utf8"), sourceBytes);
    assert.match(fs.readFileSync(forkRecord.sessionFile, "utf8"), /Fork checkpoint/);
    child.kill("SIGTERM");
    await closed;
    assert.doesNotThrow(() => process.kill(forkRecord.pid, 0));
    assert.equal(tmux("display-message", "-p", "-t", forkRecord.tmuxPane, "#{pane_id}").stdout.trim(), forkRecord.tmuxPane);
  } finally {
    child?.kill("SIGTERM");
    await cleanupTmux(tmux, root);
  }
});
