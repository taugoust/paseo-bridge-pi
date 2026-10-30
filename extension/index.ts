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
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { spawn } from "node:child_process";
import { assertNoLiveRuntimeOwner, processStartToken, harnessRuntimeMetadata, resolveTmuxIdentity, markPaseoAgentPane, clearPaseoAgentPane, validRuntimeReapingEvent, REAPED_RUNTIME_ERROR } from "../shim/runtime-registry.js";
import { fileURLToPath } from "node:url";
import { parseTmuxTarget } from "../shim/tmux-target.js";
import { paseoImportArgs, importRetryDelay, retryableWorkspaceImportFailure, workspaceIdForPlacement } from "./import-placement.js";
import { completeWithSessionModel } from "./session-model-request.ts";
import { sameReadOnlySession, assertReadOnlyConversationResponse } from "./read-only-session.ts";
import { buildSessionContext, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as sessionManagerApi from "@earendil-works/pi-coding-agent";
import { BridgeTransport, retainBridgeForReload, takeBridgeAfterReload, discardRetainedBridge } from "./bridge-transport.js";
import {
  permissionGateOperatorSocketPath,
  removePermissionGateOperatorDescriptor,
  writePermissionGateOperatorDescriptor,
  type PermissionGateOperatorDescriptorV1,
  type PermissionGateOperatorIdentityV1,
  writeHarnessReadOnlyDescriptor,
  removeHarnessReadOnlyDescriptor,
} from "./permission-gate-operator.js";
import { foregroundTasksSocketPath, removeForegroundTasksDescriptor, writeForegroundTasksDescriptor } from "./foreground-task-operator.js";
import { accountControlsSocketPath, removeAccountControlsDescriptor, writeAccountControlsDescriptor } from "./account-controls-operator.js";
import { btwSocketPath, removeBtwDescriptor, writeBtwDescriptor } from "./btw-operator.js";
import { workflowsSocketPath, removeWorkflowsDescriptor, writeWorkflowsDescriptor } from "./workflows-operator.js";
import { isRuntimeReloadCommand, requireIdleReload, validateReloadPrompt } from "./reload-command.js";
import { abortAndWaitForIdle } from "./abort-dispatch.js";
import { dispatchPaseoPrompt, isExtensionCommand } from "./prompt-dispatch.js";
import { remoteUserContent } from "./remote-user-content.js";
import { dispatchAfterIdlePreflight, IDLE_PREFLIGHT_KEY, IDLE_PROMPT_CANCELLED } from "./idle-preflight.js";
import { coordinateMirroredSelect } from "./mirrored-select.js";
import { createProviderReconnectLoop } from "./provider-reconnect.js";
import { unknownRpcCommandError } from "./rpc-compat.js";
import { buildSessionStats } from "./session-stats.js";
import { compactWithResult } from "./compaction-command.js";
import { buildProjectedHistory, projectedUserCaptures } from "./session-projection.js";
import { handleSecurityModeRequest } from "./security-mode-operator.js";
import { featureSnapshot, handleNativeFeatureRequest } from "./native-features.js";
import { CanonicalNameSync } from "./canonical-name-sync.js";
import { createPaseoWsConnection } from "./paseo-ws.js";
import { applyRemoteModel } from "./model-sync.js";
import { normalizePiEventForPaseo } from "./tool-result-normalization.js";
import { SubagentTaskProjection, projectSubagentMessages } from "./subagent-task-projection.js";
import { TurnVisibilityProjection } from "./turn-visibility.js";
import { resolvePaseoChildRuntimeLink } from "./read-only-runtime-link.js";
import { bridgeSettingsFile, isAutoEnabled, isImportEnabled, isTitleGenerationEnabled, writeBridgeSettings, writeMutableJson } from "./bridge-settings.js";

type QuestionnaireUiMetadata = { v: 1; toolCallId: string; index: number; input: boolean };
type RemoteUiSelectOptions = { signal?: AbortSignal; paseoQuestionnaire?: QuestionnaireUiMetadata };
type RemoteUiBridgeV1 = {
  isConnected(): boolean;
  select(title: string, options: string[], settings?: RemoteUiSelectOptions): Promise<string | undefined>;
  input(title: string, placeholder?: string, settings?: RemoteUiSelectOptions): Promise<string | undefined>;
  confirm(title: string, message: string, settings?: RemoteUiSelectOptions): Promise<boolean | undefined>;
  editor(title: string, prefill?: string, settings?: RemoteUiSelectOptions): Promise<string | undefined>;
  selectMirrored?(
    title: string,
    options: string[],
    localSelect: (signal: AbortSignal) => Promise<string | undefined>,
    settings?: RemoteUiSelectOptions,
  ): Promise<string | undefined>;
};
type PendingRemoteUiRequest = {
  method: "select" | "input" | "confirm" | "editor";
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
  writeMutableJson(paseoConfigFile, config);
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
  writeMutableJson(paseoConfigFile, config);
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

  let transport: BridgeTransport | null = null;
  let currentSessionFile: string | null = null;
  let reloadRequested = false;
  let reloadExecuting = false;
  let commandsInFlight = 0;
  const pendingCommandReplies = new Map<symbol, (reason: string) => void>();
  let lifecycleClosed = false;
  let preflightAbortController = new AbortController();
  // Stop cancels pending prompt admission without closing the bridge lifetime.
  let promptAbortController = new AbortController();
  let placementTimer: ReturnType<typeof setInterval> | undefined;
  let lastPlacement = "";
  let lastAgentTag = "";
  const paneOwnerIdentity = { pid: process.pid, startToken: processStartToken() };
  let ownedPaneTag: { placement: ReturnType<typeof resolveTmuxIdentity>; agentId: string | null } | null = null;
  let reapedRuntime: { workerEpoch: string; reapSealedAt: string } | null = null;
  const runtimeReapingIdentity = {
    PI_HARNESS_RUNTIME_ID: process.env.PI_HARNESS_RUNTIME_ID,
    PI_HARNESS_CHILD_ID: process.env.PI_HARNESS_CHILD_ID,
    PI_HARNESS_TASK_ID: process.env.PI_HARNESS_TASK_ID,
    PI_HARNESS_ATTEMPT: process.env.PI_HARNESS_ATTEMPT,
  };
  const unsubscribeReaping = pi.events.on("harness-runtime-reaping", (event: any) => {
    if (process.platform !== "linux" || lifecycleClosed || !validRuntimeReapingEvent(event, runtimeReapingIdentity)) return;
    const file = currentSessionFile ?? latestCtx?.sessionManager.getSessionFile();
    if (!file || !latestCtx) return;
    reapedRuntime ??= { workerEpoch: event.workerEpoch, reapSealedAt: new Date().toISOString() };
    preflightAbortController.abort();
    // Trusted lifecycle notification only: never inject a user/model message.
    writeRuntimeRecord(file, latestCtx.cwd);
  });
  let latestCtx: ExtensionContext | null = null;
  let readOnlySessionLifecycle = {};
  let isCompacting = false;
  // The extension API cannot read or change Pi's live auto-compaction setting.
  // Do not invent a separate bridge-local setting.
  const importAttempted = new Set<string>();
  let importFailures = 0;
  let importRetryAt = 0;
  let currentAgentId: string | null = null;
  let lastSecurityModeStatus: string | undefined;
  // Values Paseo just applied through the bridge; used to break the echo
  // loop when pushing TUI-side changes back to the daemon.
  let remoteAppliedModel: string | null = null;
  let remoteAppliedThinking: string | null = null;
  let titleAttempted = false;
  let canonicalNameSync: CanonicalNameSync | undefined;
  let canonicalNameConnection: ReturnType<typeof openPaseoWs>;
  let canonicalNameBinding: { agentId: string; sessionId: string; operator: any } | undefined;
  const submittedUserMessages: any[] = [];
  const pendingRemoteUiRequests = new Map<string, PendingRemoteUiRequest>();
  let markedTmuxPane: string | null = null;
  const subagentTaskProjection = new SubagentTaskProjection();
  const turnVisibility = new TurnVisibilityProjection();
  const providerReconnect = createProviderReconnectLoop({
    shouldReconnect: () => Boolean(currentSessionFile && currentAgentId && !remoteUiConnected()),
    reload: reloadCurrentPaseoProvider,
    onError: (error) => debugLog(`paseo provider reattach failed: ${String(error)}`),
  });

  function reloadCurrentPaseoProvider(): Promise<void> {
    const agentId = currentAgentId;
    const cli = resolvePaseoCli();
    if (!agentId) return Promise.reject(new Error("Paseo agent ID is unavailable"));
    if (!cli) return Promise.reject(new Error("paseo CLI is unavailable"));
    const hostArgs = process.env.PASEO_HOST ? ["--host", process.env.PASEO_HOST] : [];
    return new Promise((resolve, reject) => {
      runPaseoCli(cli, ["agent", "reload", agentId, "--json", ...hostArgs], (code, output) => {
        debugLog(`paseo provider reattach reload exited ${code}: ${output.slice(0, 200)}`);
        if (code === 0) resolve();
        else reject(new Error(output.trim() || `paseo agent reload exited ${String(code)}`));
      });
    });
  }

  function markTmuxPane(active: boolean): void {
    if (process.platform === "linux") {
      if (active) {
        const placement = resolveTmuxIdentity();
        if (markPaseoAgentPane(placement, currentAgentId, undefined, paneOwnerIdentity)) {
          ownedPaneTag = { placement, agentId: currentAgentId };
          lastAgentTag = JSON.stringify([placement.tmuxSocket, placement.tmuxPane, currentAgentId]);
        }
      } else if (ownedPaneTag) {
        clearPaseoAgentPane(ownedPaneTag.placement, ownedPaneTag.agentId, undefined, paneOwnerIdentity);
        ownedPaneTag = null;
        lastAgentTag = "";
      }
      return;
    }
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
    return transport?.connected ?? false;
  }

  function finishRemoteUiRequest(id: string, value: string | undefined): void {
    const pending = pendingRemoteUiRequests.get(id);
    if (!pending) return;
    pendingRemoteUiRequests.delete(id);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
    pending.resolve(value);
  }

  function cancelPendingRemoteUiRequests(): void {
    for (const id of [...pendingRemoteUiRequests.keys()]) {
      send({ type: "extension_ui_cancel", id });
      finishRemoteUiRequest(id, undefined);
    }
  }

  function startRemoteDialog(
    request: { method: PendingRemoteUiRequest["method"]; title: string; options?: string[]; placeholder?: string; message?: string; prefill?: string; paseoQuestionnaire?: QuestionnaireUiMetadata },
    signal?: AbortSignal,
  ): { id: string; result: Promise<string | undefined> } | null {
    if (!remoteUiConnected() || signal?.aborted) return null;
    const id = crypto.randomUUID();
    const result = new Promise<string | undefined>((resolve) => {
      const pending: PendingRemoteUiRequest = { method: request.method, resolve, signal };
      if (signal) {
        pending.abort = () => {
          // The server can map this raw dialog to a batched form/input request.
          // Keep the existing WS mirror as a compatibility fallback.
          send({ type: "extension_ui_cancel", id });
          void resolvePaseoSelect(id, undefined).finally(() => finishRemoteUiRequest(id, undefined));
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      pendingRemoteUiRequests.set(id, pending);
      send({ type: "extension_ui_request", id, ...request });
    });
    return { id, result };
  }

  const remoteUiBridge: RemoteUiBridgeV1 = {
    isConnected: remoteUiConnected,
    select(title, options, settings = {}) {
      return startRemoteDialog({ method: "select", title, options, ...(settings.paseoQuestionnaire ? { paseoQuestionnaire: settings.paseoQuestionnaire } : {}) }, settings.signal)?.result ?? Promise.resolve(undefined);
    },
    input(title, placeholder, settings = {}) {
      return startRemoteDialog({ method: "input", title, placeholder, ...(settings.paseoQuestionnaire ? { paseoQuestionnaire: settings.paseoQuestionnaire } : {}) }, settings.signal)?.result ?? Promise.resolve(undefined);
    },
    async confirm(title, message, settings = {}) {
      const value = await (startRemoteDialog({ method: "confirm", title, message }, settings.signal)?.result ?? Promise.resolve(undefined));
      return value === undefined ? undefined : value === "Yes";
    },
    async editor(title, prefill, settings = {}) {
      // Stock Paseo clients cannot prefill an editor. Offer an explicit,
      // non-destructive replacement flow using their existing native dialogs.
      if (prefill) {
        const choice = await remoteUiBridge.select(`${title}\n\nCurrent text:\n${prefill}`,
          ["Keep existing text", "Write replacement"], settings);
        if (choice === "Keep existing text") return prefill;
        if (choice !== "Write replacement") return undefined;
      }
      return remoteUiBridge.input(title, "Write replacement text", settings);
    },
    async selectMirrored(title, options, localSelect, settings = {}) {
      const remote = startRemoteDialog({ method: "select", title, options, ...(settings.paseoQuestionnaire ? { paseoQuestionnaire: settings.paseoQuestionnaire } : {}) }, settings.signal);
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
  function openPaseoWs(onSession?: (message: any) => void, onFailure?: (error: Error) => void): {
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
    debugLog(`paseo sync websocket connecting to ${url}`);
    return createPaseoWsConnection(ws, {
      type: "hello",
      clientId: `pi-paseo-bridge-${process.pid}`,
      clientType: "cli",
      protocolVersion: 1,
      appVersion: PASEO_CLIENT_APP_VERSION,
    }, { log: debugLog, onSession, onFailure });
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
  // same plain session title as the conversation.
  async function setPaseoWorkspaceTitle(agentId: string, title: string): Promise<boolean> {
    const conn = openPaseoWs();
    if (!conn) return false;
    const workspaceTitle = title;
    try {
      const fetched = await conn.request((requestId) => ({ type: "fetch_agent_request", agentId, requestId }));
      const workspaceId = fetched?.agent?.workspaceId;
      if (!workspaceId) {
        debugLog(`workspace title: agent ${agentId} has no workspaceId (${fetched?.error ?? "no error"})`);
        return false;
      }
      const result = await conn.request((requestId) => ({
        type: "workspace.title.set.request",
        workspaceId,
        title: workspaceTitle,
        requestId,
      }));
      debugLog(`paseo sync workspace title "${workspaceTitle}": ${result.accepted ? "accepted" : `rejected: ${result.error}`}`);
      return result.accepted === true;
    } catch (err) {
      debugLog(`workspace title failed: ${String(err)}`);
      return false;
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
    transport?.send(obj);
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
      const sm = ctx.sessionManager;
      const treeEntries = capturedUserEntries(ctx);
      const history = buildProjectedHistory(sm.getEntries(), sm.getLeafId(), sessionManagerApi);
      const contextEntries = history.hasProjection
        ? projectedUserCaptures(history.projectedEntries)
        : sm.buildContextEntries()
          .filter((entry: any) => entry.type === "message" && entry.message?.role === "user")
          .map(toCapturedUserEntry);
      notifyEvent(`${ENTRY_CAPTURE_MARKER} ${JSON.stringify({ reason, requestId, treeEntries, contextEntries })}`);
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
      bridgeCapabilities: { supportsRewindConversation: false, supportsAutoCompactionControl: false },
      messageCount,
      pendingMessageCount: ctx?.hasPendingMessages() ? 1 : 0,
      contextUsage: ctx?.getContextUsage(),
    };
  }

  async function preflightUserPrompt(id: string, commandType: string, send: (frame: unknown) => void): Promise<() => boolean> {
    const capability = (globalThis as Record<string, unknown>)[IDLE_PREFLIGHT_KEY];
    const signal = AbortSignal.any([preflightAbortController.signal, promptAbortController.signal]);
    const gated = await dispatchAfterIdlePreflight(capability, signal, async () => true);
    if (!gated.dispatched) {
      const error = gated.outcome === "cancel" ? IDLE_PROMPT_CANCELLED :
        "Prompt not sent: pre-send confirmation could not complete.";
      send(failure(id, commandType, error));
      return () => false;
    }
    // Recheck in the caller's dispatch stack: Stop may arrive after preflight
    // resolved but before the caller resumes. No await may separate this guard
    // from sendUserMessage, or a cancelled admission could start a new turn.
    return () => {
      if (!signal.aborted) return true;
      send(failure(id, commandType, IDLE_PROMPT_CANCELLED));
      return false;
    };
  }

  function commandNotices(reply: (frame: unknown) => void) {
    return (message: string, notifyType: "info" | "warning" | "error") => reply({
      type: "extension_ui_request", id: crypto.randomUUID(), method: "notify", message, notifyType,
    });
  }

  async function handlePrompt(cmd: any, send: (frame: unknown) => void): Promise<void> {
    const message: string = typeof cmd.message === "string" ? cmd.message : "";
    if (/^\/reload(?:\s|$)/.test(message.trim())) {
      throw new Error("Unsupported command: /reload is terminal-only. Use /remote-reload to reload Pi from Paseo while idle.");
    }
    if (isRuntimeReloadCommand(message)) {
      validateReloadPrompt(message, cmd.images);
      requireIdleReload(latestCtx, { reloading: reloadRequested, compacting: isCompacting,
        pendingUi: pendingRemoteUiRequests.size > 0, pendingRpc: commandsInFlight > 1 });
      reloadRequested = true;
      // Acknowledge acceptance before teardown. Completion is emitted by the
      // replacement session_start handler, never through the stale Pi API.
      send(success(cmd.id, "prompt", { agentInvoked: false, reloadAccepted: true }));
      try { pi.sendUserMessage("/remote-reload", { expandPromptTemplates: true }); }
      catch (error) {
        reloadRequested = false;
        notifyEvent(`Pi runtime reload failed: ${String(error).slice(0, 2000)}`);
      }
      return;
    }
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
    if (await handleBridgeManagement(cmd, send)) return;
    const content = remoteUserContent(message, cmd.images);
    const streaming = latestCtx ? !latestCtx.isIdle() : false;
    if (!isExtensionCommand(pi, message)) {
      const canDispatch = await preflightUserPrompt(cmd.id, "prompt", send);
      if (!canDispatch()) return;
    }
    const dispatch = () => dispatchPaseoPrompt(pi, content as any, message, streaming, (err) =>
      debugLog(`prompt failed after acceptance: ${String(err)}`), commandNotices(send), undefined, promptAbortController.signal,
    );
    const result = await dispatch();
    send(success(cmd.id, "prompt", result));
  }

  async function handleBridgeManagement(cmd: any, send: (frame: unknown) => void): Promise<boolean> {
    const message = typeof cmd.message === "string" ? cmd.message : "";
    if (message !== "/paseo-bridge" && !message.startsWith("/paseo-bridge ")) return false;
    if (Array.isArray(cmd.images) && cmd.images.length) throw new Error("Extension commands do not accept image attachments. Send images as an ordinary prompt.");
    if (!latestCtx) throw new Error("Pi session is not ready.");
    const args = message.slice("/paseo-bridge".length).trimStart();
    // Disconnect is acceptance-only: the transport cannot report its own
    // completed teardown. Never present this receipt as command completion.
    if (args.trim().split(/\s+/)[0] === "disconnect") {
      send(success(cmd.id, cmd.type, { agentInvoked: false, disconnectAccepted: true }));
      stopServer();
      return true;
    }
    await runBridgeManagement(args, latestCtx, true, commandNotices(send));
    send(success(cmd.id, cmd.type, { agentInvoked: false }));
    return true;
  }

  async function handleCommand(cmd: any): Promise<void> {
    // Completion and notifications belong to the requesting controller, never
    // to a replacement connection or extension binding after an awaited command.
    const owner = transport;
    const epoch = owner?.operatorEpoch;
    const lease = Symbol("command reply");
    let settled = false;
    const send = (frame: unknown) => {
      if (settled) return;
      if (frame && typeof frame === "object" && "type" in frame && frame.type === "response") {
        settled = true;
        pendingCommandReplies.delete(lease);
      }
      if (owner && owner === transport && owner.connected && owner.operatorEpoch === epoch) owner.send(frame);
    };
    const id = cmd.id;
    const type: string = cmd.type;
    pendingCommandReplies.set(lease, reason => send(failure(id, type, reason)));
    commandsInFlight += 1;
    try {
      if (reapedRuntime) {
        send(failure(id, type, REAPED_RUNTIME_ERROR));
        return;
      }
      if (reloadRequested) {
        send(failure(id, type, "Pi runtime reload is in progress; retry after it completes."));
        return;
      }
      switch (type) {
        case "prompt":
          await handlePrompt(cmd, send);
          return;
        case "steer":
        case "follow_up": {
          if (typeof cmd.message !== "string") throw new Error("Message must be a string");
          if (/^\/(?:remote-reload|reload)(?:\s|$)/.test(cmd.message.trim())) {
            throw new Error("Reload must be sent as an ordinary prompt while Pi is idle.");
          }
          if (await handleBridgeManagement(cmd, send)) return;
          if (!isExtensionCommand(pi, cmd.message)) {
            const canDispatch = await preflightUserPrompt(id, type, send);
            if (!canDispatch()) return;
          }
          const result = await dispatchPaseoPrompt(pi, remoteUserContent(cmd.message, cmd.images) as any,
            cmd.message, false, err => debugLog(`queued prompt failed after acceptance: ${String(err)}`),
            commandNotices(send), type === "steer" ? "steer" : "followUp", promptAbortController.signal);
          send(success(id, type, result));
          return;
        }
        case "abort":
          // Abort admitted-but-not-started prompts too. Otherwise idle abort
          // could acknowledge while a preflight later launches the old run.
          promptAbortController.abort();
          promptAbortController = new AbortController();
          // Capture this lifecycle's context and signal. Never use ctx.signal:
          // that signal belongs to turn work, not the lifetime of this waiter.
          await abortAndWaitForIdle(latestCtx, { signal: preflightAbortController.signal });
          send(success(id, type));
          return;
        case "get_state":
          send(success(id, type, buildState()));
          return;
        case "get_pi_features":
        case "set_pi_feature":
          send(success(id, type, await handleNativeFeatureRequest(cmd, () => latestCtx, () => transport)));
          return;
        case "get_security_mode":
        case "set_security_mode": {
          const result = handleSecurityModeRequest(cmd, {
            context: () => latestCtx,
            transport: () => transport,
            service: () => (globalThis as Record<string, any>).__PAE_PERMISSION_GATE_OPERATOR_V1__,
          });
          if ("error" in result) send(failure(id, type, result.error));
          else send(success(id, type, result.data));
          return;
        }
        case "get_messages": {
          const sm = latestCtx?.sessionManager;
          const history = sm
            ? buildProjectedHistory(sm.getEntries(), sm.getLeafId(), sessionManagerApi)
            : { messages: [], projectedEntries: [] };
          const messages = projectSubagentMessages(history.messages);
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
          const ok = await applyRemoteModel(latestCtx?.model, model, async (nextModel) => {
            remoteAppliedModel = modelToId(nextModel);
            return pi.setModel(nextModel);
          });
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
          send(success(id, type, buildSessionStats(latestCtx)));
          return;
        case "get_commands":
          send(success(id, type, {
            commands: pi.getCommands(),
            // Enumeration is not an execution guarantee. Stock Pi exposes
            // third-party metadata without an observable command outcome API.
            bridgeCommandSupport: {
              owned: ["paseo-bridge", "remote-reload", CAPTURE_COMMAND],
              unsupported: [TREE_COMMAND, "reload"],
              arbitraryExtensionCommands: typeof (pi as any).dispatchExtensionCommand === "function",
              disconnectReceipt: "accepted",
              reloadReceipt: "accepted",
            },
          }));
          return;
        case "compact": {
          if (!latestCtx) throw new Error("No active session context");
          if (isCompacting) throw new Error("A Pi compaction is already running");
          // Reserve immediately: session_before_compact runs only after preparation.
          isCompacting = true;
          try {
            const result = await compactWithResult(latestCtx, cmd.customInstructions || undefined);
            send(success(id, type, result));
          } finally {
            isCompacting = false;
          }
          return;
        }
        case "set_auto_compaction":
          send(failure(id, type, "Auto-compaction control is unsupported by this Pi extension API"));
          return;
        case "extension_ui_response": {
          const requestId = String(cmd.id ?? "");
          const pending = pendingRemoteUiRequests.get(requestId);
          const value = cmd.cancelled === true ? undefined
            : pending?.method === "confirm" && typeof cmd.confirmed === "boolean" ? (cmd.confirmed ? "Yes" : "No")
            : typeof cmd.value === "string" ? cmd.value : undefined;
          finishRemoteUiRequest(requestId, value);
          return;
        }
        default:
          // Paseo uses Pi's native error text to detect optional RPCs. In
          // particular, 0.7.2 falls back from clear_queue before aborting.
          send(failure(id, type ?? "unknown", unknownRpcCommandError(type)));
      }
    } catch (err) {
      debugLog(`command ${type} failed: ${String(err)}`);
      send(failure(id, type ?? "unknown", err instanceof Error ? err.message : String(err)));
    } finally {
      pendingCommandReplies.delete(lease);
      commandsInFlight -= 1;
    }
  }

  function activePermissionGateOperatorDescriptor(): PermissionGateOperatorDescriptorV1 | undefined {
    const activeTransport = transport;
    const ctx = latestCtx;
    const agentId = currentAgentId;
    if (!activeTransport || !activeTransport.connected || !ctx || !agentId || currentSessionFile !== activeTransport.sessionFile) return undefined;
    const sessionId = ctx.sessionManager.getSessionId();
    if (typeof sessionId !== "string" || !sessionId) return undefined;
    return {
      version: 1,
      socketPath: permissionGateOperatorSocketPath(activeTransport.pipePath),
      capability: activeTransport.operatorCapability,
      agentId,
      sessionId,
      runtimeEpoch: activeTransport.operatorEpoch,
    };
  }

  function publishPermissionGateOperatorDescriptor(): void {
    const descriptor = activePermissionGateOperatorDescriptor();
    if (!descriptor) {
      revokePermissionGateOperatorDescriptor();
      return;
    }
    try {
      const service = (globalThis as Record<string, any>).__PAE_PERMISSION_GATE_OPERATOR_V1__;
      if (service?.version !== 1 || typeof service.status !== "function") {
        revokePermissionGateOperatorDescriptor();
        return;
      }
      const mode = service.status(descriptor.sessionId);
      if (mode?.sessionId !== descriptor.sessionId || typeof mode.enabled !== "boolean") {
        revokePermissionGateOperatorDescriptor();
        return;
      }
      writePermissionGateOperatorDescriptor(path.join(os.homedir(), ".pi", "paseo-bridge"), descriptor);
    } catch {
      // Missing/stale/non-guard authority must not leave an operator descriptor available.
      revokePermissionGateOperatorDescriptor();
    }
  }

  function publishSecurityModeChangeHint(): void {
    const activeTransport = transport;
    const ctx = latestCtx;
    if (!activeTransport?.connected || !ctx || currentSessionFile !== activeTransport.sessionFile) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const identityPrefix = `${sessionId}:${activeTransport.operatorEpoch}:`;
    let signature: string;
    try {
      const service = (globalThis as Record<string, any>).__PAE_PERMISSION_GATE_OPERATOR_V1__;
      if (service?.version !== 1 || typeof service.status !== "function") signature = `${identityPrefix}unavailable`;
      else {
        const state = service.status(sessionId);
        signature = state?.sessionId === sessionId && typeof state.enabled === "boolean"
          ? `${identityPrefix}available:${state.enabled}` : `${identityPrefix}unavailable`;
      }
    } catch { signature = `${identityPrefix}unavailable`; }
    signature += JSON.stringify(featureSnapshot(sessionId));
    if (signature === lastSecurityModeStatus) return;
    lastSecurityModeStatus = signature;
    // This is only a hint; Paseo re-reads authoritative status over the main RPC.
    send({ type: "security_mode_changed" });
  }

  function revokePermissionGateOperatorDescriptor(): void {
    if (!transport || !currentAgentId) return;
    removePermissionGateOperatorDescriptor(
      path.join(os.homedir(), ".pi", "paseo-bridge"), currentAgentId, transport.operatorEpoch,
    );
  }

  function resolveExactLiveChildLink(ownerSessionId: string, item: any) {
    return resolvePaseoChildRuntimeLink(ownerSessionId, item);
  }

  function publishHarnessReadOnlyDescriptor(): void {
    const activeTransport = transport;
    const ctx = latestCtx;
    const agentId = currentAgentId;
    if (!activeTransport || !activeTransport.connected || !ctx || !agentId || currentSessionFile !== activeTransport.sessionFile) {
      revokeHarnessReadOnlyDescriptor(); return;
    }
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if (typeof sessionId !== "string" || !sessionId) throw new Error("Session unavailable");
      writeHarnessReadOnlyDescriptor(path.join(os.homedir(), ".pi", "paseo-bridge"), {
        version: 1, socketPath: activeTransport.harnessReadOnlySocketPath,
        capability: activeTransport.harnessReadOnlyCapability, agentId, sessionId, runtimeEpoch: activeTransport.operatorEpoch,
      });
    } catch { revokeHarnessReadOnlyDescriptor(); }
  }

  function revokeHarnessReadOnlyDescriptor(): void {
    if (transport && currentAgentId) removeHarnessReadOnlyDescriptor(
      path.join(os.homedir(), ".pi", "paseo-bridge"), currentAgentId, transport.operatorEpoch,
    );
  }

  function activeForegroundTasksService() {
    const service = (globalThis as Record<string, any>).__paeForegroundTasksV1;
    const ctx = latestCtx;
    if (!service || service.protocol !== 1 || typeof service.sessionId !== "string" || typeof service.epoch !== "string"
      || typeof service.execute !== "function" || !ctx || service.sessionId !== ctx.sessionManager.getSessionId()) return undefined;
    return service;
  }

  function activeForegroundTasksDescriptor() {
    const activeTransport = transport, ctx = latestCtx, agentId = currentAgentId, service = activeForegroundTasksService();
    if (!activeTransport || !activeTransport.connected || !ctx || !agentId || !service || currentSessionFile !== activeTransport.sessionFile) return undefined;
    return { version: 1 as const, socketPath: foregroundTasksSocketPath(activeTransport.pipePath), capability: activeTransport.foregroundTasksCapability,
      agentId, sessionId: ctx.sessionManager.getSessionId(), runtimeEpoch: activeTransport.operatorEpoch, serviceEpoch: service.epoch };
  }

  function publishForegroundTasksDescriptor(): void {
    const descriptor = activeForegroundTasksDescriptor();
    if (!descriptor) { revokeForegroundTasksDescriptor(); return; }
    try { writeForegroundTasksDescriptor(path.join(os.homedir(), ".pi", "paseo-bridge"), descriptor); }
    catch { revokeForegroundTasksDescriptor(); }
  }

  function revokeForegroundTasksDescriptor(): void {
    if (transport && currentAgentId) removeForegroundTasksDescriptor(
      path.join(os.homedir(), ".pi", "paseo-bridge"), currentAgentId, transport.operatorEpoch,
    );
  }

  function activeWorkflowsService() {
    const service = (globalThis as any).__paeWorkflowsV1;
    return service?.protocol === 1 && service.sessionId === latestCtx?.sessionManager.getSessionId()
      && typeof service.serviceEpoch === "string" && typeof service.handle === "function" ? service : undefined;
  }
  function activeWorkflowsDescriptor() {
    const t = transport, ctx = latestCtx, service = activeWorkflowsService();
    if (!t?.connected || !ctx || !currentAgentId || !service || currentSessionFile !== t.sessionFile) return undefined;
    return { version: 1 as const, socketPath: workflowsSocketPath(t.pipePath), capability: t.workflowsCapability,
      agentId: currentAgentId, sessionId: ctx.sessionManager.getSessionId(), runtimeEpoch: t.operatorEpoch, serviceEpoch: service.serviceEpoch };
  }
  function revokeWorkflowsDescriptor() { if (transport && currentAgentId) removeWorkflowsDescriptor(path.join(os.homedir(), ".pi", "paseo-bridge"), currentAgentId, transport.operatorEpoch); }
  function publishWorkflowsDescriptor() {
    const descriptor = activeWorkflowsDescriptor();
    if (!descriptor) { revokeWorkflowsDescriptor(); return; }
    try { writeWorkflowsDescriptor(path.join(os.homedir(), ".pi", "paseo-bridge"), descriptor); } catch { revokeWorkflowsDescriptor(); }
  }
  function activeBtwService() {
    const service = (globalThis as any).__paeBtwV1;
    return service?.protocol === 1 && service.sessionId === latestCtx?.sessionManager.getSessionId()
      && typeof service.serviceEpoch === "string" && typeof service.handle === "function" ? service : undefined;
  }
  function activeBtwDescriptor() {
    const t = transport, ctx = latestCtx, service = activeBtwService();
    if (!t?.connected || !ctx || !currentAgentId || !service || currentSessionFile !== t.sessionFile) return undefined;
    return { version: 1 as const, socketPath: btwSocketPath(t.pipePath), capability: t.btwCapability,
      agentId: currentAgentId, sessionId: ctx.sessionManager.getSessionId(), runtimeEpoch: t.operatorEpoch, serviceEpoch: service.serviceEpoch };
  }
  function revokeBtwDescriptor() {
    if (transport && currentAgentId) removeBtwDescriptor(path.join(os.homedir(), ".pi", "paseo-bridge"), currentAgentId, transport.operatorEpoch);
  }
  function publishBtwDescriptor() {
    const descriptor = activeBtwDescriptor();
    if (!descriptor) { revokeBtwDescriptor(); return; }
    try { writeBtwDescriptor(path.join(os.homedir(), ".pi", "paseo-bridge"), descriptor); } catch { revokeBtwDescriptor(); }
  }

  function activeAccountControlsService() {
    const service = (globalThis as Record<string, any>).__paeAccountControlsV1;
    const sessionId = latestCtx?.sessionManager.getSessionId();
    if (!service || service.protocol !== 1 || typeof service.sessionId !== "string" || typeof service.serviceEpoch !== "string"
      || typeof service.getSnapshot !== "function" || typeof service.switchAccount !== "function" || !sessionId || service.sessionId !== sessionId) return undefined;
    return service;
  }
  function activeAccountControlsDescriptor() {
    const t = transport, ctx = latestCtx, agentId = currentAgentId, service = activeAccountControlsService();
    if (!t || !t.connected || !ctx || !agentId || !service || currentSessionFile !== t.sessionFile) return undefined;
    return { version: 1 as const, socketPath: accountControlsSocketPath(t.pipePath), capability: t.accountControlsCapability,
      agentId, sessionId: ctx.sessionManager.getSessionId(), runtimeEpoch: t.operatorEpoch, serviceEpoch: service.serviceEpoch };
  }
  function publishAccountControlsDescriptor() {
    publishWorkflowsDescriptor();
    publishBtwDescriptor();
    const descriptor = activeAccountControlsDescriptor();
    if (!descriptor) { revokeAccountControlsDescriptor(); return; }
    try { writeAccountControlsDescriptor(path.join(os.homedir(), ".pi", "paseo-bridge"), descriptor); } catch { revokeAccountControlsDescriptor(); }
  }
  function revokeAccountControlsDescriptor() {
    if (transport && currentAgentId) removeAccountControlsDescriptor(path.join(os.homedir(), ".pi", "paseo-bridge"), currentAgentId, transport.operatorEpoch);
  }

  function bindTransport(): void {
    transport?.bind({
      command: handleCommand,
      async harnessReadOnly(request: any) {
        const lifecycle = readOnlySessionLifecycle;
        const activeTransport = transport;
        const ctx = latestCtx;
        const agentId = currentAgentId;
        if (!activeTransport || !ctx || !agentId || !activeTransport.connected || currentSessionFile !== activeTransport.sessionFile
          || request.agentId !== agentId || request.sessionId !== ctx.sessionManager.getSessionId()
          || request.runtimeEpoch !== activeTransport.operatorEpoch || request.capability !== activeTransport.harnessReadOnlyCapability) {
          throw new Error("Read-only harness authentication failed");
        }
        const method = request.method;
        const registryKey = method === "observability.snapshot" || (method === "status" && !(globalThis as any).__paeHarnessReadOnlyV1)
          ? "__paeObservabilityV1" : "__paeHarnessReadOnlyV1";
        let service: any;
        const assertCurrent = () => {
          const liveRegistry = (globalThis as any)[registryKey];
          const liveService = method === "observability.snapshot" ? liveRegistry?.[request.payload?.feature] : method.startsWith("jobs.") ? liveRegistry?.jobs : method.startsWith("subagents.") ? liveRegistry?.subagents : undefined;
          if (transport !== activeTransport || !sameReadOnlySession(lifecycle, readOnlySessionLifecycle, request.sessionId, latestCtx) || currentAgentId !== agentId
            || currentSessionFile !== activeTransport.sessionFile || !activeTransport.connected
            || ctx.sessionManager.getSessionId() !== request.sessionId || activeTransport.operatorEpoch !== request.runtimeEpoch
            || activeTransport.harnessReadOnlyCapability !== request.capability
            || liveRegistry !== registry || (service && liveService !== service)) throw new Error("Read-only harness session changed during request");
        };
        const registry = (globalThis as any)[registryKey];
        if (!registry || registry.protocol !== 1) throw new Error("Read-only harness service unavailable");
        const payload = request.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.sessionId !== request.sessionId) throw new Error("Invalid read-only payload");
        const exactKeys = (required: string[], optional: string[] = []) => {
          const keys = Object.keys(payload);
          return required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key));
        };
        if (method === "status") {
          if (!exactKeys(["sessionId"])) throw new Error("Unexpected status payload fields");
          assertCurrent();
          return { available: true, sessionId: request.sessionId,
          jobs: Boolean(registry.jobs?.protocol === 1 && registry.jobs.sessionId === request.sessionId),
          subagents: Boolean(registry.subagents?.protocol === 1 && registry.subagents.sessionId === request.sessionId) };
        }
        if (method === "observability.snapshot") {
          if (!exactKeys(["sessionId", "feature"]) || !["stamp", "progress", "cache"].includes(payload.feature)) throw new Error("Invalid observability request");
          service = registry[payload.feature];
          if (!service || service.protocol !== 1 || service.sessionId !== request.sessionId) throw new Error("Observability extension is not active for this session");
          const snapshot = await service.snapshot({ sessionId: request.sessionId });
          assertCurrent();
          if (snapshot?.protocol !== 1 || snapshot.sessionId !== request.sessionId || snapshot.feature !== payload.feature || Buffer.byteLength(JSON.stringify(snapshot)) > 48 * 1024) throw new Error("Invalid observability snapshot");
          return snapshot;
        }
        service = method.startsWith("jobs.") ? registry.jobs : method.startsWith("subagents.") ? registry.subagents : undefined;
        if (!service || service.protocol !== 1 || service.sessionId !== request.sessionId) throw new Error("Read-only service unavailable for this session");
        if (method === "jobs.list" || method === "subagents.list") {
          if (!exactKeys(["sessionId"], ["limit", "cursor"])) throw new Error("Unexpected list payload fields");
          const { sessionId, limit, cursor } = payload;
          if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) throw new Error("Invalid page limit");
          if (cursor !== undefined && (typeof cursor !== "string" || Buffer.byteLength(cursor) > 1024)) throw new Error("Invalid page cursor");
          const page = await service.list({ sessionId, ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) });
          assertCurrent();
          // Resolve a child chat only when its detail is opened. Scanning the
          // runtime registry once per list row is expensive on shared homes.
          return page;
        }
        if (method === "subagents.independentSource") {
          if (!exactKeys(["sessionId", "taskId", "childId", "attempt", "runtimeId"])
            || !/^subagent-task-[0-9a-f]{24}$/.test(payload.taskId) || !/^subagent-child-[0-9a-f]{24}$/.test(payload.childId)
            || !Number.isSafeInteger(payload.attempt) || payload.attempt < 1
            || (payload.runtimeId !== null && (typeof payload.runtimeId !== "string" || payload.runtimeId.length > 256))) throw new Error("Invalid independent source request");
          if (typeof service.independentSource !== "function") throw new Error("Reload Pi to enable independent conversations");
          const result = await service.independentSource(payload);
          assertCurrent();
          if (result.sessionId !== request.sessionId || Buffer.byteLength(JSON.stringify(result)) > 16384) throw new Error("Invalid independent source response");
          return result;
        }
        if (method === "subagents.conversation") {
          if (!exactKeys(["sessionId", "taskId", "childId", "attempt", "runtimeId"], ["cursor"])
            || !/^subagent-task-[0-9a-f]{24}$/.test(payload.taskId)
            || !/^subagent-child-[0-9a-f]{24}$/.test(payload.childId)
            || !Number.isSafeInteger(payload.attempt) || payload.attempt < 1
            || (payload.runtimeId !== null && (typeof payload.runtimeId !== "string" || payload.runtimeId.length > 256))
            || (payload.cursor !== undefined && (!Number.isSafeInteger(payload.cursor) || payload.cursor < 0))) throw new Error("Invalid conversation request");
          if (typeof service.conversation !== "function") throw new Error("Reload Pi to enable retained conversations");
          const result = await service.conversation(payload);
          assertCurrent();
          assertReadOnlyConversationResponse(result, request.sessionId);
          if (result.item && (result.item.taskId !== payload.taskId || result.item.childId !== payload.childId
            || result.item.attempt !== payload.attempt || result.item.runtimeId !== payload.runtimeId)) throw new Error("Conversation identity changed");
          return result;
        }
        if (["jobs.output", "subagents.report"].includes(method)) {
          const key = method === "jobs.output" ? "jobId" : "taskId";
          if (!exactKeys(["sessionId", key], ["maxBytes"])) throw new Error("Unexpected detail payload fields");
          if (typeof payload[key] !== "string" || !payload[key] || Buffer.byteLength(payload[key]) > 128) throw new Error("Invalid read-only item ID");
          const maxBytes = payload.maxBytes ?? 48 * 1024;
          if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 48 * 1024) throw new Error("Invalid read-only byte limit");
          if (method === "jobs.output") {
            const output = await service.output({ sessionId: request.sessionId, jobId: payload.jobId, maxBytes });
            assertCurrent();
            return output;
          }
          const report = await service.report({ sessionId: request.sessionId, taskId: payload.taskId, maxBytes });
          assertCurrent();
          if (!report?.item || typeof report.item.taskId !== "string" || typeof report.item.childId !== "string"
            || typeof report.item.groupId !== "string" || typeof report.item.runtimeId !== "string" || !Number.isSafeInteger(report.item.attempt)) return report;
          const link = resolveExactLiveChildLink(request.sessionId, report.item);
          return link.available ? { ...report, item: { ...report.item, paseoAgentId: link.agentId, paseoWorkspaceId: link.workspaceId } } : report;
        }
        throw new Error("Unsupported read-only harness method");
      },
      workflowsIdentity() { return activeWorkflowsDescriptor(); },
      async workflows(request: any) {
        const service = activeWorkflowsService(), identity = activeWorkflowsDescriptor(), t = transport, ctx = latestCtx;
        if (!service || !identity || !t || !ctx || request?.sessionId !== identity.sessionId || request?.serviceEpoch !== identity.serviceEpoch) throw new Error("Workflow session unavailable");
        const result = await service.handle(request);
        // Goal can start a turn while this request settles. Fresh event-context wrappers
        // are expected; bind to session/runtime/service identity, not wrapper identity.
        if (transport !== t || activeWorkflowsService() !== service || !t.connected || t.operatorEpoch !== identity.runtimeEpoch || currentAgentId !== identity.agentId
          || currentSessionFile !== t.sessionFile || latestCtx?.sessionManager.getSessionId() !== identity.sessionId) throw new Error("Workflow session changed");
        return result;
      },
      btwIdentity() { return activeBtwDescriptor(); },
      async btw(request: any) {
        const service = activeBtwService(), identity = activeBtwDescriptor(), t = transport, ctx = latestCtx;
        if (!service || !identity || !t || !ctx || request?.sessionId !== identity.sessionId || request?.serviceEpoch !== identity.serviceEpoch) throw new Error("BTW session unavailable");
        const result = await service.handle(request);
        if (transport !== t || latestCtx !== ctx || activeBtwService() !== service || !t.connected || t.operatorEpoch !== identity.runtimeEpoch || currentAgentId !== identity.agentId) throw new Error("BTW session changed");
        return result;
      },
      accountControlsIdentity() {
        const descriptor = activeAccountControlsDescriptor();
        return descriptor ? { ...descriptor, capability: transport!.accountControlsCapability } : undefined;
      },
      async accountControls(request: any) {
        const service = activeAccountControlsService(), identity = activeAccountControlsDescriptor(), t = transport, ctx = latestCtx;
        if (!service || !identity || !t || !ctx) throw new Error("Account-controls service unavailable or stale");
        const assertCurrent = () => {
          if (transport !== t || (globalThis as any).__paeAccountControlsV1 !== service || activeAccountControlsService() !== service || !t.connected
            || currentAgentId !== identity.agentId || currentSessionFile !== t.sessionFile || latestCtx?.sessionManager.getSessionId() !== identity.sessionId || t.operatorEpoch !== identity.runtimeEpoch)
            throw new Error("Account-controls identity changed during request");
        };
        // An older producer can ignore extra fields. Never let a Codex mutation
        // fall through to that producer's OpenAI-only management implementation.
        if ((request?.operation === "switch" || request?.operation === "manage") && request.request?.providerId === "openai-codex") {
          const snapshot = await service.getSnapshot({ sessionId: identity.sessionId, providerId: "openai-codex" });
          assertCurrent();
          if (snapshot?.providerId !== "openai-codex" || !snapshot.supportedProviders?.includes("openai-codex") || snapshot.sessionId !== identity.sessionId || snapshot.serviceEpoch !== identity.serviceEpoch)
            throw new Error("Codex account controls require a provider-aware Pi account service. Reload Pi.");
        }
        let result: unknown;
        if (request?.operation === "snapshot" && request.sessionId === identity.sessionId && (request.providerId === undefined || request.providerId === "openai" || request.providerId === "openai-codex")) result = await service.getSnapshot({ sessionId: identity.sessionId, ...(request.providerId === undefined ? {} : { providerId: request.providerId }) });
        else if (request?.operation === "switch" && request.request?.expectedSessionId === identity.sessionId && request.request?.expectedServiceEpoch === identity.serviceEpoch) result = await service.switchAccount(request.request);
        else if (request?.operation === "manage" && request.request?.sessionId === identity.sessionId) result = await service.manageAccount(request.request);
        else throw new Error("Invalid account-controls operation");
        assertCurrent();
        return result;
      },
      foregroundTasksIdentity() {
        const descriptor = activeForegroundTasksDescriptor();
        const service = activeForegroundTasksService();
        if (!descriptor || !service) return undefined;
        return { ...descriptor, service };
      },
      async foregroundTasks(request: any) {
        const service = activeForegroundTasksService();
        const identity = activeForegroundTasksDescriptor();
        const activeTransport = transport;
        const ctx = latestCtx;
        if (!service || !identity || !activeTransport || !ctx || request?.sessionId !== service.sessionId || request?.epoch !== service.epoch) {
          throw new Error("Foreground-task service unavailable or stale");
        }
        const result = await service.execute(request);
        if (transport !== activeTransport || latestCtx !== ctx || activeForegroundTasksService() !== service
          || !activeTransport.connected || currentAgentId !== identity.agentId || currentSessionFile !== activeTransport.sessionFile
          || ctx.sessionManager.getSessionId() !== identity.sessionId || activeTransport.operatorEpoch !== identity.runtimeEpoch) {
          throw new Error("Foreground-task identity changed during request");
        }
        return result;
      },
      permissionGateOperator() {
        const descriptor = activePermissionGateOperatorDescriptor();
        const activeTransport = transport;
        const ctx = latestCtx;
        const agentId = currentAgentId;
        if (!descriptor || !activeTransport || !ctx || !agentId) return undefined;
        const identity: PermissionGateOperatorIdentityV1 = {
          descriptor,
          authority() {
            if (transport !== activeTransport || latestCtx !== ctx || currentAgentId !== agentId
              || currentSessionFile !== activeTransport.sessionFile || !activeTransport.connected
              || ctx.sessionManager.getSessionId() !== descriptor.sessionId) return undefined;
            const service = (globalThis as Record<string, any>).__PAE_PERMISSION_GATE_OPERATOR_V1__;
            if (service?.version !== 1 || typeof service.status !== "function" || typeof service.applyMode !== "function") return undefined;
            return service;
          },
        };
        return identity;
      },
      forkSnapshot() {
        const sm = latestCtx?.sessionManager;
        if (!sm || reloadRequested) throw new Error("Native session snapshot unavailable");
        // Cursor and compact context metadata are captured atomically. Historical
        // text stays on disk; only tool-exchange validity crosses the socket.
        return {
          sessionFile: sm.getSessionFile(),
          leafId: sm.getLeafId(),
          messages: buildSessionContext(sm.getEntries(), sm.getLeafId()).messages.map((message: any) => ({
            role: message.role,
            ...(message.role === "toolResult" ? { toolCallId: message.toolCallId } : {}),
            content: Array.isArray(message.content)
              ? message.content.filter((block: any) => block.type === "toolCall").map((block: any) => ({ type: "toolCall", id: block.id }))
              : [],
          })),
        };
      },
      attached() {
        publishPermissionGateOperatorDescriptor();
        publishHarnessReadOnlyDescriptor();
        publishForegroundTasksDescriptor();
        publishAccountControlsDescriptor();
        providerReconnect.connected();
        debugLog("client connected");
        notifyTui("Paseo attached to this session");
        emitEntryCapture(latestCtx, "session_start");
      },
      detached() {
        revokePermissionGateOperatorDescriptor();
        revokeHarnessReadOnlyDescriptor();
        revokeForegroundTasksDescriptor();
        revokeAccountControlsDescriptor();
        revokeBtwDescriptor();
        revokeWorkflowsDescriptor();
        for (const reject of [...pendingCommandReplies.values()]) reject("Paseo controller disconnected before the command completed; its outcome is unknown.");
        transport?.rotateOperatorEpoch();
        cancelPendingRemoteUiRequests();
        preflightAbortController.abort();
        preflightAbortController = new AbortController();
        providerReconnect.trigger();
        debugLog("client disconnected");
      },
      error: (error) => debugLog(`bridge transport error: ${String(error)}`),
    });
  }

  function stopServer(): void {
    revokePermissionGateOperatorDescriptor();
    revokeHarnessReadOnlyDescriptor();
    revokeForegroundTasksDescriptor();
    revokeAccountControlsDescriptor();
    revokeBtwDescriptor();
    revokeWorkflowsDescriptor();
    providerReconnect.stop();
    cancelPendingRemoteUiRequests();
    preflightAbortController.abort();
    transport?.close();
    transport = null;
    currentSessionFile = null;
    currentAgentId = null;
    remoteAppliedModel = null;
    remoteAppliedThinking = null;
    titleAttempted = false;
  }

  function startServer(sessionFile: string): void {
    assertNoLiveRuntimeOwner(sessionFile, { ignorePid: process.pid });
    // connectSession stops the previous server even on first connection.
    // Its aborted signal belongs to that old lifecycle, never the new server.
    preflightAbortController = new AbortController();
    transport = new BridgeTransport(sessionFile, pipePathForSession(sessionFile));
    currentSessionFile = sessionFile;
    bindTransport();
    transport.start();
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
      try {
        const existing = JSON.parse(fs.readFileSync(destination, "utf8"));
        if (existing.lifecycle === "reaped") {
          reapedRuntime ??= { workerEpoch: existing.workerEpoch, reapSealedAt: existing.reapSealedAt };
          return; // A reload or late timer must never erase an explicit reap.
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const temporary = `${destination}.${process.pid}.tmp`;
      const placement = resolveTmuxIdentity();
      const target = parseTmuxTarget();
      const sameProject = target && target.tmuxSocket === placement.tmuxSocket
        && target.tmuxServerId === placement.tmuxServerId && target.tmuxSessionId === placement.tmuxSessionId;
      const workspaceId = process.platform === "linux" && (target || process.env.PASEO_TMUX_TOPOLOGY === "1")
        && placement.tmuxSocket && placement.tmuxServerId && placement.tmuxWindowId
        ? workspaceIdForPlacement(placement) : null;
      fs.writeFileSync(temporary, `${JSON.stringify({
        schemaVersion: 2,
        lifecycle: reapedRuntime ? "reaped" : "active",
        ...(reapedRuntime ?? {}),
        projectId: sameProject ? target.projectId : null,
        workspaceId,
        tmuxServerId: placement.tmuxServerId ?? null,
        ...harnessRuntimeMetadata(),
        processStartToken: processStartToken(),
        sessionFile: path.resolve(sessionFile),
        bridgeSocket: pipePathForSession(sessionFile),
        agentId: currentAgentId ?? (reapedRuntime ? readAgentMap()[agentMapKey(sessionFile)] ?? null : null),
        cwd,
        pid: process.pid,
        tuiKind: process.env.PI_SUPERVISED === "1" ? "supervised" : "unsafe",
        forkCreated: process.env.PI_PASEO_FORK_CREATED !== "0" && !process.env.PI_HARNESS_RUNTIME_ID?.trim() && Boolean(process.env.PI_PASEO_EXISTING_AGENT_ID?.trim()),
        ...placement,
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
      if (record?.pid === process.pid && record.lifecycle !== "reaped") fs.unlinkSync(destination);
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

  function tagAgentPane(placement = resolveTmuxIdentity()): void {
    if (process.platform !== "linux" || !currentAgentId || !placement.tmuxPane) return;
    const key = JSON.stringify([placement.tmuxSocket, placement.tmuxPane, currentAgentId]);
    if (key !== lastAgentTag && markPaseoAgentPane(placement, currentAgentId, undefined, paneOwnerIdentity)) {
      lastAgentTag = key;
      ownedPaneTag = { placement, agentId: currentAgentId };
    }
  }

  function stopCanonicalNameSync(): void {
    canonicalNameSync?.close();
    canonicalNameSync = undefined;
    canonicalNameBinding = undefined;
    const connection = canonicalNameConnection;
    canonicalNameConnection = null;
    connection?.close();
  }

  function startCanonicalNameSync(): void {
    if (process.env.PI_SUBAGENT_CANONICAL_NAMES !== "1" || lifecycleClosed || !latestCtx || !currentAgentId) return;
    const operator = (globalThis as any).__paeCanonicalTaskNameV1;
    const sessionId = latestCtx.sessionManager.getSessionId();
    if (operator?.protocol !== 1 || operator.sessionId !== sessionId) return;
    if (canonicalNameBinding?.agentId === currentAgentId && canonicalNameBinding.operator === operator) {
      canonicalNameSync?.changed();
      return;
    }
    stopCanonicalNameSync();
    const agentId = currentAgentId;
    const sessionFile = currentSessionFile;
    const binding = { agentId, sessionId, operator };
    const isCurrent = () => !lifecycleClosed && currentAgentId === agentId && currentSessionFile === sessionFile
      && latestCtx?.sessionManager.getSessionId() === sessionId && (globalThis as any).__paeCanonicalTaskNameV1 === operator;
    let sync: CanonicalNameSync;
    let sawSubscribedName = false;
    const connection = openPaseoWs(message => {
      if (!isCurrent() || message?.type !== "agent_update" || message.payload?.kind !== "upsert") return;
      const agent = message.payload.agent;
      if (agent?.id === agentId) { sawSubscribedName = true; sync?.observe(agent.title ?? null, message.payload); }
    }, () => {
      if (canonicalNameBinding === binding) stopCanonicalNameSync();
    });
    if (!connection) return;
    canonicalNameBinding = binding;
    canonicalNameConnection = connection;
    sync = new CanonicalNameSync({ authority: operator, isCurrent,
      warn: message => { debugLog(message); notifyTui(message); notifyEvent(message); },
      write: async (name, updateAgent) => {
        if (!isCurrent()) throw new Error("Stale canonical naming session");
        if (updateAgent) {
          const result = await connection.request(requestId => ({ type: "update_agent_request", agentId, name, requestId }));
          if (result.accepted !== true) throw new Error(result.error ?? "Native title update rejected");
        }
        if (isCurrent() && !await setPaseoWorkspaceTitle(agentId, name)) throw new Error("Native workspace title update unavailable");
      },
    });
    canonicalNameSync = sync;
    // Directory subscription includes background titles only; it never moves,
    // promotes, imports, or recreates a worker or its existing chat.
    void connection.request(requestId => ({ type: "fetch_agents_request", requestId, includeBackground: true, subscribe: {}, page: { limit: 1 } }))
      .then(() => connection.request(requestId => ({ type: "fetch_agent_request", agentId, requestId })))
      .then(result => {
        if (!isCurrent() || result.agent?.id !== agentId) return;
        if (!sawSubscribedName) sync.observe(result.agent.title ?? null);
      }).catch(error => {
        if (canonicalNameBinding === binding) { debugLog(`canonical name subscription failed: ${String(error)}`); stopCanonicalNameSync(); }
      });
  }

  const unsubscribeCanonicalName = pi.events.on("subagent-name-changed", () => {
    startCanonicalNameSync();
    canonicalNameSync?.changed();
  });
  pi.on("session_info_changed", () => {
    startCanonicalNameSync();
    canonicalNameSync?.changed();
  });

  function adoptAgent(agentId: string, reused: boolean): void {
    if (currentAgentId && currentAgentId !== agentId && transport) {
      removePermissionGateOperatorDescriptor(
        path.join(os.homedir(), ".pi", "paseo-bridge"), currentAgentId, transport.operatorEpoch,
      );
      removeHarnessReadOnlyDescriptor(path.join(os.homedir(), ".pi", "paseo-bridge"), currentAgentId, transport.operatorEpoch);
    }
    if (currentAgentId !== agentId) stopCanonicalNameSync();
    currentAgentId = agentId;
    startCanonicalNameSync();
    publishPermissionGateOperatorDescriptor();
    publishHarnessReadOnlyDescriptor();
    tagAgentPane();
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
    if (reapedRuntime || importAttempted.has(sessionFile) || lifecycleClosed || Date.now() < importRetryAt) return;
    // Harness staging panes are real TUIs but not separate Paseo tabs yet.
    // The placement timer imports them automatically after promotion.
    if (resolveTmuxIdentity().infrastructure) return;
    const isCurrent = () => !lifecycleClosed && currentSessionFile === sessionFile;
    importAttempted.add(sessionFile);
    const assignedAgentId = process.env.PI_PASEO_EXISTING_AGENT_ID?.trim();
    if (assignedAgentId) {
      writeAgentMapEntry(sessionFile, assignedAgentId);
      adoptAgent(assignedAgentId, true);
      return;
    }
    if (!isImportEnabled()) return;
    const cli = resolvePaseoCli();
    if (!cli) {
      debugLog("paseo CLI not found; session will not auto-appear (set PASEO_CLI)");
      return;
    }
    const hostArgs = process.env.PASEO_HOST ? ["--host", process.env.PASEO_HOST] : [];
    const retryImport = () => {
      // Projection may lag startup or reconnect. These failures occur before
      // import allocation, so keep retrying slowly instead of latching forever.
      const delay = importRetryDelay(++importFailures) ?? 60_000;
      importRetryAt = Date.now() + delay;
      importAttempted.delete(sessionFile);
    };
    const runImport = () => {
      let args: string[];
      try {
        args = paseoImportArgs({ sessionFile, cwd, host: process.env.PASEO_HOST,
          topology: process.platform === "linux" && process.env.PASEO_TMUX_TOPOLOGY === "1", placement: resolveTmuxIdentity() });
      } catch (error) {
        debugLog(String(error));
        retryImport();
        return;
      }
      runPaseoCli(cli, args, (code, output) => {
        if (!isCurrent()) return;
        debugLog(`paseo import exited ${code}: ${output.slice(0, 500)}`);
        if (code !== 0) {
          if (process.platform === "linux" && process.env.PASEO_TMUX_TOPOLOGY === "1" && retryableWorkspaceImportFailure(code, output)) retryImport();
          return;
        }
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
      if (!isCurrent()) return;
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
        if (!isCurrent()) return;
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
    importFailures = 0;
    importRetryAt = 0;
    registerWithPaseo(file, ctx.cwd);
    return "Connecting session to Paseo...";
  }

  pi.on("session_start", async (event, ctx) => {
    readOnlySessionLifecycle = {};
    preflightAbortController.abort();
    preflightAbortController = new AbortController();
    latestCtx = ctx;
    const retained = event.reason === "reload"
      ? takeBridgeAfterReload(ctx.sessionManager.getSessionFile())
      : (discardRetainedBridge(), undefined);
    try {
      const force = ["1", "true", "on"].includes((process.env.PI_PASEO_BRIDGE_FORCE ?? "").toLowerCase());
      if (ctx.mode !== "tui" && !force) {
        retained?.transport.close();
        if (event.reason === "reload" && ctx.hasUI) ctx.ui.notify("Pi runtime reloaded.", "info");
        return;
      }
      if (retained) {
        transport = retained.transport;
        currentSessionFile = transport.sessionFile;
        currentAgentId = retained.agentId;
        titleAttempted = retained.titleAttempted;
        bindTransport();
        writeRuntimeRecord(currentSessionFile, ctx.cwd);
        // Keep the existing provider and socket. Restarting it here would turn
        // a harmless extension reload into a Paseo process_exit/tombstone.
        if (currentAgentId) {
          importAttempted.add(currentSessionFile);
          if (!remoteUiConnected()) providerReconnect.trigger();
        } else registerWithPaseo(currentSessionFile, ctx.cwd);
      } else {
        if (!isAutoEnabled()) return;
        connectSession(ctx);
      }
      markTmuxPane(true);
      lastPlacement = JSON.stringify(resolveTmuxIdentity());
      placementTimer = setInterval(() => {
        if (lifecycleClosed || !currentSessionFile || !latestCtx) return;
        const placement = resolveTmuxIdentity();
        const signature = JSON.stringify(placement);
        if (signature !== lastPlacement) {
          lastPlacement = signature;
          writeRuntimeRecord(currentSessionFile, latestCtx.cwd);
        }
        publishPermissionGateOperatorDescriptor();
        publishSecurityModeChangeHint();
        publishHarnessReadOnlyDescriptor();
        publishForegroundTasksDescriptor();
        publishAccountControlsDescriptor();
        startCanonicalNameSync();
        if (!placement.infrastructure && !currentAgentId) registerWithPaseo(currentSessionFile, latestCtx.cwd);
        tagAgentPane(placement);
      }, 2000);
      placementTimer.unref?.();
      if (event.reason === "reload") notifyEvent("Pi runtime reloaded. Background jobs were not cancelled.");
    } catch (err) {
      retained?.transport.close();
      debugLog(`session_start failed: ${String(err)}`);
    }
  });

  pi.on("session_shutdown", async (event) => {
    readOnlySessionLifecycle = {};
    // Reload retains the controller socket: settle old command RPCs before its
    // owner is suspended, rather than hanging them or replying into a new binding.
    for (const reject of [...pendingCommandReplies.values()]) {
      reject(event.reason === "reload"
        ? "Pi runtime reloaded before the command completed; its outcome is unknown."
        : "Pi session closed before the command completed; its outcome is unknown.");
    }
    lifecycleClosed = true;
    stopCanonicalNameSync();
    preflightAbortController.abort();
    latestCtx = null;
    unsubscribeReaping();
    unsubscribeCanonicalName();
    if (placementTimer) clearInterval(placementTimer);
    placementTimer = undefined;
    if (event.reason === "reload" && transport) {
      revokePermissionGateOperatorDescriptor();
      revokeHarnessReadOnlyDescriptor();
      revokeForegroundTasksDescriptor();
      revokeAccountControlsDescriptor();
      revokeBtwDescriptor();
      revokeWorkflowsDescriptor();
      providerReconnect.stop();
      cancelPendingRemoteUiRequests();
      preflightAbortController.abort();
      retainBridgeForReload(transport, currentAgentId, titleAttempted);
      transport = null;
    } else {
      discardRetainedBridge();
      if (currentSessionFile) removeRuntimeRecord(currentSessionFile);
      markTmuxPane(false);
      stopServer();
    }
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
    "agent_settled",
  ] as const;
  for (const eventName of forwardEvents) {
    (pi as any).on(eventName, async (event: unknown, ctx: ExtensionContext) => {
      latestCtx = ctx;
      const normalized = normalizePiEventForPaseo(event);
      for (const visible of turnVisibility.project(normalized as Record<string, any>)) {
        for (const projected of subagentTaskProjection.project(visible)) {
          send(projected);
        }
      }
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
    if (process.env.PI_SUBAGENT_CANONICAL_NAMES === "1") {
      startCanonicalNameSync();
      return; // Worker/task authority owns names; never ask an LLM for another title.
    }
    if (titleAttempted || !currentAgentId) return;
    // Legacy NO_TITLE disables all automatic title handling. The declarative
    // generation option only prevents a model call, not cost-free name sync.
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
    if (!isTitleGenerationEnabled()) return;
    const firstMessage = capturedUserEntries(ctx)[0]?.text?.trim();
    if (!firstMessage) {
      debugLog("title generation: no user message in session yet");
      return;
    }
    titleAttempted = true;
    try {
      const model = ctx.model;
      if (!model) return;
      const response = await completeWithSessionModel(
        ctx,
        {
          systemPrompt:
            "You name coding agent sessions. Given the user's first message, reply with only a short session title: 3 to 8 words, plain text, no quotes, no trailing punctuation.",
          messages: [
            { role: "user", content: [{ type: "text", text: firstMessage.slice(0, 4000) }], timestamp: Date.now() } as any,
          ],
        },
        { maxTokens: 1024, reasoning: "off" },
      );
      if (lifecycleClosed) return;
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

  pi.on("session_before_compact", async (event: any, ctx) => {
    latestCtx = ctx;
    isCompacting = true;
    send({ type: "compaction_start", reason: event?.reason });
    return undefined;
  });

  pi.on("session_compact", async (event: any, ctx) => {
    latestCtx = ctx;
    isCompacting = false;
    send({ type: "compaction_end", reason: event?.reason, ...(event?.compactionEntry ? { result: event.compactionEntry } : {}) });
  });

  pi.on("session_compact_failed", async (event: any, ctx) => {
    latestCtx = ctx;
    isCompacting = false;
    send({ type: "compaction_end", reason: event?.reason, errorMessage: event?.error?.message ?? event?.errorMessage, aborted: event?.aborted === true });
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

  const reloadRuntime = async (args: string, ctx: ExtensionCommandContext) => {
    validateReloadPrompt(`/remote-reload ${args}`);
    requireIdleReload(ctx, { reloading: reloadExecuting, compacting: isCompacting,
      pendingUi: pendingRemoteUiRequests.size > 0, pendingRpc: commandsInFlight > (reloadRequested ? 1 : 0) });
    reloadRequested = true;
    reloadExecuting = true;
    const connection = transport;
    notifyEvent("Reloading Pi runtime; the Pi process and background jobs will keep running.");
    try {
      await ctx.reload();
      return; // The old pi/ctx are invalid after reload.
    } catch (error) {
      reloadRequested = false;
      reloadExecuting = false;
      // Only the independently owned transport is safe to use after teardown.
      connection?.send({ type: "extension_ui_request", id: crypto.randomUUID(), method: "notify",
        message: `Pi runtime reload failed: ${String(error).slice(0, 2000)}`, notifyType: "error" });
      throw error;
    }
  };
  pi.registerCommand("remote-reload", {
    description: "Reload Pi extensions and resources while idle, without restarting Pi or cancelling background jobs",
    handler: reloadRuntime,
  });

  async function runBridgeManagement(args: string, ctx: ExtensionContext, reportFailure = false,
    notify: (message: string, type: "info" | "warning" | "error") => void = (message, type) => ctx.ui.notify(message, type),
  ): Promise<void> {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] ?? "status";
      try {
        switch (sub) {
          case "install": {
            const result = installShimIntoPaseoConfig();
            if (reportFailure && !result.ok) throw new Error(result.message);
            notify(result.message, result.ok ? "info" : "error");
            return;
          }
          case "uninstall": {
            const result = uninstallShimFromPaseoConfig();
            if (reportFailure && !result.ok) throw new Error(result.message);
            notify(result.message, result.ok ? "info" : "error");
            return;
          }
          case "auto": {
            const value = parts[1]?.toLowerCase();
            if (value !== "on" && value !== "off") {
              notify(`Auto-connect is ${isAutoEnabled() ? "on" : "off"}. Use /paseo-bridge auto on|off to change.`, "info");
              return;
            }
            writeBridgeSettings({ auto: value === "on" });
            notify(`Auto-connect ${value}: new TUI sessions will ${value === "on" ? "" : "not "}appear in Paseo automatically.`, "info");
            return;
          }
          case "connect":
            notify(connectSession(ctx), "info");
            return;
          case "disconnect":
            if (!transport) {
              notify("Bridge is not connected.", "info");
              return;
            }
            stopServer();
            notify("Bridge disconnected. Use /paseo-bridge connect to reattach.", "info");
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
              `settings: ${bridgeSettingsFile()}`,
              `session import: ${isImportEnabled() ? "on" : "off"}`,
              `title generation: ${isTitleGenerationEnabled() ? "on" : "off"}`,
              `session: ${transport ? (currentAgentId ? `bridged as Paseo agent ${currentAgentId}` : "bridged (not yet imported)") : "not bridged"}`,
            ];
            notify(`Paseo bridge status\n${lines.join("\n")}`, "info");
            return;
          }
          default:
            if (reportFailure) throw new Error("Usage: /paseo-bridge install | uninstall | auto [on|off] | connect | disconnect | status");
            notify("Usage: /paseo-bridge install | uninstall | auto [on|off] | connect | disconnect | status", "warning");
        }
      } catch (err) {
        if (reportFailure) throw err;
        notify(`paseo-bridge: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
  }
  pi.registerCommand("paseo-bridge", {
    description: "Manage the Paseo bridge: install | uninstall | auto [on|off] | connect | disconnect | status",
    handler: (args, ctx) => runBridgeManagement(args, ctx),
  });
}
