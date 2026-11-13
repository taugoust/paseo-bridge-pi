import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** The ID Paseo gives the terminal tab of a tmux pane. It must match `topologyId("trm", …)`
 * in Paseo's tmux topology: a hash of the socket's real path, the tmux server's identity
 * (pid, process start time and socket inode) and the pane ID. */
export function paseoTerminalId(socket: string, serverId: string, paneId: string): string {
  const hash = createHash("sha256").update(JSON.stringify([socket, serverId, paneId])).digest("hex");
  return `trm_tmux_${hash.slice(0, 24)}`;
}

/** The start time field of /proc/PID/stat, which Paseo uses to tell tmux servers apart. */
function processStartTime(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** Finds the Paseo terminal tab of a background job, from the pane the job recorded at launch.
 * Returns undefined when the job has no pane, or its tmux server has since restarted. */
export function jobTerminalId(jobId: string, jobsDir = path.join(getAgentDir(), "state", "background-jobs-v1", "jobs")): string | undefined {
  if (!/^job-[a-f0-9]{24}$/.test(jobId)) return undefined;
  try {
    const launch = JSON.parse(fs.readFileSync(path.join(jobsDir, jobId, "launch.json"), "utf8"));
    if (typeof launch.socketPath !== "string" || !/^%\d+$/.test(launch.paneId)
      || !Number.isSafeInteger(launch.serverPid) || typeof launch.serverStartToken !== "string") return undefined;
    const start = processStartTime(launch.serverPid);
    // A different start time means the pid now belongs to another process, so the pane is gone.
    if (!start || launch.serverStartToken !== `linux-proc:${start}`) return undefined;
    const socket = fs.realpathSync(launch.socketPath);
    const inode = fs.statSync(socket).ino;
    return paseoTerminalId(socket, `${launch.serverPid}:${start}:${inode}`, launch.paneId);
  } catch {
    return undefined;
  }
}
