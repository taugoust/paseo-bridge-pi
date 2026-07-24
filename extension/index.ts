// pi-paseo-bridge: makes terminal-started pi TUI sessions visible and
// steerable in Paseo without modifying Paseo.
//
// How it works: this extension runs inside the TUI process, opens a named
// pipe (Windows) / unix socket keyed on the session file path, and speaks
// pi's RPC JSONL dialect on it - the same dialect `pi --mode rpc` speaks on
// stdio. The companion shim (shim/pi-paseo-shim.js), configured as Paseo's
// pi provider command, connects Paseo's stdio to this pipe when the session
// has a live TUI, and falls through to the real pi otherwise.
//
// It also registers the session with the Paseo daemon (`paseo import`) on
// session start, which causes Paseo to spawn the shim and attach.
import * as net from "node:net";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Markers and command names must match Paseo's pi adapter
// (@getpaseo/server dist/server/server/agent/providers/pi/agent.js).
const ENTRY_CAPTURE_MARKER = "PASEO_ENTRY_CAPTURE";
const COMMAND_RESULT_MARKER = "PASEO_COMMAND_RESULT";
const CAPTURE_COMMAND = "paseo_capture_entries";
const TREE_COMMAND = "paseo_tree";

// Keep in sync with shim/pi-paseo-shim.js (pipePathForSession).
function pipePathForSession(sessionFile: string): string {
  let normalized = path.resolve(sessionFile);
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 20);
  if (process.platform === "win32") return `\\\\.\\pipe\\pi-paseo-bridge-${hash}`;
  const dir = process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, "pi-paseo")
    : path.join(os.homedir(), ".pi", "paseo-bridge");
  return path.join(dir, `${hash}.sock`);
}

const DEBUG = ["1", "true", "on"].includes((process.env.PI_PASEO_BRIDGE_DEBUG ?? "").toLowerCase());
const debugLogFile = path.join(os.homedir(), ".pi", "paseo-bridge", "debug.log");

function debugLog(message: string): void {
  if (!DEBUG) return;
  try {
    fs.mkdirSync(path.dirname(debugLogFile), { recursive: true });
    fs.appendFileSync(debugLogFile, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // never let logging break the TUI
  }
}

function decodeCommandPayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw.trim(), "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n");
}

function resolvePaseoCli(): string | null {
  const override = process.env.PASEO_CLI;
  if (override && fs.existsSync(override)) return override;
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["paseo.cmd", "paseo.bat", "paseo.exe", "paseo"] : ["paseo"];
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep scanning
      }
    }
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const desktop = path.join(process.env.LOCALAPPDATA, "Programs", "Paseo", "resources", "bin", "paseo.cmd");
    if (fs.existsSync(desktop)) return desktop;
  }
  return null;
}

function runPaseoCli(cli: string, args: string[], onDone: (code: number | null, output: string) => void): void {
  let child;
  if (process.platform === "win32" && !cli.endsWith(".exe")) {
    // Node refuses to spawn .cmd files without a shell; go through cmd.exe
    // with /s so the outer quotes survive.
    const quoted = [cli, ...args].map((a) => `"${a.replaceAll('"', '""')}"`).join(" ");
    child = spawn("cmd.exe", ["/d", "/s", "/c", `"${quoted}"`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  } else {
    child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"] });
  }
  let output = "";
  child.stdout?.on("data", (chunk) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk) => (output += chunk.toString()));
  const timer = setTimeout(() => child.kill(), 20000);
  child.on("error", (err) => {
    clearTimeout(timer);
    onDone(null, String(err));
  });
  child.on("exit", (code) => {
    clearTimeout(timer);
    onDone(code, output);
  });
}

export default function piPaseoBridge(pi: ExtensionAPI) {
  if (["0", "off", "false"].includes((process.env.PI_PASEO_BRIDGE ?? "").toLowerCase())) return;

  let server: net.Server | null = null;
  let client: net.Socket | null = null;
  let currentSessionFile: string | null = null;
  let currentPipePath: string | null = null;
  let latestCtx: ExtensionContext | null = null;
  let isCompacting = false;
  let autoCompactionEnabled = true;
  const importAttempted = new Set<string>();

  function send(obj: unknown): void {
    if (!client || client.destroyed) return;
    try {
      client.write(`${JSON.stringify(obj)}\n`);
    } catch (err) {
      debugLog(`send failed: ${String(err)}`);
    }
  }

  function notifyEvent(message: string): void {
    send({
      type: "extension_ui_request",
      id: crypto.randomUUID(),
      method: "notify",
      message,
      notifyType: "info",
    });
  }

  function capturedUserEntries(ctx: ExtensionContext): Array<{ id: string; parentId: string | null; text: string }> {
    return ctx.sessionManager
      .getEntries()
      .filter((entry: any) => entry.type === "message" && entry.message?.role === "user")
      .map((entry: any) => ({
        id: entry.id,
        parentId: entry.parentId ?? null,
        text: readTextContent(entry.message.content),
      }));
  }

  function emitEntryCapture(ctx: ExtensionContext | null, reason: string, requestId?: string): void {
    if (!ctx) return;
    try {
      const entries = capturedUserEntries(ctx);
      notifyEvent(`${ENTRY_CAPTURE_MARKER} ${JSON.stringify({ reason, requestId, entries })}`);
    } catch (err) {
      debugLog(`entry capture failed: ${String(err)}`);
    }
  }

  function emitCommandResult(requestId: string, result: { ok: boolean; result?: unknown; error?: string }): void {
    notifyEvent(`${COMMAND_RESULT_MARKER} ${JSON.stringify({ requestId, ...result })}`);
  }

  const success = (id: unknown, command: string, data?: unknown) => ({
    type: "response",
    id,
    command,
    success: true,
    ...(data !== undefined ? { data } : {}),
  });
  const failure = (id: unknown, command: string, error: string) => ({
    type: "response",
    id,
    command,
    success: false,
    error,
  });

  function buildState(): Record<string, unknown> {
    const ctx = latestCtx;
    const sm = ctx?.sessionManager;
    const messageCount = sm ? sm.getEntries().filter((e: any) => e.type === "message").length : 0;
    return {
      model: ctx?.model ?? null,
      thinkingLevel: pi.getThinkingLevel(),
      isStreaming: ctx ? !ctx.isIdle() : false,
      isCompacting,
      sessionFile: sm?.getSessionFile(),
      sessionId: sm?.getSessionId(),
      sessionName: sm?.getSessionName(),
      autoCompactionEnabled,
      messageCount,
      pendingMessageCount: ctx?.hasPendingMessages() ? 1 : 0,
      contextUsage: ctx?.getContextUsage(),
    };
  }

  function handlePrompt(cmd: any): void {
    const message: string = typeof cmd.message === "string" ? cmd.message : "";
    if (message.startsWith(`/${CAPTURE_COMMAND}`)) {
      const payload = decodeCommandPayload(message.slice(CAPTURE_COMMAND.length + 1));
      emitEntryCapture(latestCtx, "command", typeof payload?.requestId === "string" ? payload.requestId : undefined);
      send(success(cmd.id, "prompt"));
      return;
    }
    if (message.startsWith(`/${TREE_COMMAND}`)) {
      const payload = decodeCommandPayload(message.slice(TREE_COMMAND.length + 1));
      if (typeof payload?.requestId === "string") {
        emitCommandResult(payload.requestId, {
          ok: false,
          error: "Timeline rewind is not supported for terminal-attached pi sessions",
        });
      }
      send(success(cmd.id, "prompt"));
      return;
    }
    const content = Array.isArray(cmd.images) && cmd.images.length > 0
      ? [{ type: "text", text: message }, ...cmd.images]
      : message;
    const streaming = latestCtx ? !latestCtx.isIdle() : false;
    pi.sendUserMessage(content as any, streaming ? { deliverAs: "followUp" } : undefined);
    send(success(cmd.id, "prompt", { agentInvoked: true }));
  }

  async function handleCommand(cmd: any): Promise<void> {
    const id = cmd.id;
    const type: string = cmd.type;
    try {
      switch (type) {
        case "prompt":
          handlePrompt(cmd);
          return;
        case "steer":
          pi.sendUserMessage(cmd.message, { deliverAs: "steer" });
          send(success(id, type));
          return;
        case "follow_up":
          pi.sendUserMessage(cmd.message, { deliverAs: "followUp" });
          send(success(id, type));
          return;
        case "abort":
          latestCtx?.abort();
          send(success(id, type));
          return;
        case "get_state":
          send(success(id, type, buildState()));
          return;
        case "get_messages": {
          const entries = latestCtx?.sessionManager.buildContextEntries() ?? [];
          const messages = entries.filter((e: any) => e.type === "message").map((e: any) => e.message);
          send(success(id, type, { messages }));
          return;
        }
        case "get_available_models":
          send(success(id, type, { models: latestCtx?.modelRegistry.getAvailable() ?? [] }));
          return;
        case "set_model": {
          const model = latestCtx?.modelRegistry.find(cmd.provider, cmd.modelId);
          if (!model) {
            send(failure(id, type, `Model not found: ${cmd.provider}/${cmd.modelId}`));
            return;
          }
          const ok = await pi.setModel(model);
          if (!ok) {
            send(failure(id, type, `No API key available for ${cmd.provider}/${cmd.modelId}`));
            return;
          }
          send(success(id, type, model));
          return;
        }
        case "set_thinking_level":
          pi.setThinkingLevel(cmd.level);
          send(success(id, type));
          return;
        case "get_session_stats":
          send(success(id, type, { contextUsage: latestCtx?.getContextUsage() }));
          return;
        case "get_commands":
          send(success(id, type, { commands: pi.getCommands() }));
          return;
        case "compact":
          latestCtx?.compact(cmd.customInstructions ? { customInstructions: cmd.customInstructions } : undefined);
          send(success(id, type));
          return;
        case "set_auto_compaction":
          autoCompactionEnabled = Boolean(cmd.enabled);
          send(success(id, type));
          return;
        case "extension_ui_response":
          // v1: extension UI dialogs render in the TUI only; nothing pending here.
          return;
        default:
          send(failure(id, type ?? "unknown", `Unsupported command for terminal-attached session: ${type}`));
      }
    } catch (err) {
      debugLog(`command ${type} failed: ${String(err)}`);
      send(failure(id, type ?? "unknown", err instanceof Error ? err.message : String(err)));
    }
  }

  function attachClient(socket: net.Socket): void {
    client = socket;
    socket.setNoDelay?.(true);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          debugLog(`ignoring non-JSON line from client: ${line.slice(0, 200)}`);
          continue;
        }
        void handleCommand(parsed);
      }
    });
    const detach = () => {
      if (client === socket) client = null;
      debugLog("client disconnected");
    };
    socket.on("close", detach);
    socket.on("error", (err) => {
      debugLog(`client socket error: ${String(err)}`);
      detach();
    });
    debugLog("client connected");
    // Prime Paseo's user-entry capture, mirroring what its injected
    // extension does on session_start.
    emitEntryCapture(latestCtx, "session_start");
  }

  function stopServer(): void {
    if (client) {
      try {
        client.destroy();
      } catch {
        // already gone
      }
      client = null;
    }
    if (server) {
      try {
        server.close();
      } catch {
        // already closed
      }
      server = null;
    }
    if (currentPipePath && process.platform !== "win32") {
      try {
        fs.unlinkSync(currentPipePath);
      } catch {
        // absent - fine
      }
    }
    currentPipePath = null;
    currentSessionFile = null;
  }

  function startServer(sessionFile: string): void {
    const pipePath = pipePathForSession(sessionFile);
    if (process.platform !== "win32") {
      fs.mkdirSync(path.dirname(pipePath), { recursive: true, mode: 0o700 });
      try {
        fs.unlinkSync(pipePath);
      } catch {
        // no stale socket
      }
    }
    const srv = net.createServer((socket) => {
      if (client) {
        try {
          socket.write(
            `${JSON.stringify({
              type: "response",
              id: null,
              command: "connect",
              success: false,
              error: "pi-paseo-bridge: another controller is already attached to this session",
            })}\n`,
          );
        } catch {
          // best effort
        }
        socket.destroy();
        return;
      }
      attachClient(socket);
    });
    srv.on("error", (err) => {
      debugLog(`server error: ${String(err)}`);
    });
    srv.listen(pipePath, () => {
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(pipePath, 0o600);
        } catch {
          // best effort
        }
      }
      debugLog(`listening on ${pipePath} for ${sessionFile}`);
    });
    server = srv;
    currentPipePath = pipePath;
    currentSessionFile = sessionFile;
  }

  function registerWithPaseo(sessionFile: string, cwd: string): void {
    if (process.env.PI_PASEO_BRIDGE_NO_IMPORT) return;
    if (importAttempted.has(sessionFile)) return;
    importAttempted.add(sessionFile);
    const cli = resolvePaseoCli();
    if (!cli) {
      debugLog("paseo CLI not found; session will not auto-appear (set PASEO_CLI)");
      return;
    }
    const args = ["import", "--provider", "pi", sessionFile, "--cwd", cwd, "--json"];
    if (process.env.PASEO_HOST) args.push("--host", process.env.PASEO_HOST);
    runPaseoCli(cli, args, (code, output) => {
      debugLog(`paseo import exited ${code}: ${output.slice(0, 500)}`);
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    try {
      const force = ["1", "true", "on"].includes((process.env.PI_PASEO_BRIDGE_FORCE ?? "").toLowerCase());
      if (ctx.mode !== "tui" && !force) return;
      const file = ctx.sessionManager.getSessionFile();
      if (!file) return; // ephemeral session
      if (file !== currentSessionFile) {
        stopServer();
        startServer(file);
      }
      registerWithPaseo(file, ctx.cwd);
    } catch (err) {
      debugLog(`session_start failed: ${String(err)}`);
    }
  });

  pi.on("session_shutdown", async () => {
    stopServer();
  });

  const forwardEvents = [
    "agent_start",
    "turn_start",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "agent_end",
  ] as const;
  for (const eventName of forwardEvents) {
    (pi as any).on(eventName, async (event: unknown, ctx: ExtensionContext) => {
      latestCtx = ctx;
      send(event);
    });
  }

  pi.on("turn_end", async (event, ctx) => {
    latestCtx = ctx;
    send(event);
    emitEntryCapture(ctx, "turn_end");
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    latestCtx = ctx;
    isCompacting = true;
    send({ type: "compaction_start" });
    return undefined;
  });

  pi.on("session_compact", async (event: any, ctx) => {
    latestCtx = ctx;
    isCompacting = false;
    send({ type: "compaction_end", ...(event?.entry ? { entry: event.entry } : {}) });
  });
}
