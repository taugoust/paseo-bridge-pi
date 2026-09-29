import assert from "node:assert/strict";
import test from "node:test";
import * as net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const piBin = process.env.TEST_PI_BIN;

async function waitFor<T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function connectWithRetry(socketPath: string): Promise<net.Socket> {
  const deadline = Date.now() + 10_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const socket = net.connect(socketPath);
    try {
      await Promise.race([once(socket, "connect"), once(socket, "error").then(([error]) => Promise.reject(error))]);
      return socket;
    } catch (error) {
      lastError = error;
      socket.destroy();
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error(`Could not connect to ${socketPath}: ${String(lastError)}`);
}

async function operatorExchange(socketPath: string, request: Record<string, unknown>): Promise<any> {
  const socket = await connectWithRetry(socketPath);
  let data = "";
  socket.on("data", chunk => { data += chunk.toString(); });
  socket.end(`${JSON.stringify(request)}\n`);
  await once(socket, "close");
  return JSON.parse(data.trim());
}

test("real Pi publishes/revokes private operator descriptor and rejects stale epochs without model traffic", {
  skip: !piBin,
  timeout: 30_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-permission-gate-operator-"));
  const runtimeDir = join(root, "runtime");
  const agentDir = join(root, "agent");
  const socketPath = join(root, "bridge.sock");
  const sessionFile = join(root, "session.jsonl");
  const mockGate = join(root, "mock-gate.ts");
  await writeFile(mockGate, `
    export default function (pi) {
      let enabled = true;
      globalThis.__PAE_PERMISSION_GATE_OPERATOR_V1__ = {
        version: 1,
        status(sessionId) { return { sessionId, enabled }; },
        applyMode(sessionId, next) { enabled = next; return { sessionId, enabled }; },
      };
    }
  `);
  const child = spawn(piBin!, ["--mode", "rpc", "--session", sessionFile, "--no-tools", "--no-extensions",
    "--extension", mockGate, "--extension", resolve("extension/index.ts")], {
    cwd: root,
    env: { ...process.env, HOME: root, XDG_RUNTIME_DIR: runtimeDir, PI_CODING_AGENT_DIR: agentDir,
      PI_PASEO_AGENT_SOCKET: socketPath, PI_PASEO_EXISTING_AGENT_ID: "agent-integration",
      PI_PASEO_BRIDGE: "on", PI_PASEO_BRIDGE_FORCE: "1", PI_PASEO_BRIDGE_NO_TITLE: "1", PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const childClosed = once(child, "close");
  let stderr = "";
  child.stdout.on("data", () => {}); // Drain RPC startup output while keeping this a no-model test.
  child.stderr.on("data", data => { stderr += data.toString(); });
  const bridgeMessages: any[] = [];
  let buffer = "";
  const descriptorDir = join(root, ".pi", "paseo-bridge", "operators");
  const descriptorPath = join(descriptorDir, `${createHash("sha256").update("agent-integration").digest("hex")}.json`);
  let client: net.Socket | undefined;
  let replacement: net.Socket | undefined;
  try {
    client = await connectWithRetry(socketPath);
    client.on("data", chunk => {
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        bridgeMessages.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    const descriptor = await waitFor(async () => {
      assert.equal(child.exitCode, null, `Pi exited before descriptor publication: ${stderr}`);
      try { return JSON.parse(await readFile(descriptorPath, "utf8")); } catch { return undefined; }
    }, `permission-gate operator descriptor (${stderr})`);
    assert.equal(typeof descriptor.sessionId, "string");
    assert.ok(descriptor.sessionId.length > 0);
    assert.equal(descriptor.agentId, "agent-integration");
    const initialEpoch = descriptor.runtimeEpoch;
    const statusRequest = { v: 1, type: "permission_gate_mode", id: "integration-status", capability: descriptor.capability,
      agentId: descriptor.agentId, sessionId: descriptor.sessionId, runtimeEpoch: initialEpoch, action: "status" };
    assert.equal((await operatorExchange(descriptor.socketPath, statusRequest)).data.enabled, true);
    const setResponse = await operatorExchange(descriptor.socketPath, { ...statusRequest, id: "integration-set", action: "set", enabled: false });
    assert.equal(setResponse.success, true);
    assert.equal(setResponse.data.enabled, false);

    client.write('{"id":"integration-state","type":"get_state"}\n');
    const stateReply = await waitFor(async () => bridgeMessages.find(message => message.id === "integration-state"), "ordinary bridge state response");
    assert.equal(stateReply.success, true);
    assert.equal(JSON.stringify(stateReply).includes(descriptor.capability), false, "operator capability must not leak in public bridge state");

    client.destroy();
    await waitFor(async () => {
      try { await readFile(descriptorPath); return undefined; } catch { return true; }
    }, "descriptor revocation on controller disconnect");
    replacement = await connectWithRetry(socketPath);
    replacement.on("data", chunk => {
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        bridgeMessages.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    const fresh = await waitFor(async () => {
      try {
        const value = JSON.parse(await readFile(descriptorPath, "utf8"));
        return value.runtimeEpoch !== initialEpoch ? value : undefined;
      } catch { return undefined; }
    }, "descriptor republish with new epoch");
    const staleResponse = await operatorExchange(fresh.socketPath, { ...statusRequest, id: "integration-stale" });
    assert.equal(staleResponse.success, false);
    assert.match(staleResponse.error, /authentication failed/i);

    // The separate operator endpoint did not route through regular RPC; no
    // prompt/abort/agent-turn frames were generated by these controls.
    assert.equal(bridgeMessages.some(message => ["prompt", "abort", "steer", "follow_up"].includes(message.command)), false);
    assert.equal(stderr, "");
  } finally {
    client?.destroy();
    replacement?.destroy();
    child.stdin.end();
    child.kill("SIGTERM");
    let hardKillTimer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<void>(resolve => {
      hardKillTimer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 3000);
    });
    try { await Promise.race([childClosed.then(() => undefined), timedOut]); }
    finally { clearTimeout(hardKillTimer!); if (child.exitCode === null) child.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
  }
});
