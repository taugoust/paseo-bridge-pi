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
import { fileURLToPath } from "node:url";
import { completeSimple } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { abortAndWaitForIdle } from "./abort-dispatch.js";
import { dispatchPaseoPrompt } from "./prompt-dispatch.js";
import { coordinateMirroredSelect } from "./mirrored-select.js";
import { normalizePiEventForPaseo } from "./tool-result-normalization.js";
import { SubagentTaskProjection, projectSubagentMessages } from "./subagent-task-projection.js";

type RemoteUiSelectOptions = { signal?: AbortSignal };
type RemoteUiBridgeV1 = {
  isConnected(): boolean;
  select(title: string, options: string[], settings?: RemoteUiSelectOptions): Promise<string | undefined>;
  selectMirrored?(
    title: string,
    options: string[],
    localSelect: (signal: AbortSignal) => Promise<string | undefined>,
    settings?: RemoteUiSelectOptions,
  ): Promise<string | undefined>;
};
type PendingRemoteUiRequest = {
  resolve(value: string | undefined): void;
  signal?: AbortSignal;
  abort?: () => void;
};

const REMOTE_UI_BRIDGE_KEY = "__piPaseoRemoteUiV1";

// Markers and command names must match Paseo's pi adapter
// (@getpaseo/server dist/server/server/agent/providers/pi/agent.js).
const ENTRY_CAPTURE_MARKER = "PASEO_ENTRY_CAPTURE";
const SUBMITTED_USER_ENTRY_MARKER = "PASEO_SUBMITTED_USER_ENTRY";
const COMMAND_RESULT_MARKER = "PASEO_COMMAND_RESULT";
const CAPTURE_COMMAND = "paseo_capture_entries";
const TREE_COMMAND = "paseo_tree";

// Keep in sync with shim/pi-paseo-shim.js (pipePathForSession). A TUI
// created for an existing Paseo agent uses a stable agent socket because its
// session file does not exist until the fork prompt has been intercepted.
function pipePathForSession(sessionFile: string): string {
  const assignedSocket = process.env.PI_PASEO_AGENT_SOCKET?.trim();
  if (assignedSocket) return assignedSocket;
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

const bridgeSettingsFile = path.join(os.homedir(), ".pi", "paseo-bridge", "settings.json");

function readBridgeSettings(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(bridgeSettingsFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeBridgeSettings(patch: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(bridgeSettingsFile), { recursive: true });
  fs.writeFileSync(bridgeSettingsFile, `${JSON.stringify({ ...readBridgeSettings(), ...patch }, null, 2)}\n`);
}

function isAutoEnabled(): boolean {
  return readBridgeSettings().auto !== false;
}

function bridgeShimPath(): string {
  // extension/index.ts lives in <package root>/extension/
  let here: string;
  try {
    here = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    here = __dirname;
  }
  return path.join(path.dirname(here), "shim", "pi-paseo-shim.js");
}

const paseoConfigFile = path.join(os.homedir(), ".paseo", "config.json");

function readPaseoPassword(): string | null {
  const inline = process.env.PASEO_PASSWORD?.trim();
  if (inline) return inline;
  const passwordFile = process.env.PASEO_PASSWORD_FILE?.trim();
  if (!passwordFile) return null;
  try {
    const password = fs.readFileSync(passwordFile, "utf8").trim();
    return password || null;
  } catch (err) {
    debugLog(`could not read Paseo password file: ${String(err)}`);
    return null;
  }
}

function isOurShimCommand(command: unknown): boolean {
  return (
    Array.isArray(command) &&
    command.some(
      (part) => typeof part === "string" && part.replaceAll("\\", "/").toLowerCase().endsWith("/shim/pi-paseo-shim.js"),
    )
  );
}

// Returns a user-facing result message. Throws only on unreadable JSON.
function installShimIntoPaseoConfig(): { ok: boolean; message: string } {
  const config = fs.existsSync(paseoConfigFile) ? JSON.parse(fs.readFileSync(paseoConfigFile, "utf8")) : {};
  config.agents = config.agents ?? {};
  config.agents.providers = config.agents.providers ?? {};
  const current = config.agents.providers.pi?.command;
  if (isOurShimCommand(current)) {
    return { ok: true, message: "Paseo shim already installed" };
  }
  if (current) {
    return {
      ok: false,
      message: `Paseo config already overrides the pi provider command (${JSON.stringify(current)}). Remove agents.providers.pi.command from ~/.paseo/config.json first.`,
    };
  }
  config.agents.providers.pi = {
    ...(config.agents.providers.pi ?? {}),
    command: [process.execPath.replaceAll("\\", "/"), bridgeShimPath().replaceAll("\\", "/")],
  };
  fs.mkdirSync(path.dirname(paseoConfigFile), { recursive: true });
  fs.writeFileSync(paseoConfigFile, `${JSON.stringify(config, null, 2)}\n`);
  return { ok: true, message: "Paseo shim installed. Restart the Paseo daemon to apply: paseo restart" };
}

function uninstallShimFromPaseoConfig(): { ok: boolean; message: string } {
  if (!fs.existsSync(paseoConfigFile)) return { ok: true, message: "Paseo shim was not installed" };
  const config = JSON.parse(fs.readFileSync(paseoConfigFile, "utf8"));
  const piProvider = config?.agents?.providers?.pi;
  if (!piProvider || !piProvider.command) {
    return { ok: true, message: "Paseo shim was not installed" };
  }
  if (!isOurShimCommand(piProvider.command)) {
    return {
      ok: false,
      message: `Leaving Paseo config untouched - the pi provider command is not the bridge shim: ${JSON.stringify(piProvider.command)}`,
    };
  }
  delete piProvider.command;
  if (Object.keys(piProvider).length === 0) delete config.agents.providers.pi;
  if (Object.keys(config.agents.providers).length === 0) delete config.agents.providers;
  if (Object.keys(config.agents).length === 0) delete config.agents;
  fs.writeFileSync(paseoConfigFile, `${JSON.stringify(config, null, 2)}\n`);
  return { ok: true, message: "Paseo shim removed. Restart the Paseo daemon to apply: paseo restart" };
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
  const password = readPaseoPassword();
  const env = password ? { ...process.env, PASEO_PASSWORD: password } : process.env;
  if (process.platform === "win32" && !cli.endsWith(".exe")) {
    // Node refuses to spawn .cmd files without a shell; go through cmd.exe
    // with /s so the outer quotes survive.
    const quoted = [cli, ...args].map((a) => `"${a.replaceAll('"', '""')}"`).join(" ");
    child = spawn("cmd.exe", ["/d", "/s", "/c", `"${quoted}"`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
      env,
    });
  } else {
    child = spawn(cli, args, { stdio: ["ignore", "pipe", "pipe"], env });
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
  let currentAgentId: string | null = null;
  // Values Paseo just applied through the bridge; used to break the echo
  // loop when pushing TUI-side changes back to the daemon.
  let remoteAppliedModel: string | null = null;
  let remoteAppliedThinking: string | null = null;
  let titleAttempted = false;
  const submittedUserMessages: any[] = [];
  const pendingRemoteUiRequests = new Map<string, PendingRemoteUiRequest>();
  let markedTmuxPane: string | null = null;
  const subagentTaskProjection = new SubagentTaskProjection();

  function markTmuxPane(active: boolean): void {
    const pane = process.env.TMUX_PANE?.trim();
    if (!pane || process.platform === "win32") return;
    if (!active && markedTmuxPane !== pane) return;

    const args = active
      ? ["set-option", "-p", "-t", pane, "@paseo_pi_agent_pid", String(process.pid)]
      : ["set-option", "-p", "-u", "-t", pane, "@paseo_pi_agent_pid"];
    const child = spawn("tmux", args, { stdio: "ignore" });
    child.on("error", (err) => debugLog(`could not ${active ? "mark" : "unmark"} tmux pane: ${String(err)}`));
    child.unref();
    markedTmuxPane = active ? pane : null;
  }

  function remoteUiConnected(): boolean {
    return Boolean(client && !client.destroyed);
  }

  function finishRemoteUiRequest(id: string, value: string | undefined): void {
    const pending = pendingRemoteUiRequests.get(id);
    if (!pending) return;
    pendingRemoteUiRequests.delete(id);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    pending.resolve(value);
  }

  function cancelPendingRemoteUiRequests(): void {
    for (const id of [...pendingRemoteUiRequests.keys()]) finishRemoteUiRequest(id, undefined);
  }

  function startRemoteSelect(
    title: string,
    options: string[],
    signal?: AbortSignal,
  ): { id: string; result: Promise<string | undefined> } | null {
    if (!remoteUiConnected() || signal?.aborted) return null;
    const id = crypto.randomUUID();
    const result = new Promise<string | undefined>((resolve) => {
      const pending: PendingRemoteUiRequest = { resolve, signal };
      if (signal) {
        pending.abort = () => {
          void resolvePaseoSelect(id, undefined).finally(() => finishRemoteUiRequest(id, undefined));
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      pendingRemoteUiRequests.set(id, pending);
      send({ type: "extension_ui_request", id, method: "select", title, options });
    });
    return { id, result };
  }

  const remoteUiBridge: RemoteUiBridgeV1 = {
    isConnected: remoteUiConnected,
    select(title, options, settings = {}) {
      return startRemoteSelect(title, options, settings.signal)?.result ?? Promise.resolve(undefined);
    },
    async selectMirrored(title, options, localSelect, settings = {}) {
      const remote = startRemoteSelect(title, options, settings.signal);
      if (!remote) return await localSelect(settings.signal ?? new AbortController().signal);

      return await coordinateMirroredSelect({
        remoteResult: remote.result,
        localSelect,
        resolveLocal: (value) => resolvePaseoSelect(remote.id, value),
        finishRemote: (value) => finishRemoteUiRequest(remote.id, value),
        signal: settings.signal,
      });
    },
  };
  (globalThis as Record<string, unknown>)[REMOTE_UI_BRIDGE_KEY] = remoteUiBridge;

  function paseoWsUrl(): string | null {
    const host = process.env.PASEO_HOST?.trim();
    if (!host) return "ws://127.0.0.1:6767/ws";
    if (host.includes("://")) return null; // relay/offer URLs not supported for state sync
    return `ws://${host}/ws`;
  }

  // The daemon hides non-legacy providers (including pi) from clients that
  // do not declare a recent app version in their hello.
  const PASEO_CLIENT_APP_VERSION = "0.1.110";

  // Opens a connection to the Paseo daemon's WS API (hello handshake, then
  // session-wrapped request/response correlated by requestId). Used for
  // state the daemon only accepts as client requests (it caches
  // model/thinking/titles and prefers the cache over anything visible
  // through the provider RPC surface).
  function openPaseoWs(): {
    request: (build: (requestId: string) => Record<string, unknown>) => Promise<any>;
    requestWithId: (requestId: string, message: Record<string, unknown>) => Promise<any>;
    close: () => void;
  } | null {
    const url = paseoWsUrl();
    if (!url) return null;
    const WebSocketCtor = (globalThis as any).WebSocket;
    if (typeof WebSocketCtor !== "function") {
      debugLog("global WebSocket unavailable; cannot sync state to Paseo");
      return null;
    }
    const password = readPaseoPassword();
    const protocols = password ? [`paseo.bearer.${password}`] : undefined;
    const ws = new WebSocketCtor(url, protocols);
    const pending = new Map<string, (payload: any) => void>();
    debugLog(`paseo sync websocket connecting to ${url}`);
    const opened = new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        debugLog("paseo sync websocket connected");
        ws.send(
          JSON.stringify({
            type: "hello",
            clientId: `pi-paseo-bridge-${process.pid}`,
            clientType: "cli",
            protocolVersion: 1,
            appVersion: PASEO_CLIENT_APP_VERSION,
          }),
        );
        resolve();
      };
      ws.onerror = (event: unknown) => {
        debugLog(`paseo sync websocket error: ${String((event as any)?.message ?? "connection error")}`);
        reject(new Error("connection error"));
      };
    });
    opened.catch(() => {}); // avoid unhandled rejection when nothing awaits yet
    ws.onclose = (event: { code?: unknown; reason?: unknown }) => {
      debugLog(`paseo sync websocket closed (code=${String(event?.code ?? "unknown")}, reason=${String(event?.reason ?? "none")})`);
    };
    ws.onmessage = (event: { data: unknown }) => {
      try {
        const msg = JSON.parse(String(event.data));
        const payload = msg?.type === "session" ? msg.message?.payload : undefined;
        const resolver = payload?.requestId ? pending.get(payload.requestId) : undefined;
        if (resolver) {
          pending.delete(payload.requestId);
          debugLog(`paseo sync response received for ${payload.requestId}`);
          resolver(payload);
        } else if (msg?.type === "session") {
          debugLog(`paseo sync received uncorrelated session message (requestId=${String(payload?.requestId ?? "none")})`);
        }
      } catch {
        // initial state snapshot or binary frame - ignore
      }
    };
    async function requestWithId(requestId: string, message: Record<string, unknown>): Promise<any> {
      await opened;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          debugLog(`paseo sync request timed out: ${requestId}`);
          reject(new Error("timeout"));
        }, 5000);
        pending.set(requestId, (payload) => {
          clearTimeout(timer);
          resolve(payload);
        });
        debugLog(`paseo sync sending ${String(message.type ?? "unknown")} (requestId=${requestId})`);
        ws.send(JSON.stringify({ type: "session", message }));
      });
    }
    return {
      request(build) {
        const requestId = crypto.randomUUID();
        return requestWithId(requestId, build(requestId));
      },
      requestWithId,
      close() {
        try {
          ws.close();
        } catch {
          // already closed
        }
      },
    };
  }

  async function resolvePaseoSelect(requestId: string, value: string | undefined): Promise<unknown> {
    if (!currentAgentId) return null;
    const conn = openPaseoWs();
    if (!conn) return null;
    try {
      const response = value === undefined
        ? { behavior: "deny" }
        : { behavior: "allow", updatedInput: { answers: { Response: value } } };
      return await conn.requestWithId(requestId, {
        type: "agent_permission_response",
        agentId: currentAgentId,
        requestId,
        response,
      });
    } catch (err) {
      debugLog(`paseo mirrored selection failed for ${requestId}: ${String(err)}`);
      return null;
    } finally {
      conn.close();
    }
  }

  function paseoSessionRequest(buildMessage: (requestId: string) => Record<string, unknown>, label: string): void {
    const conn = openPaseoWs();
    if (!conn) return;
    conn
      .request(buildMessage)
      .then((payload) => {
        const ok = payload.accepted ?? payload.ok;
        debugLog(`paseo sync ${label}: ${ok ? "accepted" : `rejected: ${payload.error}`}`);
      })
      .catch((err) => debugLog(`paseo sync ${label}: ${String(err?.message ?? err)}`))
      .finally(() => conn.close());
  }

  // The sidebar labels workspaces by branch name; give the workspace the
  // session title, prefixed so it's clear the session started in a terminal.
  async function setPaseoWorkspaceTitle(agentId: string, title: string): Promise<void> {
    const conn = openPaseoWs();
    if (!conn) return;
    const workspaceTitle = `[TUI] ${title}`;
    try {
      const fetched = await conn.request((requestId) => ({ type: "fetch_agent_request", agentId, requestId }));
      const workspaceId = fetched?.agent?.workspaceId;
      if (!workspaceId) {
        debugLog(`workspace title: agent ${agentId} has no workspaceId (${fetched?.error ?? "no error"})`);
        return;
      }
      const result = await conn.request((requestId) => ({
        type: "workspace.title.set.request",
        workspaceId,
        title: workspaceTitle,
        requestId,
      }));
      debugLog(`paseo sync workspace title "${workspaceTitle}": ${result.accepted ? "accepted" : `rejected: ${result.error}`}`);
    } catch (err) {
      debugLog(`workspace title failed: ${String(err)}`);
    } finally {
      conn.close();
    }
  }

  function pushAgentConfigToPaseo(kind: "model" | "thinking", value: string | null): void {
    if (!currentAgentId) return;
    const agentId = currentAgentId;
    paseoSessionRequest(
      (requestId) =>
        kind === "model"
          ? { type: "set_agent_model_request", agentId, modelId: value, requestId }
          : { type: "set_agent_thinking_request", agentId, thinkingOptionId: value, requestId },
      `${kind}=${value}`,
    );
  }

  function modelToId(model: { provider?: string; id?: string } | null | undefined): string | null {
    return model?.provider && model.id ? `${model.provider}/${model.id}` : null;
  }

  function send(obj: unknown): void {
    if (!client || client.destroyed) return;
    try {
      client.write(`${JSON.stringify(obj)}\n`);
    } catch (err) {
      debugLog(`send failed: ${String(err)}`);
    }
  }

  function notifyTui(message: string): void {
    if (latestCtx?.mode !== "tui") return;
    try {
      latestCtx.ui.notify(message, "info");
    } catch (err) {
      debugLog(`notifyTui failed: ${String(err)}`);
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

  function toCapturedUserEntry(entry: any): { id: string; parentId: string | null; text: string } {
    return {
      id: entry.id,
      parentId: entry.parentId ?? null,
      text: readTextContent(entry.message.content),
    };
  }

  function capturedUserEntries(ctx: ExtensionContext): Array<{ id: string; parentId: string | null; text: string }> {
    return ctx.sessionManager
      .getEntries()
      .filter((entry: any) => entry.type === "message" && entry.message?.role === "user")
      .map(toCapturedUserEntry);
  }

  function emitSubmittedUserEntries(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getEntries();
    for (let index = 0; index < submittedUserMessages.length; index += 1) {
      const message = submittedUserMessages[index];
      const entry = entries.find(
        (candidate: any) => candidate.type === "message" && candidate.message === message,
      );
      if (!entry) continue;
      submittedUserMessages.splice(index, 1);
      index -= 1;
      notifyEvent(`${SUBMITTED_USER_ENTRY_MARKER} ${JSON.stringify({ entry: toCapturedUserEntry(entry) })}`);
    }
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

  async function handlePrompt(cmd: any): Promise<void> {
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
    const result = await dispatchPaseoPrompt(pi, content as any, message, streaming, (err) =>
      debugLog(`prompt failed after acceptance: ${String(err)}`),
    );
    send(success(cmd.id, "prompt", result));
  }

  async function handleCommand(cmd: any): Promise<void> {
    const id = cmd.id;
    const type: string = cmd.type;
    try {
      switch (type) {
        case "prompt":
          await handlePrompt(cmd);
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
          await abortAndWaitForIdle(latestCtx);
          send(success(id, type));
          return;
        case "get_state":
          send(success(id, type, buildState()));
          return;
        case "get_messages": {
          const entries = latestCtx?.sessionManager.buildContextEntries() ?? [];
          const messages = entries.filter((e: any) => e.type === "message").map((e: any) => e.message);
          send(success(id, type, { messages: projectSubagentMessages(messages) }));
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
          remoteAppliedModel = modelToId(model);
          const ok = await pi.setModel(model);
          if (!ok) {
            send(failure(id, type, `No API key available for ${cmd.provider}/${cmd.modelId}`));
            return;
          }
          send(success(id, type, model));
          return;
        }
        case "set_thinking_level":
          remoteAppliedThinking = cmd.level;
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
        case "extension_ui_response": {
          const value = cmd.cancelled === true || typeof cmd.value !== "string" ? undefined : cmd.value;
          finishRemoteUiRequest(String(cmd.id ?? ""), value);
          return;
        }
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
      if (client === socket) {
        client = null;
        cancelPendingRemoteUiRequests();
      }
      debugLog("client disconnected");
    };
    socket.on("close", detach);
    socket.on("error", (err) => {
      debugLog(`client socket error: ${String(err)}`);
      detach();
    });
    debugLog("client connected");
    notifyTui("Paseo attached to this session");
    // Prime Paseo's user-entry capture, mirroring what its injected
    // extension does on session_start.
    emitEntryCapture(latestCtx, "session_start");
  }

  function stopServer(): void {
    cancelPendingRemoteUiRequests();
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
    currentAgentId = null;
    remoteAppliedModel = null;
    remoteAppliedThinking = null;
    titleAttempted = false;
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

  const agentMapFile = path.join(os.homedir(), ".pi", "paseo-bridge", "agents.json");
  const runtimeRegistryDir = path.join(os.homedir(), ".pi", "paseo-bridge", "runtimes");

  function runtimeRecordFile(sessionFile: string): string {
    const key = crypto.createHash("sha256").update(agentMapKey(sessionFile)).digest("hex");
    return path.join(runtimeRegistryDir, `${key}.json`);
  }

  function writeRuntimeRecord(sessionFile: string, cwd: string): void {
    try {
      fs.mkdirSync(runtimeRegistryDir, { recursive: true, mode: 0o700 });
      fs.chmodSync(runtimeRegistryDir, 0o700);
      const destination = runtimeRecordFile(sessionFile);
      const temporary = `${destination}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify({
        sessionFile: path.resolve(sessionFile),
        agentId: currentAgentId,
        cwd,
        pid: process.pid,
        tuiKind: process.env.PI_SUPERVISED === "1" ? "supervised" : "unsafe",
        forkCreated: Boolean(process.env.PI_PASEO_EXISTING_AGENT_ID?.trim()),
        tmuxPane: process.env.TMUX_PANE?.trim() || markedTmuxPane,
        tmuxSocket: process.env.TMUX?.split(",", 1)[0]?.trim() || null,
      }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, destination);
    } catch (err) {
      debugLog(`could not write runtime record: ${String(err)}`);
    }
  }

  function removeRuntimeRecord(sessionFile: string): void {
    try {
      const destination = runtimeRecordFile(sessionFile);
      const record = JSON.parse(fs.readFileSync(destination, "utf8"));
      if (record?.pid === process.pid) fs.unlinkSync(destination);
    } catch {
      // absent, stale, or replaced by a newer owner
    }
  }

  function agentMapKey(sessionFile: string): string {
    const resolved = path.resolve(sessionFile);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  function readAgentMap(): Record<string, string> {
    try {
      const parsed = JSON.parse(fs.readFileSync(agentMapFile, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeAgentMapEntry(sessionFile: string, agentId: string): void {
    try {
      fs.mkdirSync(path.dirname(agentMapFile), { recursive: true });
      const map = readAgentMap();
      map[agentMapKey(sessionFile)] = agentId;
      fs.writeFileSync(agentMapFile, `${JSON.stringify(map, null, 2)}\n`);
    } catch (err) {
      debugLog(`could not persist agent map: ${String(err)}`);
    }
  }

  function adoptAgent(agentId: string, reused: boolean): void {
    currentAgentId = agentId;
    if (currentSessionFile && latestCtx) writeRuntimeRecord(currentSessionFile, latestCtx.cwd);
    debugLog(`paseo agent id: ${agentId}${reused ? " (reused)" : ""}`);
    // Align Paseo's cached model/thinking with the TUI's live values. The
    // import-time descriptor scan can be stale or empty.
    pushAgentConfigToPaseo("model", modelToId(latestCtx?.model));
    pushAgentConfigToPaseo("thinking", pi.getThinkingLevel() ?? null);
    notifyTui(reused ? "Session reconnected in Paseo" : "Session imported into Paseo");
    // Resumed sessions already have history (and possibly a name); sync the
    // title now instead of waiting for the next turn.
    if (latestCtx) void maybeGenerateSessionTitle(latestCtx);
  }

  function registerWithPaseo(sessionFile: string, cwd: string): void {
    if (importAttempted.has(sessionFile)) return;
    importAttempted.add(sessionFile);
    const assignedAgentId = process.env.PI_PASEO_EXISTING_AGENT_ID?.trim();
    if (assignedAgentId) {
      writeAgentMapEntry(sessionFile, assignedAgentId);
      adoptAgent(assignedAgentId, true);
      return;
    }
    if (process.env.PI_PASEO_BRIDGE_NO_IMPORT) return;
    const cli = resolvePaseoCli();
    if (!cli) {
      debugLog("paseo CLI not found; session will not auto-appear (set PASEO_CLI)");
      return;
    }
    const hostArgs = process.env.PASEO_HOST ? ["--host", process.env.PASEO_HOST] : [];
    const runImport = () => {
      const args = ["import", "--provider", "pi", sessionFile, "--cwd", cwd, "--json", ...hostArgs];
      runPaseoCli(cli, args, (code, output) => {
        debugLog(`paseo import exited ${code}: ${output.slice(0, 500)}`);
        if (code !== 0) return;
        try {
          const jsonStart = output.indexOf("{");
          if (jsonStart === -1) return;
          const result = JSON.parse(output.slice(jsonStart));
          if (typeof result.agentId === "string" && result.agentId) {
            writeAgentMapEntry(sessionFile, result.agentId);
            adoptAgent(result.agentId, false);
          }
        } catch (err) {
          debugLog(`could not parse import output: ${String(err)}`);
        }
      });
    };
    // Re-importing a session Paseo already knows creates a duplicate agent,
    // so check the last known agent for this session file first.
    const knownAgentId = readAgentMap()[agentMapKey(sessionFile)];
    if (!knownAgentId) {
      runImport();
      return;
    }
    runPaseoCli(cli, ["inspect", knownAgentId, "--json", ...hostArgs], (code, output) => {
      let exists = false;
      try {
        if (code === 0) {
          const jsonStart = output.indexOf("{");
          const info = jsonStart === -1 ? null : JSON.parse(output.slice(jsonStart));
          exists = Boolean(info) && info.Archived !== true;
        }
      } catch (err) {
        debugLog(`inspect of known agent failed: ${String(err)}`);
      }
      if (!exists) {
        runImport();
        return;
      }
      // The daemon's provider session for this agent died with the previous
      // TUI process; reload restarts it so it reattaches to the new pipe.
      runPaseoCli(cli, ["agent", "reload", knownAgentId, "--json", ...hostArgs], (reloadCode, reloadOutput) => {
        debugLog(`paseo agent reload exited ${reloadCode}: ${reloadOutput.slice(0, 200)}`);
        if (reloadCode === 0) {
          adoptAgent(knownAgentId, true);
        } else {
          runImport();
        }
      });
    });
  }

  function connectSession(ctx: ExtensionContext): string {
    const file = ctx.sessionManager.getSessionFile();
    if (!file) return "This session is ephemeral (--no-session); nothing to bridge.";
    if (file !== currentSessionFile) {
      stopServer();
      startServer(file);
    }
    writeRuntimeRecord(file, ctx.cwd);
    importAttempted.delete(file);
    registerWithPaseo(file, ctx.cwd);
    return "Connecting session to Paseo...";
  }

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    try {
      const force = ["1", "true", "on"].includes((process.env.PI_PASEO_BRIDGE_FORCE ?? "").toLowerCase());
      if (ctx.mode !== "tui" && !force) return;
      if (!isAutoEnabled()) return;
      connectSession(ctx);
      markTmuxPane(true);
    } catch (err) {
      debugLog(`session_start failed: ${String(err)}`);
    }
  });

  pi.on("session_shutdown", async () => {
    if (currentSessionFile) removeRuntimeRecord(currentSessionFile);
    markTmuxPane(false);
    stopServer();
    if ((globalThis as Record<string, unknown>)[REMOTE_UI_BRIDGE_KEY] === remoteUiBridge) {
      delete (globalThis as Record<string, unknown>)[REMOTE_UI_BRIDGE_KEY];
    }
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
      const normalized = normalizePiEventForPaseo(event);
      for (const projected of subagentTaskProjection.project(normalized)) send(projected);
    });
  }

  pi.on("message_end", async (event: any) => {
    if (event.message?.role === "user") submittedUserMessages.push(event.message);
  });

  pi.on("message_start", async (event: any, ctx) => {
    if (event.message?.role === "assistant") emitSubmittedUserEntries(ctx);
  });

  // Imported terminal sessions have no title in Paseo (the UI falls back to
  // the branch name), so generate one from the first user message.
  async function maybeGenerateSessionTitle(ctx: ExtensionContext): Promise<void> {
    if (titleAttempted || !currentAgentId) return;
    if (process.env.PI_PASEO_BRIDGE_NO_TITLE) return;
    const existingName = ctx.sessionManager.getSessionName();
    if (existingName) {
      // Session already named (by the user or a previous run) - just make
      // sure Paseo shows it.
      titleAttempted = true;
      const agentId = currentAgentId;
      paseoSessionRequest(
        (requestId) => ({ type: "update_agent_request", agentId, name: existingName, requestId }),
        `title "${existingName}" (existing)`,
      );
      void setPaseoWorkspaceTitle(agentId, existingName);
      return;
    }
    const firstMessage = capturedUserEntries(ctx)[0]?.text?.trim();
    if (!firstMessage) {
      debugLog("title generation: no user message in session yet");
      return;
    }
    titleAttempted = true;
    try {
      const model = ctx.model;
      if (!model) return;
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (auth.ok === false) {
        debugLog(`title generation: no auth: ${auth.error}`);
        return;
      }
      const response = await completeSimple(
        model,
        {
          systemPrompt:
            "You name coding agent sessions. Given the user's first message, reply with only a short session title: 3 to 8 words, plain text, no quotes, no trailing punctuation.",
          messages: [
            { role: "user", content: [{ type: "text", text: firstMessage.slice(0, 4000) }], timestamp: Date.now() } as any,
          ],
        },
        { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 1024, reasoning: "off" },
      );
      let title = readTextContent(response.content).trim().split("\n")[0].trim().replace(/^["']+|["']+$/g, "");
      if (!title) {
        debugLog(`title generation: empty response (stopReason=${(response as any).stopReason})`);
        return;
      }
      if (title.length > 80) title = `${title.slice(0, 77)}...`;
      pi.setSessionName(title);
      const agentId = currentAgentId;
      paseoSessionRequest(
        (requestId) => ({ type: "update_agent_request", agentId, name: title, requestId }),
        `title "${title}"`,
      );
      if (agentId) void setPaseoWorkspaceTitle(agentId, title);
    } catch (err) {
      debugLog(`title generation failed: ${String(err)}`);
    }
  }

  pi.on("turn_start", async (_event, ctx) => {
    void maybeGenerateSessionTitle(ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    latestCtx = ctx;
    send(event);
    emitSubmittedUserEntries(ctx);
    emitEntryCapture(ctx, "turn_end");
    void maybeGenerateSessionTitle(ctx);
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

  pi.on("model_select", async (event, ctx) => {
    latestCtx = ctx;
    const modelId = modelToId(event.model);
    if (modelId === remoteAppliedModel) {
      remoteAppliedModel = null;
      return;
    }
    pushAgentConfigToPaseo("model", modelId);
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    latestCtx = ctx;
    if (event.level === remoteAppliedThinking) {
      remoteAppliedThinking = null;
      return;
    }
    pushAgentConfigToPaseo("thinking", event.level ?? null);
  });

  pi.registerCommand("paseo-bridge", {
    description: "Manage the Paseo bridge: install | uninstall | auto [on|off] | connect | disconnect | status",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";
      try {
        switch (sub) {
          case "install": {
            const result = installShimIntoPaseoConfig();
            ctx.ui.notify(result.message, result.ok ? "info" : "error");
            return;
          }
          case "uninstall": {
            const result = uninstallShimFromPaseoConfig();
            ctx.ui.notify(result.message, result.ok ? "info" : "error");
            return;
          }
          case "auto": {
            const value = parts[1]?.toLowerCase();
            if (value !== "on" && value !== "off") {
              ctx.ui.notify(`Auto-connect is ${isAutoEnabled() ? "on" : "off"}. Use /paseo-bridge auto on|off to change.`, "info");
              return;
            }
            writeBridgeSettings({ auto: value === "on" });
            ctx.ui.notify(`Auto-connect ${value}: new TUI sessions will ${value === "on" ? "" : "not "}appear in Paseo automatically.`, "info");
            return;
          }
          case "connect":
            ctx.ui.notify(connectSession(ctx), "info");
            return;
          case "disconnect":
            if (!server) {
              ctx.ui.notify("Bridge is not connected.", "info");
              return;
            }
            stopServer();
            ctx.ui.notify("Bridge disconnected. Use /paseo-bridge connect to reattach.", "info");
            return;
          case "status": {
            let shimInstalled = false;
            try {
              shimInstalled = isOurShimCommand(
                JSON.parse(fs.readFileSync(paseoConfigFile, "utf8"))?.agents?.providers?.pi?.command,
              );
            } catch {
              // unreadable config counts as not installed
            }
            const lines = [
              `shim: ${shimInstalled ? "installed" : "not installed (run /paseo-bridge install)"}`,
              `auto-connect: ${isAutoEnabled() ? "on" : "off"}`,
              `session: ${server ? (currentAgentId ? `bridged as Paseo agent ${currentAgentId}` : "bridged (not yet imported)") : "not bridged"}`,
            ];
            ctx.ui.notify(`Paseo bridge status\n${lines.join("\n")}`, "info");
            return;
          }
          default:
            ctx.ui.notify("Usage: /paseo-bridge install | uninstall | auto [on|off] | connect | disconnect | status", "warning");
        }
      } catch (err) {
        ctx.ui.notify(`paseo-bridge: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
