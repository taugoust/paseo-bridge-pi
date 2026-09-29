import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const REQUEST_KEYS = ["v", "type", "id", "capability", "agentId", "sessionId", "runtimeEpoch", "action", "enabled"];
const MAX_FRAME_BYTES = 4096;

function failure(id, error) {
  return { v: 1, type: "permission_gate_mode", id: typeof id === "string" ? id : null, success: false, error };
}

/** Narrow local operator protocol. Capability is not a boundary against malicious same-UID code. */
export function handlePermissionGateOperatorRequest(value, identity) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const id = input.id;
  const expectedKeys = input.action === "status" ? REQUEST_KEYS.filter(key => key !== "enabled") : REQUEST_KEYS;
  if (Object.keys(input).sort().join("\0") !== [...expectedKeys].sort().join("\0")
    || input.v !== 1 || input.type !== "permission_gate_mode"
    || typeof id !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(id)
    || typeof input.capability !== "string" || !/^[a-f0-9]{64}$/.test(input.capability)
    || typeof input.agentId !== "string" || typeof input.sessionId !== "string"
    || typeof input.runtimeEpoch !== "string"
    || (input.action !== "status" && input.action !== "set")
    || (input.action === "set" && typeof input.enabled !== "boolean")) {
    return failure(id, "Invalid permission-gate operator request");
  }

  const expected = identity.descriptor;
  const supplied = Buffer.from(input.capability, "hex");
  const actual = Buffer.from(expected.capability, "hex");
  if (supplied.length !== actual.length || !timingSafeEqual(supplied, actual)
    || input.agentId !== expected.agentId || input.sessionId !== expected.sessionId
    || input.runtimeEpoch !== expected.runtimeEpoch) {
    return failure(id, "Permission-gate operator authentication failed");
  }

  try {
    const authority = identity.authority();
    if (!authority) throw new Error("Permission-gate operator unavailable");
    const mode = input.action === "status"
      ? authority.status(expected.sessionId)
      : authority.applyMode(expected.sessionId, input.enabled);
    if (mode.sessionId !== expected.sessionId || typeof mode.enabled !== "boolean") {
      throw new Error("Permission-gate operator returned mismatched session state");
    }
    return {
      v: 1,
      type: "permission_gate_mode",
      id,
      success: true,
      data: { agentId: expected.agentId, sessionId: expected.sessionId, runtimeEpoch: expected.runtimeEpoch, enabled: mode.enabled },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(id, message.replace(/[\r\n\x00-\x1f\x7f]+/g, " ").slice(0, 500));
  }
}

export function decodePermissionGateOperatorFrame(frame) {
  if (frame.length === 0 || frame.length > MAX_FRAME_BYTES) throw new Error("Invalid permission-gate operator frame size");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(frame);
  return JSON.parse(text);
}

export function permissionGateOperatorSocketPath(bridgeSocket) {
  return `${bridgeSocket}.operator`;
}

export function permissionGateOperatorDescriptorPath(baseDir, agentId) {
  const key = createHash("sha256").update(agentId).digest("hex");
  return path.join(baseDir, "operators", `${key}.json`);
}

export function harnessReadOnlyDescriptorPath(baseDir, agentId) {
  const key = createHash("sha256").update(agentId).digest("hex");
  return path.join(baseDir, "operators", `${key}.readonly.json`);
}

export function writeHarnessReadOnlyDescriptor(baseDir, descriptor) {
  const directory = path.join(baseDir, "operators");
  ensurePrivateDirectory(directory);
  const destination = harnessReadOnlyDescriptorPath(baseDir, descriptor.agentId);
  try {
    const existingStat = fs.lstatSync(destination);
    if (existingStat.isFile() && !existingStat.isSymbolicLink()
      && (typeof process.getuid !== "function" || existingStat.uid === process.getuid())
      && (existingStat.mode & 0o777) === 0o600
      && JSON.stringify(JSON.parse(fs.readFileSync(destination, "utf8"))) === JSON.stringify(descriptor)) return destination;
  } catch { /* create or replace a missing/invalid descriptor */ }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(descriptor)}\n`); fs.fsyncSync(fd); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, destination); fs.chmodSync(destination, 0o600);
  return destination;
}

export function removeHarnessReadOnlyDescriptor(baseDir, agentId, runtimeEpoch) {
  const destination = harnessReadOnlyDescriptorPath(baseDir, agentId);
  try {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return;
    const descriptor = JSON.parse(fs.readFileSync(destination, "utf8"));
    if (descriptor.agentId === agentId && descriptor.runtimeEpoch === runtimeEpoch) fs.unlinkSync(destination);
  } catch {}
}

function ensurePrivateDirectory(directory) {
  try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  catch { /* checked below */ }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("Permission-gate operator directory is not private and owned by this user");
  }
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(directory, 0o700);
}

/** Descriptor is private metadata for the trusted-local Paseo plugin, not public runtime state. */
export function writePermissionGateOperatorDescriptor(baseDir, descriptor) {
  const directory = path.join(baseDir, "operators");
  ensurePrivateDirectory(directory);
  const destination = permissionGateOperatorDescriptorPath(baseDir, descriptor.agentId);
  try {
    const existingStat = fs.lstatSync(destination);
    if (existingStat.isFile() && !existingStat.isSymbolicLink()
      && (typeof process.getuid !== "function" || existingStat.uid === process.getuid())
      && (existingStat.mode & 0o777) === 0o600
      && JSON.stringify(JSON.parse(fs.readFileSync(destination, "utf8"))) === JSON.stringify(descriptor)) return destination;
  } catch { /* create or replace a missing/invalid descriptor */ }
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
    | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(descriptor)}\n`);
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
  return destination;
}

export function removePermissionGateOperatorDescriptor(baseDir, agentId, runtimeEpoch) {
  const directory = path.join(baseDir, "operators");
  try { ensurePrivateDirectory(directory); }
  catch { return; }
  const destination = permissionGateOperatorDescriptorPath(baseDir, agentId);
  try {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return;
    const descriptor = JSON.parse(fs.readFileSync(destination, "utf8"));
    if (descriptor.agentId === agentId && descriptor.runtimeEpoch === runtimeEpoch) fs.unlinkSync(destination);
  } catch { /* stale or already removed */ }
}
