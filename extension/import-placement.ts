import { createHash } from "node:crypto";

type Placement = { tmuxSocket?: string; tmuxServerId?: string; tmuxWindowId?: string };

export function workspaceIdForPlacement(placement: Placement): string {
  const { tmuxSocket, tmuxServerId, tmuxWindowId } = placement;
  if (!tmuxSocket || !tmuxServerId || !/^@\d+$/.test(tmuxWindowId ?? "")) {
    throw new Error("Current tmux workspace identity is unavailable; refusing a topology import without --workspace-id");
  }
  return `wks_tmux_${createHash("sha256").update(JSON.stringify([tmuxSocket, tmuxServerId, tmuxWindowId])).digest("hex").slice(0, 24)}`;
}

export function paseoImportArgs(input: {
  sessionFile: string; cwd: string; host?: string; topology: boolean; placement: Placement;
}): string[] {
  return ["import", "--provider", "pi", input.sessionFile, "--cwd", input.cwd, "--json",
    ...(input.topology ? ["--workspace-id", workspaceIdForPlacement(input.placement)] : []),
    ...(input.host ? ["--host", input.host] : [])];
}

/** Workspace rejection happens before import allocation. Do not retry unknown
 * CLI failures or ambiguous successful responses that may already have imported. */
export function retryableWorkspaceImportFailure(code: number | null, output: string): boolean {
  return code !== null && code !== 0 && /\bworkspace\b|\bwks_tmux_/i.test(output);
}

export function importRetryDelay(failures: number): number | undefined {
  return failures >= 1 && failures <= 5 ? Math.min(2000 * 2 ** (failures - 1), 30000) : undefined;
}
