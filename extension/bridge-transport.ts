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
};

/** Socket ownership is independent of the replaceable extension context. */
export class BridgeTransport {
  private server: net.Server | null = null;
  private snapshotServer: net.Server | null = null;
  private operatorServer: net.Server | null = null;
  private operatorSockets = new Set<net.Socket>();
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
  rotateOperatorEpoch(): void { this._operatorEpoch = randomUUID(); }

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
    this.server = net.createServer((socket) => this.attach(socket));
    this.server.on("error", (error) => this.callbacks?.error(error));
    this.server.listen(this.pipePath, () => {
      if (process.platform !== "win32") {
        try { fs.chmodSync(this.pipePath, 0o600); } catch {}
      }
    });
  }

  private ensureOperatorEndpoint(): void {
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
    for (const socket of this.operatorSockets) socket.destroy();
    this.operatorSockets.clear();
    if (process.platform !== "win32") {
      try { fs.unlinkSync(this.pipePath); } catch {}
      try { fs.unlinkSync(`${this.pipePath}.fork`); } catch {}
      try { fs.unlinkSync(permissionGateOperatorSocketPath(this.pipePath)); } catch {}
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
