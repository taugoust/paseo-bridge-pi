import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DEFAULT_FORK_START_TIMEOUT_MS = 120_000;
const MAX_FORK_START_TIMEOUT_MS = 600_000;

export function forkStartupTimeoutMs(value = process.env.PI_PASEO_FORK_START_TIMEOUT_MS) {
  if (value == null || String(value).trim() === "") return DEFAULT_FORK_START_TIMEOUT_MS;
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000 || milliseconds > MAX_FORK_START_TIMEOUT_MS) {
    throw new Error("PI_PASEO_FORK_START_TIMEOUT_MS must be an integer between 1000 and 600000");
  }
  return milliseconds;
}

export function pipePathForAgent(agentId) {
  const dir = process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, "pi-paseo")
    : path.join(os.homedir(), ".pi", "paseo-bridge");
  return path.join(dir, `agent-${agentId}.sock`);
}

function readRuntimeRecord(sourceSessionFile) {
  const directory = path.join(os.homedir(), ".pi", "paseo-bridge", "runtimes");
  let files;
  try {
    files = fs.readdirSync(directory);
  } catch {
    return null;
  }
  const expected = path.resolve(sourceSessionFile);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
      if (path.resolve(record.sessionFile) === expected && typeof record.tmuxPane === "string") return record;
    } catch {
      // Ignore incomplete and stale records.
    }
  }
  return null;
}

export function parseTmuxPanes(output) {
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sessionName, windowId, paneId, agentPid] = line.split("\t");
      return { sessionName, windowId, paneId, agentPid: Number(agentPid) };
    })
    .filter((pane) => pane.sessionName && pane.windowId && pane.paneId && Number.isSafeInteger(pane.agentPid) && pane.agentPid > 0);
}

export function findSourcePane(sourceSessionFile, options = {}) {
  const run = options.spawnSync ?? spawnSync;
  const record = options.runtimeRecord ?? (options.readRuntimeRecord ?? readRuntimeRecord)(sourceSessionFile);
  if (!record?.tmuxPane) throw new Error("the source Pi session has no live tmux runtime record");
  if (record.tuiKind !== "supervised" && record.tuiKind !== "unsafe") {
    throw new Error("the source Pi runtime record has no valid TUI trust mode; reload the source session");
  }
  const socketArgs = record.tmuxSocket ? ["-S", record.tmuxSocket] : [];
  const result = run("tmux", [
    ...socketArgs,
    "display-message",
    "-p",
    "-t",
    record.tmuxPane,
    "#{session_name}\t#{window_id}\t#{pane_id}\t#{@paseo_pi_agent_pid}",
  ], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) {
    throw new Error(`could not inspect the source tmux pane: ${(result.stderr || "unknown error").trim()}`);
  }
  const panes = parseTmuxPanes(result.stdout);
  if (panes.length !== 1 || panes[0].paneId !== record.tmuxPane || panes[0].agentPid !== record.pid) {
    throw new Error("the source Pi tmux runtime record is stale");
  }
  return { ...panes[0], socketPath: record.tmuxSocket || null, tuiKind: record.tuiKind };
}

export function selectForkTuiBin(sourcePane, launchers) {
  const tuiBin = sourcePane.tuiKind === "supervised" ? launchers.supervised : launchers.unsafe;
  if (!tuiBin) throw new Error(`no ${sourcePane.tuiKind} Pi TUI launcher is configured for forks`);
  return tuiBin;
}

export function isPaseoGeneratedIntegrationExtension(extensionPath) {
  return /(?:^|[\\/])paseo-pi-extension-[^\\/]+[\\/]paseo-integration\.mjs$/.test(String(extensionPath));
}

export function buildTuiArgs(rpcArgs, sessionFile) {
  const result = [];
  for (let index = 0; index < rpcArgs.length; index += 1) {
    const arg = rpcArgs[index];
    if (arg === "--mode" || arg === "--session") {
      index += 1;
      continue;
    }
    if (arg === "--extension") {
      const extensionPath = rpcArgs[index + 1];
      if (extensionPath !== undefined) index += 1;
      if (isPaseoGeneratedIntegrationExtension(extensionPath)) continue;
      result.push(arg);
      if (extensionPath !== undefined) result.push(extensionPath);
      continue;
    }
    if (arg.startsWith("--extension=") && isPaseoGeneratedIntegrationExtension(arg.slice("--extension=".length))) {
      continue;
    }
    if (arg.startsWith("--mode=") || arg.startsWith("--session=") || arg === "--no-session") continue;
    result.push(arg);
  }
  result.push("--session", sessionFile);
  return result;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function buildTuiShellCommand(input) {
  const env = {
    PI_PASEO_EXISTING_AGENT_ID: input.agentId,
    PI_PASEO_AGENT_SOCKET: input.socketPath,
    PI_PASEO_BRIDGE_NO_IMPORT: "1",
  };
  const words = ["env"];
  for (const [name, value] of Object.entries(env)) words.push(`${name}=${shellQuote(value)}`);
  words.push(shellQuote(input.tuiBin), ...input.tuiArgs.map(shellQuote));
  return words.join(" ");
}

export function launchForkTui(input, options = {}) {
  const run = options.spawnSync ?? spawnSync;
  const sourcePane = input.sourcePane ?? findSourcePane(input.sourceSessionFile, options);
  const socketPath = input.socketPath ?? pipePathForAgent(input.agentId);
  try {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const command = buildTuiShellCommand({
    agentId: input.agentId,
    socketPath,
    tuiBin: input.tuiBin,
    tuiArgs: buildTuiArgs(input.rpcArgs, input.forkSessionFile),
  });
  const socketArgs = sourcePane.socketPath ? ["-S", sourcePane.socketPath] : [];
  const args = input.placement === "pane"
    ? [...socketArgs, "split-window", "-d", "-P", "-F", "#{pane_id}", "-t", sourcePane.windowId, "-c", input.cwd, command]
    : [...socketArgs, "new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${sourcePane.sessionName}:`, "-c", input.cwd, command];
  const result = run("tmux", args, { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) {
    throw new Error(`could not launch forked Pi in tmux: ${(result.stderr || "unknown error").trim()}`);
  }
  const paneId = result.stdout.trim();
  if (!paneId.startsWith("%")) throw new Error("tmux did not return the forked Pi pane id");
  return { paneId, socketPath, sourcePane, tmuxSocket: sourcePane.socketPath };
}

export function killTmuxPane(paneId, options = {}) {
  const run = options.spawnSync ?? spawnSync;
  const socketArgs = options.socketPath ? ["-S", options.socketPath] : [];
  run("tmux", [...socketArgs, "kill-pane", "-t", paneId], { encoding: "utf8", timeout: 5_000 });
}
