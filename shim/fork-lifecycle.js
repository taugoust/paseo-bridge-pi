import { execFile } from "node:child_process";
import { findForkRuntimeRecord, killForkPaneForAgent } from "./tmux-fork.js";

const DEFAULT_ARCHIVE_POLL_INTERVAL_MS = 5_000;

export function parseAgentArchived(output) {
  try {
    const value = JSON.parse(output);
    return value?.Archived === true;
  } catch {
    return null;
  }
}

export function inspectAgentArchived(agentId, options = {}) {
  const run = options.execFile ?? execFile;
  const cli = options.paseoCli ?? (process.env.PASEO_CLI?.trim() || "paseo");
  return new Promise((resolve) => {
    run(cli, ["agent", "inspect", agentId, "--json"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(parseAgentArchived(stdout));
    });
  });
}

export async function reconcileForkArchive(agentId, options = {}) {
  const record = (options.findRuntimeRecord ?? findForkRuntimeRecord)(agentId);
  if (!record) return "not-fork";
  const archived = await (options.inspectArchived ?? inspectAgentArchived)(agentId, options);
  if (archived !== true) return archived === false ? "active" : "unavailable";
  return (options.killForkPane ?? killForkPaneForAgent)(agentId, { ...options, runtimeRecord: record })
    ? "killed"
    : "stale";
}

export function startForkArchiveMonitor(agentId, options = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_ARCHIVE_POLL_INTERVAL_MS;
  let stopped = false;
  let timer = null;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(poll, intervalMs);
    timer.unref?.();
  };
  const poll = async () => {
    if (stopped) return;
    const result = await reconcileForkArchive(agentId, options);
    if (result === "killed") {
      stopped = true;
      options.onKilled?.();
      return;
    }
    schedule();
  };
  schedule();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
