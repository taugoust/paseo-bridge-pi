import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const piBin = process.env.TEST_PI_BIN;

test("Paseo-native RPC sessions can dispatch reload as an extension command", { skip: !piBin, timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-native-reload-"));
  const child = spawn(piBin!, ["--mode", "rpc", "--no-session", "--no-extensions", "--extension", resolve("extension/index.ts")], {
    cwd: root,
    env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"), PI_PASEO_BRIDGE: "on",
      PI_PASEO_BRIDGE_FORCE: "0", PI_PASEO_BRIDGE_NO_IMPORT: "1", PI_PASEO_BRIDGE_NO_TITLE: "1", PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const frames: any[] = [];
  let buffer = "";
  child.stdout.on("data", data => {
    buffer += data.toString();
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      frames.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
  });
  const waitFor = async (predicate: (frame: any) => boolean) => {
    const deadline = Date.now() + 10000;
    while (!frames.some(predicate)) {
      assert(child.exitCode === null && Date.now() < deadline, `${stderr}\n${JSON.stringify(frames)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return frames.find(predicate);
  };
  try {
    child.stdin.write('{"id":"reload","type":"prompt","message":"/reload"}\n');
    await waitFor(frame => frame.type === "extension_ui_request" && frame.message === "Pi runtime reloaded.");
    assert.equal((await waitFor(frame => frame.id === "reload")).success, true);
    child.stdin.write('{"id":"after","type":"get_state"}\n');
    assert.equal((await waitFor(frame => frame.id === "after")).success, true);
    assert(!frames.some(frame => frame.type === "agent_start" || frame.type === "extension_error"));
    assert.equal(child.exitCode, null);
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 3000);
    try { await closed; } finally { clearTimeout(timer); await rm(root, { recursive: true, force: true }); }
  }
});
