import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { tmuxServerIdentity } from "./tmux-target.js";

/** Allocation claim survives an uncertain launcher crash. A published bridge
 * releases it; a stale claim requires explicit operator/harness reconciliation. */
export function claimRuntimeLaunch(agentId, directory = path.join(os.homedir(), ".pi", "paseo-bridge", "launches")) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${crypto.createHash("sha256").update(agentId).digest("hex")}.json`);
  const nonce = crypto.randomUUID();
  let fd;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Pi runtime launch is already pending or unresolved: ${file}. Refusing another allocation.`);
    throw error;
  }
  try { fs.writeFileSync(fd, JSON.stringify({ agentId, pid: process.pid, processStartToken: processStartToken(), nonce })); }
  finally { fs.closeSync(fd); }
  return () => {
    try { if (JSON.parse(fs.readFileSync(file, "utf8")).nonce === nonce) fs.unlinkSync(file); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  };
}

export const REAPED_RUNTIME_ERROR = "This managed Pi runtime was explicitly reaped. Reconnecting cannot restart it; launch a new child or explicitly continue as a new runtime.";

export function validRuntimeReapingEvent(event, env = process.env) {
  return Boolean(event && typeof event === "object" && !Array.isArray(event)
    && Object.keys(event).every(key => ["runtimeId", "childId", "workerEpoch"].includes(key))
    && env.PI_HARNESS_RUNTIME_ID?.trim() && env.PI_HARNESS_CHILD_ID?.trim()
    && event.runtimeId === env.PI_HARNESS_RUNTIME_ID.trim()
    && event.childId === env.PI_HARNESS_CHILD_ID.trim()
    && typeof event.workerEpoch === "string" && /^[a-f0-9]{32}$/.test(event.workerEpoch));
}

export function assertRuntimeNotReaped(records) {
  if (records.some(record => record.lifecycle === "reaped")) throw new Error(REAPED_RUNTIME_ERROR);
}

export function harnessRuntimeMetadata(env = process.env) {
  const value = key => env[key]?.trim() || null;
  const runtimeId = value("PI_HARNESS_RUNTIME_ID");
  return {
    managed: Boolean(runtimeId),
    runtimeId,
    parentSessionId: value("PI_HARNESS_PARENT_SESSION_ID"),
    taskId: value("PI_HARNESS_TASK_ID"),
    groupId: value("PI_HARNESS_GROUP_ID"),
    childId: value("PI_HARNESS_CHILD_ID"),
    attempt: value("PI_HARNESS_ATTEMPT"),
    controlSocket: value("PI_HARNESS_CONTROL_SOCKET"),
  };
}

function validPaneOwner(placement, agentId, identity) {
  return placement.tmuxSocket && /^%\d+$/.test(placement.tmuxPane ?? "")
    && (agentId == null || /^[a-zA-Z0-9_-]+$/.test(agentId))
    && Number.isSafeInteger(identity.pid) && identity.pid > 0
    && typeof identity.startToken === "string" && /^[a-f0-9-]+:\d+$/.test(identity.startToken);
}

export function markPaseoAgentPane(placement, agentId, run = spawnSync,
  identity = { pid: process.pid, startToken: processStartToken() }) {
  if (!validPaneOwner(placement, agentId, identity)) return false;
  const pane = placement.tmuxPane;
  // Publish the complete owner tuple in one server command queue, not detached
  // children that can outlive Pi and overwrite a successor's pane tags.
  const result = run("tmux", ["-S", placement.tmuxSocket,
    "set-option", "-p", "-t", pane, "@paseo_pi_agent_pid", String(identity.pid), ";",
    "set-option", "-p", "-t", pane, "@paseo_pi_agent_start_token", identity.startToken, ";",
    ...(agentId == null ? ["set-option", "-p", "-u", "-t", pane, "@paseo_agent_id"]
      : ["set-option", "-p", "-t", pane, "@paseo_agent_id", agentId]),
  ], { encoding: "utf8", timeout: 5000 });
  return result.status === 0;
}

export function clearPaseoAgentPane(placement, agentId, run = spawnSync,
  identity = { pid: process.pid, startToken: processStartToken() }) {
  if (!validPaneOwner(placement, agentId, identity)) return false;
  const pane = placement.tmuxPane;
  const condition = `#{&&:#{==:#{@paseo_agent_id},${agentId ?? ""}},#{&&:#{==:#{@paseo_pi_agent_pid},${identity.pid}},#{==:#{@paseo_pi_agent_start_token},${identity.startToken}}}}`;
  const clear = ["@paseo_agent_id", "@paseo_pi_agent_pid", "@paseo_pi_agent_start_token"]
    .map(tag => `set-option -p -u -t ${pane} ${tag}`).join(" ; ");
  // Evaluate ownership and enqueue cleanup on the tmux server. Never inspect
  // locally then unconditionally clear: that races a new Pi claiming the pane.
  const result = run("tmux", ["-S", placement.tmuxSocket, "if-shell", "-F", "-t", pane, condition, clear],
    { encoding: "utf8", timeout: 5000 });
  return result.status === 0;
}

export function resolveTmuxIdentity(env = process.env, run = spawnSync, realpath = fs.realpathSync) {
  let socket = env.TMUX?.split(",", 1)[0]?.trim();
  const pane = env.TMUX_PANE?.trim();
  if (!socket || !/^%[0-9]+$/.test(pane ?? "")) return {};
  try { socket = realpath(socket); } catch { return {}; }
  const result = run("tmux", ["-S", socket, "display-message", "-p", "-t", pane,
    "#{session_id}\t#{window_id}\t#{pane_id}\t#{@pi_infrastructure}\t#{pid}"], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return {};
  const [sessionId, windowId, paneId, infrastructure, serverPid] = result.stdout.trim().split("\t");
  if (!/^\$[0-9]+$/.test(sessionId) || !/^@[0-9]+$/.test(windowId) || paneId !== pane) return {};
  let serverId;
  if (/^\d+$/.test(serverPid ?? "")) {
    try { serverId = tmuxServerIdentity(Number(serverPid), socket); } catch { /* unavailable or unsupported server identity */ }
  }
  return { tmuxSocket: socket, tmuxSessionId: sessionId, tmuxWindowId: windowId, tmuxPane: paneId,
    ...(serverId ? { tmuxServerId: serverId } : {}),
    ...(infrastructure === "1" ? { infrastructure: true } : {}) };
}

export function runtimeRegistryDirectory() {
  return path.join(os.homedir(), ".pi", "paseo-bridge", "runtimes");
}

export function readRuntimeRecords(directory = runtimeRegistryDirectory()) {
  let files;
  try { files = fs.readdirSync(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return files.filter(file => file.endsWith(".json")).map(file => {
    // Records are atomically published. Corruption is not evidence that an
    // owner has exited: fail closed rather than starting another writer.
    const record = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error("Invalid Pi runtime registry record");
    }
    return record;
  });
}

export function processStartToken(pid = process.pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return `${boot}:${fields[19]}`;
  } catch { return null; }
}

export function runtimeOwnerMayBeAlive(record, options = {}) {
  if (!Number.isSafeInteger(record.pid) || record.pid < 1) return true;
  const kill = options.kill ?? process.kill;
  try { kill(record.pid, 0); }
  catch (error) { return error.code !== "ESRCH"; }
  const startToken = (options.processStartToken ?? processStartToken)(record.pid);
  // Old records and platforms without start tokens remain conservative.
  return !record.processStartToken || !startToken || record.processStartToken === startToken;
}

export function matchingRuntimeRecords(sessionFile, agentId, records = readRuntimeRecords()) {
  const normalize = value => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return records.filter(record =>
    (agentId && record.agentId === agentId)
    || (sessionFile && typeof record.sessionFile === "string"
      && normalize(record.sessionFile) === normalize(sessionFile)));
}

export function assertNoLiveRuntimeOwner(sessionFile, options = {}) {
  const records = matchingRuntimeRecords(sessionFile, options.agentId, options.records);
  assertRuntimeNotReaped(records);
  const owner = records.find(record => record.pid !== options.ignorePid
    && (record.managed === true || record.runtimeId || runtimeOwnerMayBeAlive(record, options)));
  if (owner) throw new Error(`Pi session already has a live or unresolved managed runtime owner (PID ${owner.pid}); bridge unavailable. Refusing to launch a second Pi. Reconnect or explicitly reap the existing runtime first.`);
}
