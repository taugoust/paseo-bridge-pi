import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { lstat } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import type { PermissionGateDescriptor, PermissionGateWireResponse } from "../shared/wire.ts";
import { validateWireResponse } from "../shared/wire.ts";

export function callOperator(descriptor: PermissionGateDescriptor, action: "status" | "set", enabled?: boolean, timeoutMs = 3000): Promise<boolean> {
  const id = randomUUID();
  const request = {
    v: 1, type: "permission_gate_mode", id,
    capability: descriptor.capability,
    agentId: descriptor.agentId,
    sessionId: descriptor.sessionId,
    runtimeEpoch: descriptor.runtimeEpoch,
    action,
    ...(action === "set" ? { enabled } : {}),
  };
  return new Promise((resolve, reject) => {
    let socket: ReturnType<typeof connect> | undefined;
    let settled = false;
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    const deadline = setTimeout(() => finish(new Error("Permission operator timed out")), timeoutMs);
    const finish = (error?: Error, value?: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket?.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    void (async () => {
      try {
        const stat = await lstat(descriptor.socketPath);
        if (!stat.isSocket() || (typeof process.getuid === "function" && stat.uid !== process.getuid())
          || (stat.mode & 0o777) !== 0o600) throw new Error("Permission operator socket is not private");
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); return; }
      try { socket = connect(descriptor.socketPath); }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))); return; }
      socket.setTimeout(timeoutMs, () => finish(new Error("Permission operator timed out")));
      socket.once("error", (error) => finish(error));
      socket.once("connect", () => socket!.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk) => {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer, "utf8") > 4096) return finish(new Error("Oversized permission operator response"));
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          if (newline !== buffer.length - 1) throw new Error("Unexpected trailing permission operator response data");
          const response = JSON.parse(buffer.slice(0, newline)) as PermissionGateWireResponse;
          if (!validateWireResponse(response, id, descriptor)) throw new Error("Invalid permission operator response");
          if (!response.success) throw new Error(response.error ?? "Permission operator rejected request");
          finish(undefined, response.data!.enabled);
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      });
      socket.once("end", () => {
        buffer += decoder.end();
        if (!settled) finish(new Error("Permission operator closed without a complete response"));
      });
      socket.once("close", () => {
        if (!settled) finish(new Error("Permission operator connection closed before response"));
      });
    })().catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}
