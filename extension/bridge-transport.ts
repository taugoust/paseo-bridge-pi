import * as net from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  decodePermissionGateOperatorFrame,
  handlePermissionGateOperatorRequest,
  permissionGateOperatorSocketPath,
  type PermissionGateOperatorIdentityV1,
} from "./permission-gate-operator.js";

type Callbacks = {
  command(value: any): Promise<void>;
  forkSnapshot?(): unknown;
  attached(): void;
  detached(): void;
  error(error: unknown): void;
  permissionGateOperator?(): PermissionGateOperatorIdentityV1 | undefined;
  harnessReadOnly?(request: unknown): Promise<unknown>;
};

/** Socket ownership is independent of the replaceable extension context. */
export class BridgeTransport {
  private server: net.Server | null = null;
  private snapshotServer: net.Server | null = null;
  private operatorServer: net.Server | null = null;
  private operatorSockets = new Set<net.Socket>();
  private readonlyServer: net.Server | null = null;
  private readonlySockets = new Set<net.Socket>();
  private client: net.Socket | null = null;
  private callbacks?: Callbacks;
  private closed = false;

  readonly sessionFile: string;
  readonly pipePath: string;
  /** Local-trust runtime capability; not a boundary against same-UID code. */
  private _operatorCapability?: string;
  private _operatorEpoch?: string;
  get operatorCapability(): string { return this._operatorCapability ??= randomBytes(32).toString("hex"); }
  get operatorEpoch(): string { return this._operatorEpoch ??= randomUUID(); }
  get harnessReadOnlyCapability(): string { return this._harnessReadOnlyCapability ??= randomBytes(32).toString("hex"); }
  private _harnessReadOnlyCapability?: string;
  rotateOperatorEpoch(): void { this._operatorEpoch = randomUUID(); this._harnessReadOnlyCapability = randomBytes(32).toString("hex"); }

  constructor(sessionFile: string, pipePath: string) {
    this.sessionFile = sessionFile;
    this.pipePath = pipePath;
  }

  get connected(): boolean { return Boolean(this.client && !this.client.destroyed); }

  bind(callbacks: Callbacks): void {
    this.rotateOperatorEpoch();
    this.callbacks = callbacks;
    if (this.server) {
      this.ensureForkSnapshotEndpoint();
      this.ensureOperatorEndpoint();
      this.ensureReadonlyEndpoint();
    }
    if (this.connected) callbacks.attached();
  }

  suspend(): void { this.callbacks = undefined; }

  start(): void {
    if (process.platform !== "win32") {
      fs.mkdirSync(path.dirname(this.pipePath), { recursive: true, mode: 0o700 });
      try { fs.unlinkSync(this.pipePath); } catch {}
    }
    this.ensureForkSnapshotEndpoint();
    this.ensureOperatorEndpoint();
    this.ensureReadonlyEndpoint();
    this.server = net.createServer((socket) => this.attach(socket));
    this.server.on("error", (error) => this.callbacks?.error(error));
    this.server.listen(this.pipePath, () => {
      if (process.platform !== "win32") {
        try { fs.chmodSync(this.pipePath, 0o600); } catch {}
      }
    });
  }

  private ensureOperatorEndpoint(): void {
    // A retained transport may predate this endpoint. Prototype replacement
    // during /reload does not run the new constructor/field initializers.
    this.operatorSockets ??= new Set<net.Socket>();
    if (this.operatorServer || this.closed) return;
    const operatorPath = permissionGateOperatorSocketPath(this.pipePath);
    if (process.platform !== "win32") {
      try { fs.unlinkSync(operatorPath); } catch {}
    }
    this.operatorServer = net.createServer((socket) => {
      if (this.operatorSockets.size >= 16 || this.closed) { socket.destroy(); return; }
      this.operatorSockets.add(socket);
      socket.on("close", () => this.operatorSockets.delete(socket));
      socket.on("error", (error) => this.callbacks?.error(error));
      socket.setTimeout(5_000, () => socket.destroy());
      let buffer = Buffer.alloc(0);
      let received = false;
      socket.on("data", (chunk: Buffer) => {
        if (received || buffer.length + chunk.length > 4097) { socket.destroy(); return; }
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        received = true;
        if (newline === 0 || newline > 4096 || newline !== buffer.length - 1) { socket.destroy(); return; }
        let response: Record<string, unknown>;
        try {
          const request = decodePermissionGateOperatorFrame(buffer.subarray(0, newline));
          const identity = this.callbacks?.permissionGateOperator?.();
          response = identity
            ? handlePermissionGateOperatorRequest(request, identity)
            : { v: 1, type: "permission_gate_mode", id: null, success: false, error: "Permission-gate operator unavailable" };
        } catch (error) {
          response = { v: 1, type: "permission_gate_mode", id: null, success: false,
            error: error instanceof Error ? error.message.slice(0, 500) : "Invalid permission-gate operator frame" };
        }
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
    this.operatorServer.on("error", (error) => this.callbacks?.error(error));
    this.operatorServer.listen(operatorPath, () => {
      if (process.platform !== "win32") {
        try { fs.chmodSync(operatorPath, 0o600); } catch {}
      }
    });
  }

  private ensureReadonlyEndpoint(): void {
    this.readonlySockets ??= new Set<net.Socket>();
    if (this.readonlyServer || this.closed) return;
    const socketPath = `${this.pipePath}.harness-readonly`;
    if (process.platform !== "win32") { try { fs.unlinkSync(socketPath); } catch {} }
    this.readonlyServer = net.createServer((socket) => {
      if (this.readonlySockets.size >= 16 || this.closed) { socket.destroy(); return; }
      this.readonlySockets.add(socket);
      socket.on("close", () => this.readonlySockets.delete(socket));
      socket.on("error", (error) => this.callbacks?.error(error));
      socket.setTimeout(5000, () => socket.destroy());
      let buffer = Buffer.alloc(0);
      let received = false;
      socket.on("data", (chunk: Buffer) => {
        if (received || buffer.length + chunk.length > 8192) { socket.destroy(); return; }
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        received = true;
        if (!newline || newline !== buffer.length - 1) { socket.destroy(); return; }
        void (async () => {
          let response: Record<string, unknown>;
          let requestId: string | null = null;
          let requestAgentId: string | null = null;
          let requestSessionId: string | null = null;
          let requestRuntimeEpoch: string | null = null;
          try {
            const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline)));
            const cb = this.callbacks?.harnessReadOnly;
            if (!request || typeof request !== "object" || request.v !== 1 || request.type !== "harness_readonly"
              || typeof request.id !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(request.id)
              || Object.keys(request).sort().join(",") !== "agentId,capability,id,method,payload,runtimeEpoch,sessionId,type,v"
              || typeof request.capability !== "string" || !/^[a-f0-9]{64}$/.test(request.capability)
              || typeof request.agentId !== "string" || typeof request.sessionId !== "string"
              || typeof request.runtimeEpoch !== "string" || typeof request.method !== "string"
              || !cb) throw new Error("Invalid or unavailable read-only request");
            requestId = request.id;
            requestAgentId = request.agentId;
            requestSessionId = request.sessionId;
            requestRuntimeEpoch = request.runtimeEpoch;
            const data = await cb(request);
            response = { v: 1, type: "harness_readonly", id: request.id, success: true,
              agentId: request.agentId, sessionId: request.sessionId, runtimeEpoch: request.runtimeEpoch, data };
          } catch (error) {
            response = { v: 1, type: "harness_readonly", id: requestId, success: false,
              error: error instanceof Error ? error.message.replace(/[\r\n\x00-\x1f\x7f]+/g, " ").slice(0, 300) : "Invalid read-only request" };
            if (requestAgentId && requestSessionId && requestRuntimeEpoch) Object.assign(response, {
              agentId: requestAgentId, sessionId: requestSessionId, runtimeEpoch: requestRuntimeEpoch,
            });
          }
          const frame = `${JSON.stringify(response)}\n`;
          if (Buffer.byteLength(frame) > 64 * 1024) socket.end(`${JSON.stringify({ v: 1, type: "harness_readonly", id: requestId, success: false,
            ...(requestAgentId && requestSessionId && requestRuntimeEpoch ? { agentId: requestAgentId, sessionId: requestSessionId, runtimeEpoch: requestRuntimeEpoch } : {}),
            error: "Oversized read-only result" })}\n`);
          else socket.end(frame);
        })().catch(() => socket.destroy());
      });
    });
    this.readonlyServer.on("error", (error) => this.callbacks?.error(error));
    this.readonlyServer.listen(socketPath, () => { if (process.platform !== "win32") { try { fs.chmodSync(socketPath, 0o600); } catch {} } });
  }

  private ensureForkSnapshotEndpoint(): void {
    if (this.snapshotServer || this.closed) return;
    // A separate read-only endpoint never takes over Paseo's controller socket.
    const snapshotPath = `${this.pipePath}.fork`;
    if (process.platform !== "win32") {
      try { fs.unlinkSync(snapshotPath); } catch {}
    }
    this.snapshotServer = net.createServer((socket) => {
      socket.on("error", (error) => this.callbacks?.error(error));
      let response;
      try {
        if (!this.callbacks?.forkSnapshot) throw new Error("Native fork snapshot unavailable; retry after bridge update");
        response = { type: "response", id: "fork-snapshot", success: true, data: this.callbacks.forkSnapshot() };
      } catch (error) {
        response = { type: "response", id: "fork-snapshot", success: false, error: String(error) };
      }
      socket.end(`${JSON.stringify(response)}\n`);
    });
    this.snapshotServer.on("error", (error) => this.callbacks?.error(error));
    this.snapshotServer.listen(snapshotPath, () => {
      if (process.platform !== "win32") { try { fs.chmodSync(snapshotPath, 0o600); } catch {} }
    });
  }

  send(value: unknown): void {
    if (!this.connected) return;
    try { this.client!.write(`${JSON.stringify(value)}\n`); }
    catch (error) { this.callbacks?.error(error); }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.suspend();
    this.client?.destroy();
    this.client = null;
    this.server?.close();
    this.server = null;
    this.snapshotServer?.close();
    this.snapshotServer = null;
    this.operatorServer?.close();
    this.operatorServer = null;
    this.readonlyServer?.close();
    this.readonlyServer = null;
    for (const socket of this.operatorSockets ?? []) socket.destroy();
    this.operatorSockets?.clear();
    for (const socket of this.readonlySockets ?? []) socket.destroy();
    this.readonlySockets?.clear();
    if (process.platform !== "win32") {
      try { fs.unlinkSync(this.pipePath); } catch {}
      try { fs.unlinkSync(`${this.pipePath}.fork`); } catch {}
      try { fs.unlinkSync(permissionGateOperatorSocketPath(this.pipePath)); } catch {}
      try { fs.unlinkSync(`${this.pipePath}.harness-readonly`); } catch {}
    }
  }

  private attach(socket: net.Socket): void {
    // Always own errors, including rejected secondary controllers.
    socket.on("error", (error) => { this.callbacks?.error(error); detach(); });
    const detach = () => {
      if (this.client !== socket) return;
      this.client = null;
      this.callbacks?.detached();
    };
    socket.on("close", detach);
    if (this.closed || this.client) {
      socket.end(`${JSON.stringify({ type: "response", id: null, command: "connect", success: false,
        error: "pi-paseo-bridge: another controller is already attached to this session" })}\n`);
      return;
    }
    this.client = socket;
    socket.setNoDelay(true);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let command: any;
        try { command = JSON.parse(line); }
        catch { continue; }
        if (!command || typeof command !== "object" || Array.isArray(command)) continue;
        const callbacks = this.callbacks;
        if (!callbacks) {
          this.send({ type: "response", id: command.id, command: command.type, success: false,
            error: "Pi runtime reload is in progress; retry after it completes." });
          continue;
        }
        void callbacks.command(command).catch((error) => callbacks.error(error));
      }
    });
    this.callbacks?.attached();
  }
}

type RetainedBridge = {
  transport: BridgeTransport;
  agentId: string | null;
  titleAttempted: boolean;
  timer: ReturnType<typeof setTimeout>;
};
const RELOAD_BRIDGE_KEY = "__piPaseoReloadTransportV1";

/** Same-process, same-session handoff only; never leave a disabled bridge forever. */
export function retainBridgeForReload(
  transport: BridgeTransport,
  agentId: string | null,
  titleAttempted: boolean,
  timeoutMs = 90_000,
): void {
  discardRetainedBridge();
  transport.suspend();
  const root = globalThis as Record<string, unknown>;
  const retained: RetainedBridge = {
    transport, agentId, titleAttempted,
    timer: setTimeout(() => {
      if (root[RELOAD_BRIDGE_KEY] === retained) discardRetainedBridge();
    }, timeoutMs),
  };
  retained.timer.unref?.();
  root[RELOAD_BRIDGE_KEY] = retained;
}

export function takeBridgeAfterReload(sessionFile: string | undefined): Omit<RetainedBridge, "timer"> | undefined {
  const root = globalThis as Record<string, unknown>;
  const retained = root[RELOAD_BRIDGE_KEY] as RetainedBridge | undefined;
  if (!retained) return undefined;
  if (retained.transport.sessionFile !== sessionFile) {
    discardRetainedBridge();
    return undefined;
  }
  delete root[RELOAD_BRIDGE_KEY];
  clearTimeout(retained.timer);
  // A retained pre-snapshot transport has the old module's prototype. Upgrade
  // methods in place, preserving its live controller/server; bind() adds only
  // the new read-only endpoint and close() owns its cleanup.
  Object.setPrototypeOf(retained.transport, BridgeTransport.prototype);
  return { transport: retained.transport, agentId: retained.agentId, titleAttempted: retained.titleAttempted };
}

export function discardRetainedBridge(): void {
  const root = globalThis as Record<string, unknown>;
  const retained = root[RELOAD_BRIDGE_KEY] as RetainedBridge | undefined;
  if (!retained) return;
  delete root[RELOAD_BRIDGE_KEY];
  clearTimeout(retained.timer);
  retained.transport.close();
}
