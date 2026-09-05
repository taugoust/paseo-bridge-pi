import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as net from "node:net";

const piBin = process.env.TEST_PI_BIN;

test("real Pi reload acknowledges once, retains the Paseo socket and rebinds commands", { skip: !piBin, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-live-reload-"));
  const session = join(root, "session.jsonl");
  const runtime = join(root, "runtime");
  await mkdir(runtime);
  await writeFile(session, JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: root }) + "\n");
  const child = spawn(piBin!, ["--mode", "rpc", "--session", session, "--no-extensions", "--extension", resolve("extension/index.ts")], {
    cwd: root,
    env: { ...process.env, HOME: root, XDG_RUNTIME_DIR: runtime, PI_CODING_AGENT_DIR: join(root, "agent"),
      PI_PASEO_BRIDGE: "on", PI_PASEO_BRIDGE_FORCE: "1", PI_PASEO_BRIDGE_NO_IMPORT: "1", PI_PASEO_BRIDGE_NO_TITLE: "1", PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  child.stdout.resume();
  const exited = once(child, "close");
  let client: net.Socket | undefined;
  try {
    const hash = createHash("sha256").update(session).digest("hex").slice(0, 20);
    const socketPath = join(runtime, "pi-paseo", `${hash}.sock`);
    const deadline = Date.now() + 15000;
    while (!client) {
      const candidate = net.connect(socketPath);
      try { await once(candidate, "connect"); client = candidate; }
      catch {
        candidate.destroy();
        assert(child.exitCode === null && Date.now() < deadline, `bridge did not start: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    const frames: any[] = [];
    let buffer = "";
    client.on("data", data => {
      buffer += data.toString();
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        frames.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
    });
    const waitFor = async (predicate: (frame: any) => boolean) => {
      const end = Date.now() + 10000;
      while (!frames.some(predicate)) {
        assert(!client!.destroyed && child.exitCode === null && Date.now() < end, `reload did not finish: ${stderr}\n${JSON.stringify(frames)}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return frames.find(predicate);
    };
    client.write('{"id":"before","type":"get_commands"}\n');
    const commands = await waitFor(frame => frame.id === "before");
    assert(commands.data.commands.some((command: any) => command.name === "paseo-reload"));
    const pid = child.pid;
    for (const [index, command] of ["/reload", "/paseo-reload"].entries()) {
      const id = `reload-${index}`;
      const start = frames.length;
      client.write(JSON.stringify({ id, type: "prompt", message: command }) + "\n");
      const accepted = await waitFor(frame => frame.id === id);
      assert.equal(accepted.success, true);
      assert.equal(accepted.data.agentInvoked, false);
      await waitFor(frame => frames.indexOf(frame) >= start && frame.type === "extension_ui_request" && frame.message?.startsWith("Pi runtime reloaded."));
      assert.equal(frames.filter(frame => frame.id === id).length, 1);
      assert.equal(child.pid, pid);
      assert.equal(client.destroyed, false);
      client.write(JSON.stringify({ id: `after-${index}`, type: "get_state" }) + "\n");
      assert.equal((await waitFor(frame => frame.id === `after-${index}`)).success, true);
    }
    assert(!frames.some(frame => frame.type === "agent_start" || frame.type === "process_exit"));
    assert(!stderr.includes("Failed to load extension"), stderr);
  } finally {
    client?.destroy();
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 3000);
    try { await exited; } finally { clearTimeout(timer); await rm(root, { recursive: true, force: true }); }
  }
});
