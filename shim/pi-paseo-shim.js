#!/usr/bin/env node
// pi-paseo-shim: configured as Paseo's `pi` provider command. If the session
// Paseo is resuming has a live TUI process (detected via the bridge pipe the
// pi-paseo-bridge extension opens), bridge stdio to that pipe. Otherwise spawn
// the real pi with unchanged argv so Paseo-native behaviour is preserved.
import net from "node:net";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const CONNECT_TIMEOUT_MS = 500;
const args = process.argv.slice(2);

// Keep in sync with extension/index.ts (pipePathForSession).
function pipePathForSession(sessionFile) {
  let normalized = path.resolve(sessionFile);
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 20);
  if (process.platform === "win32") return `\\\\.\\pipe\\pi-paseo-bridge-${hash}`;
  const dir = process.env.XDG_RUNTIME_DIR
    ? path.join(process.env.XDG_RUNTIME_DIR, "pi-paseo")
    : path.join(os.homedir(), ".pi", "paseo-bridge");
  return path.join(dir, `${hash}.sock`);
}

function extractSessionArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--session" && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith("--session=")) return argv[i].slice("--session=".length);
  }
  return null;
}

function tryConnect(pipePath) {
  return new Promise((resolve) => {
    const socket = net.connect(pipePath);
    const fail = () => {
      socket.destroy();
      resolve(null);
    };
    const timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
    socket.once("error", () => {
      clearTimeout(timer);
      fail();
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

function bridge(socket) {
  socket.setNoDelay?.(true);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  process.stdin.on("end", () => socket.end());
  socket.on("close", () => process.exit(0));
  socket.on("error", () => process.exit(1));
}

function resolveRealPi() {
  const override = process.env.PI_REAL_BIN;
  if (override) {
    if (override.endsWith(".js") || override.endsWith(".mjs") || override.endsWith(".cjs")) {
      return { command: process.execPath, prefix: [override] };
    }
    return { command: override, prefix: [] };
  }
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const names = process.platform === "win32" ? ["pi.cmd", "pi.bat", "pi.exe", "pi"] : ["pi"];
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(candidate);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      // npm-style launcher (.cmd or extensionless sh script): spawn the JS
      // entry directly with node, since Node refuses to spawn .cmd files
      // without a shell and shell quoting is unsafe.
      const npmEntry = path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
      if (fs.existsSync(npmEntry) && !candidate.endsWith(".exe")) {
        return { command: process.execPath, prefix: [npmEntry] };
      }
      if (process.platform === "win32" && !candidate.endsWith(".exe")) continue;
      return { command: candidate, prefix: [] };
    }
  }
  return null;
}

function passthrough() {
  const real = resolveRealPi();
  if (!real) {
    process.stderr.write(
      "pi-paseo-shim: could not locate the real pi binary. Set PI_REAL_BIN to the pi executable or its cli.js.\n",
    );
    process.exit(1);
  }
  const child = spawn(real.command, [...real.prefix, ...args], { stdio: "inherit" });
  child.on("error", (err) => {
    process.stderr.write(`pi-paseo-shim: failed to spawn real pi: ${err.message}\n`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : (code ?? 1));
  });
}

async function main() {
  const sessionFile = extractSessionArg(args);
  if (sessionFile) {
    const pipePath = pipePathForSession(sessionFile);
    const socket = await tryConnect(pipePath);
    if (socket) {
      bridge(socket);
      return;
    }
    if (process.platform !== "win32") {
      // A socket file that refuses connections is stale from a crash.
      try {
        fs.unlinkSync(pipePath);
      } catch {
        // absent or not ours - nothing to clean
      }
    }
  }
  passthrough();
}

main();
