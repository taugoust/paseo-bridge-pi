import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const extensionDir = norm(path.join(repoRoot, "extension"));
export const shimPath = norm(path.join(repoRoot, "shim", "pi-paseo-shim.js"));
export const piSettingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");
export const paseoConfigPath = path.join(os.homedir(), ".paseo", "config.json");

export function norm(p) {
  return p.replaceAll("\\", "/");
}

export function samePath(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const na = norm(path.resolve(a));
  const nb = norm(path.resolve(b));
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

// Throws on invalid JSON so we never clobber a file we couldn't parse.
export function readJson(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function isOurShimCommand(command) {
  return (
    Array.isArray(command) &&
    command.some((part) => typeof part === "string" && norm(part).toLowerCase().endsWith("/shim/pi-paseo-shim.js"))
  );
}
