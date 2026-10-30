import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

// The executable is supplied by native-rpc-check.nix, never a user wrapper.
// Provider calls are forbidden except the single delayed-compaction delivery probe.
const executable = process.env.BRIDGE_NATIVE_PI;
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtureProvider = `import { appendFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default function(pi) {
  let syntheticCompactionAttempt = 0;
  pi.on("session_start", (event, ctx) => {
    globalThis.__offlineFixtureContext = ctx;
    appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, event.reason + "\\n");
    writeFileSync(process.env.OFFLINE_LIFECYCLE_FILE + ".capabilities", JSON.stringify({
      commandOutcomes: typeof pi.dispatchExtensionCommand === "function",
      promptAdmission: typeof pi.submitUserMessage === "function",
    }));
    if (process.env.OFFLINE_REAL_IDLE_EXTENSION !== "1") globalThis.__piIdleContextPreflightV1 = { ready: true, check: async signal => {
      if (!existsSync(process.env.OFFLINE_IDLE_COMPACT_REQUEST)) return "continue";
      unlinkSync(process.env.OFFLINE_IDLE_COMPACT_REQUEST);
      const sessionId = ctx.sessionManager.getSessionId(), leafId = ctx.sessionManager.getLeafId();
      appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, "IDLE_PREFLIGHT_START\\n");
      while (!existsSync(process.env.OFFLINE_IDLE_COMPACT_RELEASE)) {
        if (signal?.aborted) return "cancel";
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      unlinkSync(process.env.OFFLINE_IDLE_COMPACT_RELEASE);
      appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, "IDLE_PREFLIGHT_COMPACT_CHOSEN\\n");
      await new Promise((resolve, reject) => ctx.compact({ onComplete: resolve, onError: reject }));
      const entry = ctx.sessionManager.getBranch().findLast(item => item.type === "compaction");
      if (ctx.sessionManager.getSessionId() !== sessionId || entry?.parentId !== leafId || ctx.sessionManager.getLeafId() !== entry.id) return "cancel";
      appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, "IDLE_PREFLIGHT_COMPACTED\\n");
      return "continue";
    } };
  });
  pi.on("agent_start", () => appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, "AGENT_STARTED\\n"));
  pi.on("session_before_compact", event => {
    if (existsSync(process.env.OFFLINE_REAL_IDLE_ACTIVE)) {
      appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, "REAL_IDLE_COMPACTION_START\\n");
      return;
    }
    appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, "SYNTHETIC_COMPACTION:" + event.reason + "\\n");
    syntheticCompactionAttempt += 1;
    if (syntheticCompactionAttempt === 2) return { cancel: true };
    return { compaction: { summary: "offline synthetic summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, details: { offline: true } } };
  });
  pi.on("input", event => {
    if (event.text === "idle compact model delivery fixture") {
      writeFileSync(process.env.OFFLINE_INPUT_RECEIPT + ".idle", JSON.stringify({ source: event.source, text: event.text,
        streamingBehavior: event.streamingBehavior ?? null, streamingBehaviorIsUndefined: event.streamingBehavior === undefined, images: event.images ?? [] }));
      return;
    }
    if (event.text !== "ordinary offline bridge provenance fixture" && event.text !== "offline remote image fixture") return;
    const imageProbe = event.text === "offline remote image fixture";
    writeFileSync(process.env.OFFLINE_INPUT_RECEIPT + (imageProbe ? ".images" : ""), JSON.stringify({
      source: event.source,
      streamingBehavior: event.streamingBehavior ?? null,
      streamingBehaviorIsUndefined: event.streamingBehavior === undefined,
      ...(imageProbe ? { images: event.images } : {}),
    }));
    return { action: "handled" };
  });
  pi.registerProvider("bridge-offline", {
    api: "bridge-offline-never-stream", baseUrl: "http://127.0.0.1:1",
    apiKey: "offline-fixture-not-a-secret",
    streamSimple(model, context) {
      const last = context.messages?.at(-1);
      if (last?.role === "user" && JSON.stringify(last.content).includes("idle compact model delivery fixture")) {
        appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE + ".model.calls", JSON.stringify({ model: model.id, content: last.content }) + "\\n");
        writeFileSync(process.env.OFFLINE_LIFECYCLE_FILE + ".model", JSON.stringify({ model: model.id, content: last.content }));
        const stream = createAssistantMessageEventStream();
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "offline model response" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
        return stream;
      }
      if (process.env.OFFLINE_REAL_IDLE_EXTENSION === "1" && existsSync(process.env.OFFLINE_REAL_IDLE_ACTIVE)) {
        appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, "IDLE_COMPACTION_MODEL\\n");
        appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE + ".idle.compaction.calls", "summary\\n");
        const stream = createAssistantMessageEventStream();
        const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop", content: [{ type: "text", text: "isolated valid compaction summary" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (existsSync(process.env.OFFLINE_INJECT_CUSTOM_ENTRY)) {
          unlinkSync(process.env.OFFLINE_INJECT_CUSTOM_ENTRY);
          appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, "IDLE_CUSTOM_ENTRY_IN_COMPACTION\\n");
          globalThis.__offlineFixtureContext.sessionManager.appendCustomMessageEntry("offline-progress", "harmless async fixture progress", true);
        }
        queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
        return stream;
      }
      appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, "PROVIDER_CALLED\\n");
      throw new Error("OFFLINE TEST MUST NOT CALL PROVIDERS");
    },
    models: ["first", "second"].map(id => ({ id, name: id, reasoning: true,
      input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768, maxTokens: 1024 }))
  });
  pi.registerCommand("offline-fixture-command", { description: "metadata only", handler: async () => {} });
  pi.registerCommand("offline-fixture-seed-compaction", { description: "seed compactable local history", handler: async (_args, ctx) => {
    const huge = "local compaction fixture ".repeat(60000);
    ctx.sessionManager.appendMessage({ role: "user", content: huge, timestamp: Date.now() });
    ctx.sessionManager.appendMessage({ role: "user", content: huge, timestamp: Date.now() });
  }});
  pi.registerCommand("offline-fixture-reset-compaction", { description: "reset isolated compaction counter", handler: async () => { syntheticCompactionAttempt = 0; } });
  pi.registerCommand("offline-fixture-seed-idle-history", { description: "seed stale compactable branch for idle-context-warning", handler: async (_args, ctx) => {
    const huge = "idle plugin compaction fixture ".repeat(60000);
    ctx.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "stale successful response" }], api: "bridge-offline-never-stream", provider: "bridge-offline", model: "second", timestamp: Date.now() - 3_600_000, stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    ctx.sessionManager.appendMessage({ role: "user", content: huge, timestamp: Date.now() });
    ctx.sessionManager.appendMessage({ role: "user", content: huge, timestamp: Date.now() });
  }});
  pi.registerCommand("offline-fixture-command", { description: "offline command outcome", handler: async (args, ctx) => {
    appendFileSync(process.env.OFFLINE_LIFECYCLE_FILE, "COMMAND_STARTED\\n");
    ctx.ui.notify("literal command notice: " + args, "warning");
    if (args === "fail") throw new Error("literal command failure\\n  detail");
    if (args === "reload" || args === "reload-dialog") {
      const pending = args === "reload-dialog" ? globalThis.__piPaseoRemoteUiV1.input("Pending reload fixture", "Answer") : undefined;
      await ctx.reload();
      await pending;
      return;
    }
    const release = process.env.OFFLINE_INPUT_RECEIPT + ".command-release";
    while (!existsSync(release)) await new Promise(resolve => setTimeout(resolve, 10));
    ctx.ui.notify("settled command notice: " + args, "info");
    writeFileSync(process.env.OFFLINE_INPUT_RECEIPT + ".command", JSON.stringify({ args }));
  }});
  pi.registerCommand("offline-fixture-seed-history", { description: "seed local history", handler: async (_args, ctx) => {
    const sm = ctx.sessionManager;
    const first = sm.appendMessage({ role: "user", content: "original user text", timestamp: Date.now() });
    sm.appendContextEdit(first, { content: "projected replacement text" });
    sm.appendCustomMessageEntry("offline-notice", "visible notice", true);
    const omitted = sm.appendMessage({ role: "user", content: "deleted user text", timestamp: Date.now() });
    sm.appendContextEdit(omitted, null);
    writeFileSync(process.env.OFFLINE_LIFECYCLE_FILE + ".history", JSON.stringify({ first, omitted }));
  }});
  pi.registerCommand("offline-fixture-dialog", { description: "offline dialog probe", handler: async (args) => {
    const remote = globalThis.__piPaseoRemoteUiV1;
    if (!remote) throw new Error("Offline remote UI global missing");
    const method = args.trim();
    if (!remote.isConnected()) throw new Error("Offline remote UI disconnected");
    const settings = { paseoQuestionnaire: { v: 1, toolCallId: "fixture-tool", index: 0, input: true } };
    const value = method === "confirm" ? await remote.confirm("Confirm fixture", "Continue?")
      : method === "editor" ? await remote.editor("Editor fixture", "Initial text")
      : method === "correlated" ? await remote.select("Correlated fixture", ["One"], settings)
      : method === "correlated-input" ? await remote.input("Correlated input", "Literal response", settings)
      : await remote.input("Input fixture", "Literal response");
    writeFileSync(process.env.OFFLINE_INPUT_RECEIPT + ".dialog", JSON.stringify({ method, value: value ?? null }));
  }});
}`;

function rpc(stream: Socket | NodeJS.ReadableStream, write: (line: string) => void) {
  let next = 0, buffer = "";
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  stream.on("data", chunk => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let record: any;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type !== "response") continue;
      const waiter = pending.get(record.id);
      if (waiter) { pending.delete(record.id); waiter.resolve(record); }
    }
  });
  return async (type: string, fields: Record<string, unknown> = {}) => {
    const id = `native-${++next}`;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await new Promise<any>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 4000);
        write(JSON.stringify({ ...fields, id, type }) + "\n");
      });
    } finally { clearTimeout(timer!); pending.delete(id); }
  };
}

test("actual Pi executable and production bridge RPC", { skip: !executable, timeout: 45000 }, async t => {
  // Short path also fits Unix sockaddr_un in Nix build directories.
  const temporary = await mkdtemp(path.join(tmpdir(), "brpc-"));
  const home = path.join(temporary, "home"), cwd = path.join(temporary, "cwd");
  const runtime = path.join(temporary, "run"), agent = path.join(home, ".pi", "agent");
  await Promise.all([home, cwd, runtime, agent].map(p => mkdir(p, { recursive: true })));
  const provider = path.join(temporary, "provider.ts");
  await writeFile(provider, fixtureProvider);
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({
    defaultProvider: "bridge-offline", defaultModel: "first", defaultThinkingLevel: "low",
    packages: [], autoCompact: false,
  }));
  if (process.env.BRIDGE_IDLE_CONTEXT_EXTENSION) await writeFile(path.join(agent, "idle-context-warning.json"), JSON.stringify({ idleMinutes: 1440, contextPercent: 100, cheapCompactionModel: "bridge-offline/second" }));
  const session = path.join(temporary, "session.jsonl");
  const socketPath = path.join(runtime, "pi-paseo", createHash("sha256").update(session).digest("hex").slice(0, 20) + ".sock");
  const bridgeEntry = process.env.BRIDGE_NATIVE_EXTENSION ?? path.join(root, "extension/index.ts");
  t.diagnostic(`Pi executable: ${executable}; bridge entry: ${bridgeEntry}`);
  const child = spawn(executable!, ["--mode", "rpc", "--session", session,
    "--no-extensions", "--extension", bridgeEntry,
    ...(process.env.BRIDGE_IDLE_CONTEXT_EXTENSION ? ["--extension", process.env.BRIDGE_IDLE_CONTEXT_EXTENSION] : []),
    "--extension", provider, "--provider", "bridge-offline", "--model", "first", "--thinking", "low",
    "--no-skills", "--no-prompt-templates"], {
    cwd, detached: true, stdio: ["pipe", "pipe", "pipe"],
    // Allowlist only. In particular no API keys, tmux, service, auth, agent
    // sockets, user Pi configuration, or inherited wrapper environment.
    env: { PATH: path.dirname(executable!), HOME: home, TMPDIR: temporary,
      XDG_RUNTIME_DIR: runtime, XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_CACHE_HOME: path.join(home, ".cache"), XDG_DATA_HOME: path.join(home, ".local/share"),
      OFFLINE_LIFECYCLE_FILE: path.join(temporary, "lifecycle"),
      OFFLINE_INPUT_RECEIPT: path.join(temporary, "input-receipt.json"),
      OFFLINE_IDLE_COMPACT_REQUEST: path.join(temporary, "idle-compact-request"),
      OFFLINE_IDLE_COMPACT_RELEASE: path.join(temporary, "idle-compact-release"),
      OFFLINE_REAL_IDLE_EXTENSION: process.env.BRIDGE_IDLE_CONTEXT_EXTENSION ? "1" : "0",
      OFFLINE_REAL_IDLE_ACTIVE: path.join(temporary, "real-idle-active"),
      OFFLINE_INJECT_CUSTOM_ENTRY: path.join(temporary, "inject-custom-entry"),
      PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
      PI_PASEO_BRIDGE_FORCE: "1", PI_PASEO_BRIDGE_NO_IMPORT: "1", PI_PASEO_BRIDGE_NO_TITLE: "1",
      PI_PASEO_BRIDGE_IMPORT_SESSIONS: "0", PI_PASEO_BRIDGE_GENERATE_TITLES: "0", PASEO_HOST: "fixture://offline" },
  });
  let stderr = "", startupError: Error | undefined;
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-12000); });
  child.on("error", error => { startupError = error; });
  const exited = once(child, "exit");
  const native = rpc(child.stdout, line => child.stdin.write(line));
  let socket: Socket | undefined;
  try {
    const deadline = Date.now() + 12000;
    for (;;) {
      if (startupError) throw startupError;
      assert.equal(child.exitCode, null, `Pi exited during startup: ${stderr}`);
      try {
        socket = connect(socketPath);
        await once(socket, "connect");
        break;
      } catch (error) {
        socket?.destroy();
        if (Date.now() >= deadline) throw new Error(`Bridge socket not ready: ${String(error)}\n${stderr}`);
        await delay(50);
      }
    }
    const dialogs: any[] = [];
    const extensionNotices: string[] = [];
    const compactionEvents: any[] = [];
    const dialogCancellations: string[] = [];
    let dialogBuffer = "";
    socket.on("data", chunk => {
      dialogBuffer += chunk.toString();
      for (;;) {
        const end = dialogBuffer.indexOf("\n");
        if (end < 0) break;
        const line = dialogBuffer.slice(0, end); dialogBuffer = dialogBuffer.slice(end + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "extension_ui_request" && ["select", "input", "confirm", "editor"].includes(event.method)) dialogs.push(event);
          if (event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string") extensionNotices.push(event.message);
          if (event.type === "compaction_start" || event.type === "compaction_end") compactionEvents.push(event);
          if (event.type === "extension_ui_cancel") dialogCancellations.push(event.id);
        } catch { /* Other protocol traffic is owned by the RPC fixture. */ }
      }
    });
    let bridge = rpc(socket, line => socket!.write(line));
    let ok = async (type: string, fields = {}) => {
      const result = await bridge(type, fields);
      assert.equal(result.command, type);
      assert.equal(result.success, true, JSON.stringify(result));
      return result.data;
    };
    let capabilities: any;
    try { capabilities = JSON.parse(await readFile(path.join(temporary, "lifecycle.capabilities"), "utf8")); }
    catch (error) { throw new Error(`fixture provider did not receive session_start: ${String(error)}\\n${stderr}`); }
    t.diagnostic(`Runtime capabilities: ${JSON.stringify(capabilities)}; stock third-party command rejection is NOT functional command parity`);
    const seedHistory = async (message: string) => {
      // Fixture setup is terminal/native-owned on stock, not a claim that the
      // bridge can execute an uncooperative third-party extension command.
      const response = capabilities.commandOutcomes ? await bridge("prompt", { message }) : await native("prompt", { message });
      assert.equal(response.success, true, JSON.stringify(response));
    };
    const assertUnsupportedCommand = async (type: string, message: string) => {
      const noticesBefore = extensionNotices.length;
      const response = await bridge(type, { message });
      assert.equal(response.success, false, JSON.stringify(response));
      assert.match(response.error, /cannot report extension command outcomes/);
      assert.equal((await native("abort")).success, true, "barrier behind any accidental asynchronous delivery");
      assert.ok(!(await readFile(path.join(temporary, "lifecycle"), "utf8")).includes("COMMAND_STARTED"), "rejected third-party handler must never execute");
      assert.equal(extensionNotices.length, noticesBefore, "rejected third-party command must not emit notices");
      await assert.rejects(readFile(path.join(temporary, "input-receipt.json.command")), { code: "ENOENT" });
    };
    await t.test("native bridge routes state and commands", async () => {
      const state = await ok("get_state");
      assert.equal(state.model.provider, "bridge-offline");
      assert.equal(state.model.id, "first");
      assert.equal(state.sessionFile, session);
      assert.equal(state.isStreaming, false);
      const { commands, bridgeCommandSupport } = await ok("get_commands");
      assert.deepEqual(bridgeCommandSupport, {
        owned: ["paseo-bridge", "remote-reload", "paseo_capture_entries"],
        unsupported: ["paseo_tree", "reload"],
        arbitraryExtensionCommands: capabilities.commandOutcomes,
        disconnectReceipt: "accepted", reloadReceipt: "accepted",
      });
      assert.ok(commands.some((c: any) => c.name === "offline-fixture-command"));
      assert.ok(commands.some((c: any) => c.name === "remote-reload"));
    });
    await t.test("bridge-owned management executes on stock and reports real failures", async () => {
      const before = extensionNotices.length;
      for (const type of ["prompt", "steer", "follow_up"]) {
        const result = await ok(type, { message: "/paseo-bridge status" });
        assert.equal(result.agentInvoked, false);
      }
      assert.ok(extensionNotices.slice(before).some(message => message.startsWith("Paseo bridge status\n")));
      const unknown = await bridge("prompt", { message: "/paseo-bridge not-a-command" });
      assert.equal(unknown.success, false);
      assert.match(unknown.error, /Usage: \/paseo-bridge/);
      const image = await bridge("prompt", { message: "/paseo-bridge status", images: [{ type: "image", data: "a", mimeType: "image/png" }] });
      assert.equal(image.success, false);
      assert.match(image.error, /do not accept image attachments/);
      const connecting = extensionNotices.length;
      await ok("prompt", { message: "/paseo-bridge connect" });
      assert.ok(extensionNotices.slice(connecting).includes("Connecting session to Paseo..."));
      await ok("prompt", { message: "/paseo-bridge auto off" });
      const autoOff = extensionNotices.length;
      await ok("prompt", { message: "/paseo-bridge status" });
      assert.ok(extensionNotices.slice(autoOff).some(message => message.includes("auto-connect: off")));
      await ok("prompt", { message: "/paseo-bridge auto on" });
      const config = path.join(home, ".paseo", "config.json");
      await mkdir(path.dirname(config), { recursive: true });
      await writeFile(config, "invalid json");
      const failure = await bridge("prompt", { message: "/paseo-bridge install" });
      assert.equal(failure.success, false, "real config failures must not become successful error notifications");
      assert.equal(await readFile(config, "utf8"), "invalid json");
      const foreignConfig = JSON.stringify({ agents: { providers: { pi: { command: ["foreign-pi"] } } } });
      await writeFile(config, foreignConfig);
      for (const operation of ["install", "uninstall"]) {
        const rejected = await bridge("prompt", { message: `/paseo-bridge ${operation}` });
        assert.equal(rejected.success, false, `${operation} must report refusal, not completed success`);
        assert.match(rejected.error, /already overrides|Leaving Paseo config untouched/);
        assert.equal(await readFile(config, "utf8"), foreignConfig);
      }
      await writeFile(config, "{}");
      await ok("prompt", { message: "/paseo-bridge install" });
      assert.ok(JSON.parse(await readFile(config, "utf8")).agents.providers.pi.command);
      await ok("prompt", { message: "/paseo-bridge uninstall" });
      assert.equal(JSON.parse(await readFile(config, "utf8")).agents?.providers?.pi, undefined);
      assert.equal((await ok("get_session_stats")).totalMessages, 0);
    });
    await t.test("native and bridge compaction semantics and explicit capabilities", async () => {
      const state = await ok("get_state");
      assert.equal(Object.hasOwn(state, "autoCompactionEnabled"), false, "unknown runtime setting must be omitted");
      assert.deepEqual(state.bridgeCapabilities, { supportsRewindConversation: false, supportsAutoCompactionControl: false });
      const nativeCompact = await native("compact");
      const bridgeCompact = await bridge("compact");
      assert.equal(nativeCompact.success, false, JSON.stringify(nativeCompact));
      assert.match(nativeCompact.error, /Nothing to compact/i);
      assert.equal(bridgeCompact.success, false, JSON.stringify(bridgeCompact));
      assert.match(bridgeCompact.error, /Nothing to compact/i);
      const setter = await bridge("set_auto_compaction", { enabled: true });
      assert.equal(setter.success, false, JSON.stringify(setter));
      assert.match(setter.error, /unsupported/i);
      assert.equal((await ok("get_state")).autoCompactionEnabled, undefined);
    });
    await t.test("native bridge routes session stats", async () => {
      const stats = await ok("get_session_stats");
      const direct = await native("get_session_stats");
      assert.equal(direct.success, true);
      assert.deepEqual(stats, direct.data);
      assert.equal(stats.sessionFile, session);
      assert.ok(stats.sessionId);
      assert.equal(stats.totalMessages, 0);
      assert.deepEqual(stats.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
      assert.equal(stats.cost, 0);
    });
    await t.test("native bridge applies thinking and same-model echoes preserve it", async () => {
      await ok("set_thinking_level", { level: "high" });
      assert.equal((await ok("get_state")).thinkingLevel, "high");
      assert.equal((await native("get_state")).data.thinkingLevel, "high");
      for (let i = 0; i < 2; i++) {
        const model = await ok("set_model", { provider: "bridge-offline", modelId: "first" });
        assert.equal(model.id, "first");
        assert.equal((await ok("get_state")).thinkingLevel, "high");
      }
    });
    await t.test("native bridge changes model and invalid model preserves selection", async () => {
      const model = await ok("set_model", { provider: "bridge-offline", modelId: "second" });
      assert.equal(model.id, "second");
      const before = await ok("get_state");
      assert.equal(before.model.id, "second");
      assert.equal((await native("get_state")).data.model.id, "second");
      const failure = await bridge("set_model", { provider: "bridge-offline", modelId: "missing" });
      assert.equal(failure.command, "set_model");
      assert.equal(failure.success, false);
      assert.match(failure.error, /Model not found: bridge-offline\/missing/);
      const after = await ok("get_state");
      assert.deepEqual(after.model, before.model);
      assert.equal(after.thinkingLevel, before.thinkingLevel);
    });
    await t.test("idle bridge prompt reaches actual Pi input as extension provenance without streaming behavior", async () => {
      assert.equal((await ok("get_state")).isStreaming, false);
      const accepted = await ok("prompt", { message: "ordinary offline bridge provenance fixture" });
      if (capabilities.promptAdmission) assert.equal(accepted.agentInvoked, false, "Pi's input hook consumed the prompt without starting a model turn");
      else assert.equal(Object.hasOwn(accepted, "agentInvoked"), false, "stock delivery does not expose input-consumption disposition");
      const deadline = Date.now() + 4000;
      let receipt: any;
      for (;;) {
        try { receipt = JSON.parse(await readFile(path.join(temporary, "input-receipt.json"), "utf8")); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          assert.ok(Date.now() < deadline, "Pi input handler must receive the bridge prompt");
          await delay(20);
        }
      }
      assert.deepEqual(receipt, {
        source: "extension", streamingBehavior: null, streamingBehaviorIsUndefined: true,
      });
      // Barrier behind asynchronous sendUserMessage: Pi's native abort waits
      // for idle. The fixture consumes input before any agent/model work.
      assert.equal((await native("abort")).success, true);
      assert.equal((await ok("get_state")).isStreaming, false);
      const lifecycle = await readFile(path.join(temporary, "lifecycle"), "utf8");
      assert.ok(!lifecycle.includes("AGENT_STARTED"));
      assert.ok(!lifecycle.includes("PROVIDER_CALLED"));
      assert.equal((await ok("get_session_stats")).totalMessages, 0);
    });
    await t.test("prompt, steering and follow-up preserve images through actual Pi input", async () => {
      const images = [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", mimeType: "image/png" }];
      const receiptPath = path.join(temporary, "input-receipt.json.images");
      for (const type of ["prompt", "steer", "follow_up"]) {
        await rm(receiptPath, { force: true });
        await ok(type, { message: "offline remote image fixture", images });
        const deadline = Date.now() + 4000;
        let receipt: any;
        for (;;) {
          try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); break; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            assert.ok(Date.now() < deadline, `${type} must reach Pi input`);
            await delay(20);
          }
        }
        assert.deepEqual(receipt.images, images, `${type} must preserve attached images`);
        assert.equal(receipt.source, "extension");
        assert.equal((await native("abort")).success, true);
      }
      const lifecycle = await readFile(path.join(temporary, "lifecycle"), "utf8");
      assert.ok(!lifecycle.includes("PROVIDER_CALLED"));
      assert.ok(!lifecycle.includes("AGENT_STARTED"));
    });
    await t.test("third-party commands: real outcomes where supported, explicit no-effects rejection on stock", async () => {
      if (!capabilities.commandOutcomes) {
        for (const type of ["prompt", "steer", "follow_up"]) await assertUnsupportedCommand(type, `/offline-fixture-command ${type}`);
        return;
      }
      const release = path.join(temporary, "input-receipt.json.command-release");
      const receipt = path.join(temporary, "input-receipt.json.command");
      for (const type of ["prompt", "steer", "follow_up"]) {
        await rm(release, { force: true }); await rm(receipt, { force: true });
        let settled = false;
        const pending = bridge(type, { message: `/offline-fixture-command ${type}` }).then(result => { settled = true; return result; });
        const deadline = Date.now() + 4000;
        while (!extensionNotices.includes(`literal command notice: ${type}`)) {
          assert.ok(Date.now() < deadline, "notification must arrive while command is still awaiting completion");
          await delay(10);
        }
        assert.equal(settled, false);
        await assert.rejects(readFile(receipt), { code: "ENOENT" });
        await writeFile(release, "release");
        const result = await pending;
        assert.equal(result.success, true);
        assert.equal(result.data.agentInvoked, false);
        assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), { args: type });
        const failed = await bridge(type, { message: "/offline-fixture-command fail" });
        assert.equal(failed.success, false);
        assert.equal(failed.error, "literal command failure\n  detail");
      }
      for (const type of ["steer", "follow_up"]) {
        const rejected = await bridge(type, { message: "/remote-reload" });
        assert.equal(rejected.success, false);
        assert.match(rejected.error, /ordinary prompt/);
      }
      const lifecycle = await readFile(path.join(temporary, "lifecycle"), "utf8");
      assert.ok(!lifecycle.includes("PROVIDER_CALLED"));
      assert.ok(!lifecycle.includes("AGENT_STARTED"));
    });
    await t.test("Stop cancels observation where supported; stock rejected work never starts", async () => {
      if (!capabilities.commandOutcomes) {
        await assertUnsupportedCommand("prompt", "/offline-fixture-command cancel");
        await ok("abort");
        await assert.rejects(readFile(path.join(temporary, "input-receipt.json.command")), { code: "ENOENT" });
        return;
      }
      const release = path.join(temporary, "input-receipt.json.command-release");
      const receipt = path.join(temporary, "input-receipt.json.command");
      await rm(release, { force: true }); await rm(receipt, { force: true });
      const pending = bridge("prompt", { message: "/offline-fixture-command cancel" });
      const deadline = Date.now() + 4000;
      while (!extensionNotices.includes("literal command notice: cancel")) {
        assert.ok(Date.now() < deadline, "command must start before Stop"); await delay(10);
      }
      await ok("abort");
      const canceled = await pending;
      assert.equal(canceled.success, false);
      assert.match(canceled.error, /wait aborted.*may still be running/);
      await assert.rejects(readFile(receipt), { code: "ENOENT" });
      await writeFile(release, "release local work");
      for (;;) {
        try { assert.deepEqual(JSON.parse(await readFile(receipt, "utf8")), { args: "cancel" }); break; }
        catch (error: any) { if (error.code !== "ENOENT") throw error; }
        assert.ok(Date.now() < deadline, "local work must remain inspectable after wait cancellation"); await delay(10);
      }
      assert.ok(!extensionNotices.includes("settled command notice: cancel"), "settled wait cannot leak later notifications");
      assert.ok((await ok("get_state")).sessionId);
    });
    await t.test("remote dialogs use stock-native frames and a non-destructive editor fallback", async () => {
      const literal = "  literal {\"x\":1}\nsecond line  ";
      const cases = [
        { method: "input", response: { value: literal }, expected: literal },
        { method: "correlated", response: { value: literal }, expected: literal },
        { method: "correlated-input", response: { value: literal }, expected: literal },
        { method: "editor", choice: "Write replacement", response: { value: literal }, expected: literal },
        { method: "editor", choice: "Keep existing text", response: {}, expected: "Initial text" },
        { method: "editor", choice: "cancel", response: {}, expected: null },
        { method: "confirm", response: { confirmed: true }, expected: true },
        { method: "confirm", response: { confirmed: false }, expected: false },
        { method: "input", response: { cancelled: true }, expected: null },
      ];
      for (const probe of cases) {
        const receiptPath = path.join(temporary, "input-receipt.json.dialog");
        await rm(receiptPath, { force: true });
        // Test the explicit remote UI adapter independently of unsupported
        // third-party slash dispatch. Native RPC invokes the fixture on stock.
        const dispatched = capabilities.commandOutcomes
          ? ok("prompt", { message: `/offline-fixture-dialog ${probe.method}` })
          : native("prompt", { message: `/offline-fixture-dialog ${probe.method}` }).then(result => assert.equal(result.success, true, JSON.stringify(result)));
        const deadline = Date.now() + 4000;
        while (!dialogs.length) {
          if (Date.now() >= deadline) {
            let started = "not invoked";
            try { started = await readFile(path.join(temporary, "input-receipt.json.dialog-start"), "utf8"); } catch {}
            assert.fail(`${probe.method} must publish a native dialog request; start=${started}; stderr=${stderr}`);
          }
          await delay(10);
        }
        let request = dialogs.shift();
        if (probe.method === "editor") {
          assert.equal(request.method, "select");
          assert.match(request.title, /Current text:\nInitial text/);
          assert.deepEqual(request.options, ["Keep existing text", "Write replacement"]);
          socket!.write(JSON.stringify({ type: "extension_ui_response", id: request.id,
            ...(probe.choice === "cancel" ? { cancelled: true } : { value: probe.choice }) }) + "\n");
          if (probe.choice === "Write replacement") {
            while (!dialogs.length) {
              assert.ok(Date.now() < deadline, "replacement text must use the stock input dialog");
              await delay(10);
            }
            request = dialogs.shift();
            assert.equal(request.method, "input");
            socket!.write(JSON.stringify({ type: "extension_ui_response", id: request.id, ...probe.response }) + "\n");
          }
        } else {
          assert.equal(request.method, probe.method === "correlated" ? "select" : probe.method === "correlated-input" ? "input" : probe.method);
          if (probe.method.startsWith("correlated")) {
            assert.deepEqual(request.paseoQuestionnaire, { v: 1, toolCallId: "fixture-tool", index: 0, input: true });
          } else assert.equal(request.paseoQuestionnaire, undefined);
          socket!.write(JSON.stringify({ type: "extension_ui_response", id: request.id, ...probe.response }) + "\n");
        }
        await dispatched;
        let receipt: any;
        for (;;) {
          try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); break; }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            assert.ok(Date.now() < deadline, "dialog must settle its original extension caller");
            await delay(10);
          }
        }
        assert.deepEqual(receipt, { method: probe.method, value: probe.expected });
      }
      assert.ok(!(await readFile(path.join(temporary, "lifecycle"), "utf8")).includes("PROVIDER_CALLED"));
    });
    await t.test("native remote-reload keeps the isolated Pi and attached bridge alive", async () => {
      const pid = child.pid;
      const before = await ok("get_state");
      const accepted = await ok("prompt", { message: "/remote-reload" });
      assert.equal(accepted.reloadAccepted, true);
      assert.equal(accepted.agentInvoked, false);
      const deadline = Date.now() + 8000;
      while (!(await readFile(path.join(temporary, "lifecycle"), "utf8")).split("\n").includes("reload")) {
        assert.ok(Date.now() < deadline, `Reload did not reach session_start: ${stderr}`);
        await delay(50);
      }
      // Lifecycle event arrives after production bridge rebind (extension order).
      const after = await ok("get_state");
      assert.equal(child.pid, pid);
      assert.equal(child.exitCode, null);
      assert.equal(socket!.destroyed, false);
      assert.equal(after.sessionId, before.sessionId);
      assert.equal(after.sessionFile, before.sessionFile);
      assert.equal(after.model.id, before.model.id);
      assert.equal((await ok("get_session_stats")).totalMessages, 0);
      assert.ok(!(await readFile(path.join(temporary, "lifecycle"), "utf8")).includes("PROVIDER_CALLED"));
    });
    await t.test("third-party reload: old RPC settles where supported; stock rejects without reloading", async () => {
      if (!capabilities.commandOutcomes) {
        const lifecycle = await readFile(path.join(temporary, "lifecycle"), "utf8");
        await assertUnsupportedCommand("prompt", "/offline-fixture-command reload-dialog");
        assert.equal(await readFile(path.join(temporary, "lifecycle"), "utf8"), lifecycle);
        assert.equal(dialogs.length, 0);
        assert.ok((await ok("get_state")).sessionId);
        return;
      }
      const before = extensionNotices.filter(message => message.startsWith("Pi runtime reloaded.")).length;
      const response = await bridge("prompt", { message: "/offline-fixture-command reload-dialog" });
      assert.equal(response.success, false);
      assert.match(response.error, /runtime reloaded.*outcome is unknown/);
      const deadline = Date.now() + 4000;
      while (extensionNotices.filter(message => message.startsWith("Pi runtime reloaded.")).length <= before) {
        assert.ok(Date.now() < deadline, "replacement binding must resume on the retained socket");
        await delay(10);
      }
      assert.equal(child.exitCode, null);
      assert.equal(socket!.destroyed, false);
      const abandoned = dialogs.shift();
      assert.equal(abandoned?.title, "Pending reload fixture");
      assert.ok(dialogCancellations.includes(abandoned.id), "reload must dismiss the old native permission by its raw dialog ID");
      assert.ok((await ok("get_state")).sessionId);
    });
    await t.test("history replay and capture follow Pi's canonical projection", async () => {
      await seedHistory("/offline-fixture-seed-history");
      const seededAt = Date.now() + 4000;
      while (Date.now() < seededAt) {
        try { await readFile(path.join(temporary, "lifecycle.history"), "utf8"); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await delay(10);
        }
      }
      const ids = JSON.parse(await readFile(path.join(temporary, "lifecycle.history"), "utf8"));
      const history = await ok("get_messages");
      assert.deepEqual(history.messages.map((message: any) => message.content), [
        "projected replacement text", "visible notice",
      ]);
      extensionNotices.length = 0;
      const capturePrompt = ok("prompt", { message: "/paseo_capture_entries" });
      const deadline = Date.now() + 4000;
      let payload: any;
      while (Date.now() < deadline) {
        const notice = extensionNotices.find(value => value.startsWith("PASEO_ENTRY_CAPTURE "));
        if (notice) { payload = JSON.parse(notice.slice("PASEO_ENTRY_CAPTURE ".length)); break; }
        await delay(10);
      }
      assert.ok(payload, "capture should emit its native marker payload");
      assert.deepEqual(payload.treeEntries.map((entry: any) => entry.id), [ids.first, ids.omitted]);
      assert.deepEqual(payload.contextEntries, [{ id: ids.first, parentId: payload.treeEntries[0].parentId, text: "projected replacement text" }]);
      await capturePrompt;
      assert.ok(!(await readFile(path.join(temporary, "lifecycle"), "utf8")).includes("PROVIDER_CALLED"));
    });
    await t.test("manual synthetic compaction reports its true result without a provider call", async () => {
      await seedHistory("/offline-fixture-seed-compaction");
      const compact = await ok("compact");
      assert.equal(compact.summary, "offline synthetic summary");
      assert.equal(compact.details.offline, true);
      const lifecycle = await readFile(path.join(temporary, "lifecycle"), "utf8");
      assert.ok(lifecycle.includes("SYNTHETIC_COMPACTION:manual"), lifecycle);
      assert.ok(!lifecycle.includes("PROVIDER_CALLED"), lifecycle);
      assert.ok(compactionEvents.some(event => event.type === "compaction_start" && event.reason === "manual"));
      assert.ok(compactionEvents.some(event => event.type === "compaction_end" && event.reason === "manual" && event.result?.summary === "offline synthetic summary"));

      await seedHistory("/offline-fixture-seed-compaction");
      const cancelled = await bridge("compact", { customInstructions: "offline-cancel" });
      assert.equal(cancelled.success, false, JSON.stringify(cancelled));
      assert.ok(compactionEvents.some(event => event.type === "compaction_end" && event.reason === "manual" && event.aborted === true));

      assert.ok(compactionEvents.some(event => event.type === "compaction_end" && event.reason === "manual" && /Nothing to compact/i.test(event.errorMessage ?? "") && event.aborted === false));
      assert.ok(!(await readFile(path.join(temporary, "lifecycle"), "utf8")).includes("PROVIDER_CALLED"));
    });
    await t.test("idle Compact preflight delivers the original bridge prompt to the model after real Pi compaction", { skip: !!process.env.BRIDGE_IDLE_CONTEXT_EXTENSION }, async () => {
      await seedHistory("/offline-fixture-reset-compaction");
      await seedHistory("/offline-fixture-seed-compaction");
      const modelReceipt = path.join(temporary, "lifecycle.model");
      await rm(modelReceipt, { force: true });
      await rm(path.join(temporary, "lifecycle.model.calls"), { force: true });
      await rm(path.join(temporary, "idle-compact-release"), { force: true });
      await writeFile(path.join(temporary, "idle-compact-request"), "compact");
      let settled = false;
      const pending = bridge("prompt", { message: "idle compact model delivery fixture" }).then(result => { settled = true; return result; });
      const waitingDeadline = Date.now() + 2000;
      while (!(await readFile(path.join(temporary, "lifecycle"), "utf8")).includes("IDLE_PREFLIGHT_START")) {
        assert.ok(Date.now() < waitingDeadline, "bridge submission must reach and wait at idle preflight");
        await delay(10);
      }
      assert.equal(settled, false, "RPC must remain pending while the idle decision is unresolved");
      await assert.rejects(readFile(modelReceipt), { code: "ENOENT" }, "model delivery must wait for the user choice");
      await writeFile(path.join(temporary, "idle-compact-release"), "Compact");
      const accepted = await pending;
      assert.equal(accepted.success, true, JSON.stringify(accepted));
      if (capabilities.promptAdmission) assert.equal(accepted.data.agentInvoked, true);
      const deadline = Date.now() + 5000;
      let delivered: any;
      for (;;) {
        try { delivered = JSON.parse(await readFile(modelReceipt, "utf8")); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          assert.ok(Date.now() < deadline, "original prompt must reach the fixture model after compaction");
          await delay(20);
        }
      }
      assert.equal(delivered.model, "second");
      assert.match(JSON.stringify(delivered.content), /idle compact model delivery fixture/);
      assert.equal((await readFile(path.join(temporary, "lifecycle.model.calls"), "utf8")).trim().split("\n").length, 1, "accepted prompt must not be delivered twice");
      const lifecycle = await readFile(path.join(temporary, "lifecycle"), "utf8");
      assert.ok(lifecycle.indexOf("IDLE_PREFLIGHT_START") < lifecycle.indexOf("IDLE_PREFLIGHT_COMPACT_CHOSEN"));
      assert.ok(lifecycle.indexOf("IDLE_PREFLIGHT_COMPACT_CHOSEN") < lifecycle.lastIndexOf("SYNTHETIC_COMPACTION:manual"));
      assert.ok(lifecycle.lastIndexOf("SYNTHETIC_COMPACTION:manual") < lifecycle.indexOf("IDLE_PREFLIGHT_COMPACTED"));
      const idleDeadline = Date.now() + 4000;
      while ((await ok("get_state")).isStreaming) {
        assert.ok(Date.now() < idleDeadline, "fixture model turn must settle before transport teardown");
        await delay(20);
      }
    });
    await t.test("installed idle-context-warning handles notification entries during compaction without stale prompt loss", { skip: !process.env.BRIDGE_IDLE_CONTEXT_EXTENSION }, async () => {
      try { await seedHistory("/offline-fixture-seed-idle-history"); }
      catch (error) { throw new Error(`idle test history seed failed: ${String(error)}\\n${stderr}`); }
      await writeFile(path.join(agent, "idle-context-warning.json"), JSON.stringify({ idleMinutes: 1, contextPercent: 1, cheapCompactionModel: "bridge-offline/second" }));
      await writeFile(path.join(temporary, "real-idle-active"), "enabled");
      const injectBranchChange = process.env.BRIDGE_IDLE_INJECT_BRANCH_ENTRY === "1";
      if (injectBranchChange) await writeFile(path.join(temporary, "inject-custom-entry"), "during compaction");
      const image = { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", mimeType: "image/png" };
      const prompt = "idle compact model delivery fixture";
      const pending = bridge("prompt", { message: prompt, images: [image] });
      const deadline = Date.now() + 5000;
      while (!dialogs.length) {
        assert.ok(Date.now() < deadline, `installed idle-context-warning must show its mirrored decision: ${stderr}`);
        await delay(10);
      }
      const request = dialogs.shift();
      assert.equal(request.method, "select");
      assert.deepEqual(request.options, ["Cancel", "Ignore", "Compact"]);
      socket!.write(JSON.stringify({ type: "extension_ui_response", id: request.id, value: "Compact" }) + "\n");
      const response = await pending;
      const inputReceipt = JSON.parse(await readFile(path.join(temporary, "input-receipt.json.idle"), "utf8"));
      assert.deepEqual(inputReceipt, { source: "extension", text: prompt, streamingBehavior: null, streamingBehaviorIsUndefined: true, images: [image] }, "bridge input payload and options remain unchanged before Pi projection");
      const lifecycle = await readFile(path.join(temporary, "lifecycle"), "utf8");
      const entries = (await readFile(session, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const compactEntry = entries.findLast(entry => entry.type === "compaction");
      assert.ok(compactEntry, "Pi must persist a completed compact summary");
      assert.equal(compactEntry.details?.idleContextNativeCompaction, 1, "summary was produced by the installed plugin's native compaction hook");
      assert.equal(typeof compactEntry.details?.idleContextExplicitAttempt, "string", "summary receipt is tied to this approved compaction attempt");
      assert.equal((await readFile(path.join(temporary, "lifecycle.idle.compaction.calls"), "utf8")).trim(), "summary", "actual idle plugin invoked its compaction model once");
      assert.equal(response.success, true, JSON.stringify(response));
      let delivered: any;
      for (;;) {
        try { delivered = JSON.parse(await readFile(path.join(temporary, "lifecycle.model"), "utf8")); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          assert.ok(Date.now() < deadline, "approved original prompt reaches the model after branch-safe compaction");
          await delay(10);
        }
      }
      assert.match(JSON.stringify(delivered.content), new RegExp(prompt), "original prompt text reaches the provider after compaction");
      assert.equal((await readFile(path.join(temporary, "lifecycle.model.calls"), "utf8")).trim().split("\n").length, 1, "original bridge prompt follows compaction exactly once");
      if (injectBranchChange) {
        assert.ok(lifecycle.includes("IDLE_CUSTOM_ENTRY_IN_COMPACTION"), lifecycle);
        const sideEntry = entries.findLast(entry => entry.type === "custom_message" && entry.customType === "offline-progress");
        assert.ok(sideEntry, "in-flight custom entry is persisted");
        assert.equal(compactEntry.parentId, sideEntry.id, "Pi appends compaction after the custom entry that moved the leaf");
      }
      const idleDeadline = Date.now() + 4000;
      while ((await ok("get_state")).isStreaming) {
        assert.ok(Date.now() < idleDeadline, "original model turn settles before the next transport check");
        await delay(20);
      }
    });
    await t.test("installed idle-context-warning revokes pending admission on bridge disconnect and reconnect", { skip: !process.env.BRIDGE_IDLE_CONTEXT_EXTENSION }, async () => {
      await writeFile(path.join(agent, "idle-context-warning.json"), JSON.stringify({ idleMinutes: 1440, contextPercent: 100, cheapCompactionModel: "bridge-offline/second" }));
      await seedHistory("/offline-fixture-seed-idle-history");
      await writeFile(path.join(agent, "idle-context-warning.json"), JSON.stringify({ idleMinutes: 1, contextPercent: 1, cheapCompactionModel: "bridge-offline/second" }));
      await rm(path.join(temporary, "lifecycle.model.calls"), { force: true });
      const pending = bridge("prompt", { message: "idle compact model delivery fixture" });
      void pending.catch(() => {});
      const deadline = Date.now() + 4000;
      while (!dialogs.length) {
        assert.ok(Date.now() < deadline, "idle decision must be pending before transport disconnect");
        await delay(10);
      }
      const oldSocket = socket!;
      const closed = once(oldSocket, "close");
      oldSocket.destroy();
      await closed;
      const replacement = connect(socketPath);
      await once(replacement, "connect");
      socket = replacement;
      bridge = rpc(replacement, line => replacement.write(line));
      ok = async (type: string, fields = {}) => {
        const result = await bridge(type, fields);
        assert.equal(result.command, type);
        assert.equal(result.success, true, JSON.stringify(result));
        return result.data;
      };
      const state = await ok("get_state");
      assert.equal(state.isStreaming, false);
      await assert.rejects(readFile(path.join(temporary, "lifecycle.model.calls")), { code: "ENOENT" }, "detached admission must not reach the model after reconnect");
    });
    await t.test("bridge-owned disconnect acknowledges acceptance, then closes only bridge transport", async () => {
      const closed = once(socket!, "close");
      const result = await ok("prompt", { message: "/paseo-bridge disconnect" });
      assert.deepEqual(result, { agentInvoked: false, disconnectAccepted: true });
      await closed;
      assert.equal(child.exitCode, null);
      assert.equal((await native("get_state")).success, true);
    });
  } finally {
    socket?.destroy();
    child.stdin.end();
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid) try { process.kill(-child.pid, signal); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<void>(resolve => {
        timer = setTimeout(() => { killGroup("SIGKILL"); resolve(); }, 3000);
      })]);
      if (child.exitCode === null && child.signalCode === null) await exited;
    } finally {
      clearTimeout(timer);
      killGroup("SIGKILL");
      if (child.pid) assert.throws(() => process.kill(child.pid!, 0), { code: "ESRCH" }, "Pi must be reaped");
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
