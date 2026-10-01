import { createHash, randomUUID } from "node:crypto";
import { constants, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { StringDecoder } from "node:string_decoder";

export type ForegroundTasksDescriptor = { version: 1; socketPath: string; capability: string; agentId: string; sessionId: string; runtimeEpoch: string; serviceEpoch: string };
export function foregroundTasksDescriptorPath(agentId: string, baseDir = join(homedir(), ".pi", "paseo-bridge")) {
  return join(baseDir, "operators", `${createHash("sha256").update(agentId).digest("hex")}.foreground.json`);
}
// Use SHA-256 hex filename exactly as the bridge does.
export async function readForegroundTasksDescriptor(agentId: string, baseDir = join(homedir(), ".pi", "paseo-bridge")): Promise<unknown> {
  if (!agentId || agentId.length > 256) return undefined;
  try {
    const directoryPath = join(baseDir, "operators"), directory = await lstat(directoryPath);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (typeof process.getuid === "function" && directory.uid !== process.getuid()) || (directory.mode & 0o777) !== 0o700) return undefined;
    const target = foregroundTasksDescriptorPath(agentId, baseDir);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) return undefined;
      return JSON.parse(await handle.readFile("utf8")) as unknown;
    } finally { await handle.close(); }
  } catch { return undefined; }
}

export function validateForegroundTasksDescriptor(value: unknown, agentId: string): value is ForegroundTasksDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  return Object.keys(d).sort().join(",") === "agentId,capability,runtimeEpoch,serviceEpoch,sessionId,socketPath,version"
    && d.version === 1 && d.agentId === agentId && typeof d.socketPath === "string" && d.socketPath.startsWith("/") && d.socketPath.length <= 4096
    && typeof d.capability === "string" && /^[a-f0-9]{64}$/.test(d.capability)
    && typeof d.sessionId === "string" && d.sessionId.length > 0 && d.sessionId.length <= 256
    && typeof d.runtimeEpoch === "string" && /^[a-f0-9-]{36}$/.test(d.runtimeEpoch)
    && typeof d.serviceEpoch === "string" && d.serviceEpoch.length > 0 && d.serviceEpoch.length <= 256;
}

export function callForegroundTasks(descriptor: ForegroundTasksDescriptor, request: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
  const id = randomUUID();
  const frame = `${JSON.stringify({ v: 1, type: "foreground_tasks", id, capability: descriptor.capability,
    agentId: descriptor.agentId, sessionId: descriptor.sessionId, runtimeEpoch: descriptor.runtimeEpoch,
    request: { ...request, sessionId: descriptor.sessionId, epoch: descriptor.serviceEpoch } })}\n`;
  if (Buffer.byteLength(frame) > 512 * 1024) throw new Error("Oversized foreground-task request");
  return new Promise((resolve, reject) => {
    let socket: ReturnType<typeof connect> | undefined, settled = false, buffer = "";
    const decoder = new StringDecoder("utf8");
    const timer = setTimeout(() => finish(new Error("Foreground-task request timed out")), timeoutMs);
    const finish = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); socket?.destroy(); error ? reject(error) : resolve(value); };
    void (async () => {
      try {
        const stat = await lstat(descriptor.socketPath);
        if (!stat.isSocket() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o777) !== 0o600) throw new Error("Foreground-task socket is not private");
        socket = connect(descriptor.socketPath);
        socket.setTimeout(timeoutMs, () => finish(new Error("Foreground-task request timed out")));
        socket.once("error", error => finish(error));
        socket.once("connect", () => socket!.write(frame));
        socket.on("data", chunk => {
          buffer += decoder.write(chunk);
          if (Buffer.byteLength(buffer, "utf8") > 256 * 1024) { finish(new Error("Oversized foreground-task response")); return; }
          const newline = buffer.indexOf("\n"); if (newline < 0) return;
          try {
            if (newline !== buffer.length - 1) throw new Error("Unexpected foreground-task response framing");
            const response = JSON.parse(buffer.slice(0, newline));
            if (!response || response.v !== 1 || response.type !== "foreground_tasks" || response.id !== id || typeof response.success !== "boolean") throw new Error("Invalid foreground-task response");
            if (!response.success) throw new Error(typeof response.error === "string" ? response.error : "Foreground-task request rejected");
            if (response.agentId !== descriptor.agentId || response.sessionId !== descriptor.sessionId || response.runtimeEpoch !== descriptor.runtimeEpoch) throw new Error("Foreground-task identity mismatch");
            finish(undefined, response.data);
          } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        });
        socket.once("end", () => { buffer += decoder.end(); if (!settled) finish(new Error("Foreground-task bridge closed without response")); });
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    })();
  });
}
