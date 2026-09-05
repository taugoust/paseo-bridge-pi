import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

type Callbacks = {
  command(value: any): Promise<void>;
  attached(): void;
  detached(): void;
  error(error: unknown): void;
};

/** Socket ownership is independent of the replaceable extension context. */
export class BridgeTransport {
  private server: net.Server | null = null;
  private client: net.Socket | null = null;
  private callbacks?: Callbacks;
  private closed = false;

  readonly sessionFile: string;
  readonly pipePath: string;

  constructor(sessionFile: string, pipePath: string) {
    this.sessionFile = sessionFile;
    this.pipePath = pipePath;
  }

  get connected(): boolean { return Boolean(this.client && !this.client.destroyed); }

  bind(callbacks: Callbacks): void {
    this.callbacks = callbacks;
    if (this.connected) callbacks.attached();
  }

  suspend(): void { this.callbacks = undefined; }

  start(): void {
    if (process.platform !== "win32") {
      fs.mkdirSync(path.dirname(this.pipePath), { recursive: true, mode: 0o700 });
      try { fs.unlinkSync(this.pipePath); } catch {}
    }
    this.server = net.createServer((socket) => this.attach(socket));
    this.server.on("error", (error) => this.callbacks?.error(error));
    this.server.listen(this.pipePath, () => {
      if (process.platform !== "win32") {
        try { fs.chmodSync(this.pipePath, 0o600); } catch {}
      }
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
    if (process.platform !== "win32") {
      try { fs.unlinkSync(this.pipePath); } catch {}
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
