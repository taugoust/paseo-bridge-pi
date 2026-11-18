import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const SUBAGENT_ROUTING_PROTOCOL = 1;
export function subagentRoutingSocketPath(bridgeSocket) { return `${bridgeSocket}.subagent-routing`; }
export function subagentRoutingDescriptorPath(baseDir, agentId) { return path.join(baseDir, "operators", `${createHash("sha256").update(agentId).digest("hex")}.subagents.json`); }
function ensureDirectory(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Subagent descriptor directory is not private");
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}
export function writeSubagentRoutingDescriptor(baseDir, descriptor) {
  const dir = path.join(baseDir, "operators"); ensureDirectory(dir); const destination = subagentRoutingDescriptorPath(baseDir, descriptor.agentId);
  try {
    const existing = fs.lstatSync(destination);
    if (existing.isFile() && !existing.isSymbolicLink() && (typeof process.getuid !== "function" || existing.uid === process.getuid())
      && (existing.mode & 0o777) === 0o600 && JSON.stringify(JSON.parse(fs.readFileSync(destination, "utf8"))) === JSON.stringify(descriptor)) return destination;
  } catch { /* replace missing or invalid descriptor */ }
  const temp = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(descriptor)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, destination); fs.chmodSync(destination, 0o600); return destination;
}
export function removeSubagentRoutingDescriptor(baseDir, agentId, runtimeEpoch) {
  const dest = subagentRoutingDescriptorPath(baseDir, agentId);
  try { const stat = fs.lstatSync(dest); if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return;
    const descriptor = JSON.parse(fs.readFileSync(dest, "utf8")); if (descriptor.agentId === agentId && descriptor.runtimeEpoch === runtimeEpoch) fs.unlinkSync(dest);
  } catch {}
}
function exactKeys(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys.slice().sort().join(","); }
function validSelection(value) {
  return value === null || (exactKeys(value, ["providerId", "accountId"])
    && typeof value.providerId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.providerId)
    && !["session-follow", "unknown"].includes(value.providerId)
    && (value.accountId === null || (value.providerId === "openai-codex" && typeof value.accountId === "string" && value.accountId.length > 0 && value.accountId.length <= 256 && !/[\x00-\x1f]/.test(value.accountId))));
}
export function validateSubagentRoutingEnvelope(value, identity) {
  if (!exactKeys(value, ["v", "type", "id", "capability", "agentId", "sessionId", "runtimeEpoch", "serviceEpoch", "request"])) return false;
  if (value.v !== 1 || value.type !== "subagent_routing" || typeof value.id !== "string" || !/^[\w.:-]{1,128}$/.test(value.id)
    || typeof value.capability !== "string" || !/^[a-f0-9]{64}$/.test(value.capability) || !value.request || typeof value.request !== "object" || Array.isArray(value.request)) return false;
  const a = Buffer.from(value.capability, "hex"), b = Buffer.from(identity.capability, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  if (value.agentId !== identity.agentId || value.sessionId !== identity.sessionId || value.runtimeEpoch !== identity.runtimeEpoch || value.serviceEpoch !== identity.serviceEpoch) return false;
  const r = value.request;
  if (r.operation === "snapshot" || r.operation === "providers") return exactKeys(r, ["operation", "sessionId"]) && r.sessionId === identity.sessionId;
  if (r.operation === "set") {
    const q = r.request;
    return exactKeys(r, ["operation", "request"]) && exactKeys(q, ["expectedSessionId", "expectedServiceEpoch", "expectedRevision", "selection"])
      && q.expectedSessionId === identity.sessionId && q.expectedServiceEpoch === identity.serviceEpoch
      && Number.isSafeInteger(q.expectedRevision) && q.expectedRevision >= 0 && validSelection(q.selection);
  }
  return false;
}
export function subagentRoutingCapability() { return randomBytes(32).toString("hex"); }
