import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { lstat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export type HarnessReadOnlyDescriptor = { version: 1; socketPath: string; capability: string; agentId: string; sessionId: string; runtimeEpoch: string };
export function validateHarnessReadOnlyDescriptor(value: unknown, agentId: string): value is HarnessReadOnlyDescriptor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  return Object.keys(d).sort().join(",") === "agentId,capability,runtimeEpoch,sessionId,socketPath,version"
    && d.version === 1 && d.agentId === agentId && typeof d.socketPath === "string" && d.socketPath.startsWith("/") && d.socketPath.length <= 4096
    && typeof d.capability === "string" && /^[a-f0-9]{64}$/.test(d.capability)
    && typeof d.sessionId === "string" && d.sessionId.length > 0 && d.sessionId.length <= 256
    && typeof d.runtimeEpoch === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(d.runtimeEpoch);
}

export async function callHarnessReadOnly(descriptor: HarnessReadOnlyDescriptor, method: string, payload: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
  const id = randomUUID();
  const frame = `${JSON.stringify({ v: 1, type: "harness_readonly", id, capability: descriptor.capability, agentId: descriptor.agentId,
    sessionId: descriptor.sessionId, runtimeEpoch: descriptor.runtimeEpoch, method, payload })}\n`;
  if (Buffer.byteLength(frame) > 8192) throw new Error("Oversized read-only request");
  return await new Promise((resolve, reject) => {
    let socket: ReturnType<typeof connect> | undefined, settled = false, buffer = "";
    const decoder = new StringDecoder("utf8");
    const timer = setTimeout(() => finish(new Error("Read-only harness request timed out")), timeoutMs);
    const finish = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); socket?.destroy(); error ? reject(error) : resolve(value); };
    void (async () => {
      try {
        const stat = await lstat(descriptor.socketPath);
        if (!stat.isSocket() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o777) !== 0o600) throw new Error("Read-only harness socket is not private");
        socket = connect(descriptor.socketPath);
        socket.setTimeout(timeoutMs, () => finish(new Error("Read-only harness request timed out")));
        socket.once("error", error => finish(error));
        socket.once("connect", () => socket!.write(frame));
        socket.on("data", chunk => {
          buffer += decoder.write(chunk);
          if (Buffer.byteLength(buffer, "utf8") > 64 * 1024) { finish(new Error("Oversized read-only harness response")); return; }
          const newline = buffer.indexOf("\n"); if (newline < 0) return;
          try {
            if (newline !== buffer.length - 1) throw new Error("Unexpected read-only response framing");
            const response = JSON.parse(buffer.slice(0, newline));
            if (!response || response.v !== 1 || response.type !== "harness_readonly" || response.id !== id || typeof response.success !== "boolean") throw new Error("Invalid read-only harness response");
            if (!response.success) throw new Error(typeof response.error === "string" ? response.error : "Read-only harness rejected request");
            if (response.agentId !== descriptor.agentId || response.sessionId !== descriptor.sessionId || response.runtimeEpoch !== descriptor.runtimeEpoch) throw new Error("Read-only harness identity mismatch");
            finish(undefined, response.data);
          } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        });
        socket.once("end", () => { buffer += decoder.end(); if (!settled) finish(new Error("Read-only harness closed without response")); });
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    })();
  });
}
