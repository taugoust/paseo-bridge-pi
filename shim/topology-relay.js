import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createForkedSession, resolveForkPlan } from "./fork-support.js";
import { findSourcePane, killTmuxPane, launchForkTui, selectForkTuiBin } from "./tmux-fork.js";
import { claimRuntimeLaunch, matchingRuntimeRecords, runtimeOwnerMayBeAlive } from "./runtime-registry.js";
import { validateTmuxTarget } from "./tmux-target.js";
import { startForkArchiveMonitor } from "./fork-lifecycle.js";

/** Native TUI bootstrap supplies provider metadata before the first prompt
 * reveals whether this is a root or a history fork. Never start an RPC worker. */
export async function topologyRelay({ target, args, sessionFile, waitForSocket }) {
  validateTmuxTarget(target);
  const agentId = process.env.PASEO_AGENT_ID?.trim();
  if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) throw new Error("Topology launch requires a valid Paseo agent ID");
  if (process.env.PI_PASEO_ROOT_TUI_KIND !== "unsafe" || !process.env.PI_PASEO_UNSAFE_TUI_BIN?.trim()) {
    throw new Error("Topology root launch requires explicit unsafe trust and PI_PASEO_UNSAFE_TUI_BIN");
  }
  const cwd = process.env.PASEO_AGENT_CWD || process.cwd();
  if (!sessionFile) {
    const directory = path.join(os.homedir(), ".pi", "paseo-bridge", "sessions");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    sessionFile = path.join(directory, `${Date.now()}_${crypto.randomUUID()}.jsonl`);
  }
  const releaseLaunch = claimRuntimeLaunch(agentId);
  let launched = launchForkTui({ target, sourcePane: { tuiKind: "unsafe", socketPath: target.tmuxSocket },
    forkSessionFile: sessionFile, agentId, cwd, rpcArgs: args, forkCreated: false,
    tuiBin: process.env.PI_PASEO_UNSAFE_TUI_BIN.trim() });
  let backend = await waitForSocket(launched.socketPath);
  releaseLaunch();
  let firstPrompt = true;
  let stopArchiveMonitor = () => {};
  let replacing = false;
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  const attach = socket => {
    socket.pipe(process.stdout);
    socket.on("error", () => {});
    socket.on("close", () => {
      if (backend !== socket || replacing) return;
      backend = null;
      send({ type: "process_exit", error: "The interactive Pi session has ended; reconnect or explicitly resume it." });
    });
  };
  attach(backend);
  const handle = async line => {
    if (!line.trim()) return;
    let command;
    try { command = JSON.parse(line); }
    catch { return; }
    try {
      if (firstPrompt && command.type === "prompt") {
        const plan = resolveForkPlan({ command, targetAgentId: agentId });
        if (plan) {
          validateTmuxTarget(target);
          const sourcePane = findSourcePane(plan.sourceSessionFile);
          const tuiBin = selectForkTuiBin(sourcePane, { supervised: process.env.PI_PASEO_TUI_BIN, unsafe: process.env.PI_PASEO_UNSAFE_TUI_BIN });
          const forkSessionFile = createForkedSession(plan.sourceSessionFile, plan.sourceEntryId, plan.sourceSnapshot);
          const records = matchingRuntimeRecords(sessionFile, agentId);
          const owner = records.find(record => record.tmuxPane === launched.paneId && record.sessionFile === path.resolve(sessionFile));
          if (!owner || owner.managed || !runtimeOwnerMayBeAlive(owner)) throw new Error("Cannot verify bootstrap Pi ownership");
          const pane = findSourcePane(sessionFile, { runtimeRecord: owner });
          const releaseFork = claimRuntimeLaunch(agentId);
          replacing = true;
          backend.unpipe(process.stdout);
          backend.destroy();
          backend = null;
          killTmuxPane(pane.paneId, { socketPath: pane.socketPath });
          const deadline = Date.now() + 5000;
          while (runtimeOwnerMayBeAlive(owner)) {
            if (Date.now() >= deadline) throw new Error("Bootstrap Pi has not exited; refusing a concurrent fork owner");
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          launched = launchForkTui({ target, sourcePane, forkSessionFile, agentId,
            cwd: plan.fork.cwd || cwd, tuiBin, rpcArgs: args });
          sessionFile = forkSessionFile;
          backend = await waitForSocket(launched.socketPath);
          releaseFork();
          replacing = false;
          firstPrompt = false;
          attach(backend);
          stopArchiveMonitor = startForkArchiveMonitor(agentId, { onKilled: () => process.exit(0) });
          if (plan.trimmedIncompleteTools) process.stderr.write("pi-paseo-shim: trimmed unfinished native fork tool batch\n");
          if (plan.nextPrompt) backend.write(`${JSON.stringify({ ...command, message: plan.nextPrompt })}\n`);
          else send({ type: "response", id: command.id, command: "prompt", success: true, data: { agentInvoked: false } });
          return;
        }
        firstPrompt = false;
      }
      if (!backend) throw new Error("Interactive Pi bridge is unavailable; no replacement worker was started");
      backend.write(`${line}\n`);
    } catch (error) {
      send({ type: "response", id: command.id, command: command.type, success: false, error: String(error.message ?? error) });
    }
  };
  let buffer = "";
  let queue = Promise.resolve();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      queue = queue.then(() => handle(line));
    }
  });
  process.stdin.on("end", () => { queue = queue.then(async () => { if (buffer.trim()) await handle(buffer); backend?.end(); }); });
  const detach = () => { stopArchiveMonitor(); backend?.destroy(); process.exit(0); };
  process.once("SIGTERM", detach);
  process.once("SIGINT", detach);
}
