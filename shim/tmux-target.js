import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function parseTmuxTarget(value = process.env.PI_PASEO_TMUX_TARGET) {
  if (value === undefined) return null;
  const target = JSON.parse(value);
  if (!target || target.version !== 1 || !path.isAbsolute(target.tmuxSocket ?? "")
    || typeof target.tmuxServerId !== "string" || !target.tmuxServerId
    || !/^\$\d+$/.test(target.tmuxSessionId ?? "") || !/^@\d+$/.test(target.tmuxWindowId ?? "")
    || typeof target.projectId !== "string" || !target.projectId
    || typeof target.workspaceId !== "string" || !target.workspaceId) {
    throw new Error("Invalid PI_PASEO_TMUX_TARGET v1 placement");
  }
  return target;
}

export function tmuxServerIdentity(pid, socket, options = {}) {
  const read = options.readFileSync ?? fs.readFileSync;
  const stat = options.statSync ?? fs.statSync;
  if (process.platform !== "linux") throw new Error("Tmux topology requires Linux");
  const processStat = read(`/proc/${pid}/stat`, "utf8");
  const start = processStat.slice(processStat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  if (!/^\d+$/.test(start ?? "")) throw new Error("Cannot verify tmux server process start identity");
  const info = stat(socket);
  if (!info.isSocket()) throw new Error("Tmux target is not a socket");
  return `${pid}:${start}:${info.ino}`;
}

export function validateTmuxTarget(target, options = {}) {
  const run = options.spawnSync ?? spawnSync;
  const result = run("tmux", ["-S", target.tmuxSocket, "list-windows", "-t", target.tmuxSessionId,
    "-F", "#{pid}\t#{session_id}\t#{window_id}"], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) throw new Error("Tmux target session is unavailable");
  const rows = result.stdout.trim().split("\n").map(line => line.split("\t"));
  const row = rows.find(([, session, window]) => session === target.tmuxSessionId && window === target.tmuxWindowId);
  if (!row || !/^\d+$/.test(row[0])) throw new Error("Tmux target window does not belong to the target session");
  const identity = (options.serverIdentity ?? tmuxServerIdentity)(Number(row[0]), target.tmuxSocket);
  if (identity !== target.tmuxServerId) throw new Error("Tmux target server incarnation changed");
  return target;
}
