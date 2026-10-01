import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const FOREGROUND_TASKS_PROTOCOL = 1;
const MAX_FRAME_BYTES = 512 * 1024;

export function foregroundTasksSocketPath(bridgeSocket) { return `${bridgeSocket}.foreground-tasks`; }
export function foregroundTasksDescriptorPath(baseDir, agentId) {
  const key = createHash("sha256").update(agentId).digest("hex");
  return path.join(baseDir, "operators", `${key}.foreground.json`);
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("Foreground-task descriptor directory is not private");
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(directory, 0o700);
}

export function writeForegroundTasksDescriptor(baseDir, descriptor) {
  const directory = path.join(baseDir, "operators");
  ensurePrivateDirectory(directory);
  const destination = foregroundTasksDescriptorPath(baseDir, descriptor.agentId);
  try {
    const existingStat = fs.lstatSync(destination);
    if (existingStat.isFile() && !existingStat.isSymbolicLink() && (typeof process.getuid !== "function" || existingStat.uid === process.getuid())
      && (existingStat.mode & 0o777) === 0o600 && JSON.stringify(JSON.parse(fs.readFileSync(destination, "utf8"))) === JSON.stringify(descriptor)) return destination;
  } catch { /* replace missing or invalid descriptor */ }
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(descriptor)}\n`); fs.fsyncSync(fd); }
  catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, destination); fs.chmodSync(destination, 0o600);
  return destination;
}

export function removeForegroundTasksDescriptor(baseDir, agentId, runtimeEpoch) {
  const destination = foregroundTasksDescriptorPath(baseDir, agentId);
  try {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return;
    const descriptor = JSON.parse(fs.readFileSync(destination, "utf8"));
    if (descriptor.agentId === agentId && descriptor.runtimeEpoch === runtimeEpoch) fs.unlinkSync(destination);
  } catch {}
}

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key));
}
function boundedString(value, maximum = 256) { return typeof value === "string" && value.length > 0 && value.length <= maximum; }
function validTaskTarget(value) {
  return exactKeys(value, ["taskId", "childId", "workerEpoch"]) && boundedString(value.taskId) && boundedString(value.childId) && boundedString(value.workerEpoch);
}
function validInteractionAnswer(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.cancelled !== "boolean") return false;
  if (value.kind === "permission") return exactKeys(value, ["kind", "cancelled"], ["value"]) && (!('value' in value) || typeof value.value === "string" && value.value.length <= 2000);
  if (value.kind === "questionnaire") return exactKeys(value, ["kind", "cancelled", "answers"]) && Array.isArray(value.answers) && value.answers.length <= 100
    && value.answers.every(answer => exactKeys(answer, ["id", "value", "wasCustom"]) && boundedString(answer.id) && typeof answer.value === "string" && answer.value.length <= 2000 && typeof answer.wasCustom === "boolean");
  return false;
}
function validCommand(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) || !boundedString(request.sessionId) || !boundedString(request.epoch, 256)) return false;
  if (request.operation === "list") return exactKeys(request, ["operation", "sessionId", "epoch"]);
  if (request.operation === "view") return exactKeys(request, ["operation", "sessionId", "epoch", "target"], ["cursor"])
    && validTaskTarget(request.target) && (!('cursor' in request) || typeof request.cursor === "string" && request.cursor.length <= 1024);
  if (request.operation === "prompt") return exactKeys(request, ["operation", "sessionId", "epoch", "target", "requestId", "message"])
    && validTaskTarget(request.target) && typeof request.requestId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(request.requestId)
    && typeof request.message === "string" && request.message.length > 0 && request.message.length <= 16000;
  if (request.operation === "respond") return exactKeys(request, ["operation", "sessionId", "epoch", "target", "requestId", "interactionId", "answer"])
    && validTaskTarget(request.target) && typeof request.requestId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(request.requestId)
    && boundedString(request.interactionId) && validInteractionAnswer(request.answer);
  if (request.operation === "stop") return exactKeys(request, ["operation", "sessionId", "epoch", "target", "requestId"])
    && validTaskTarget(request.target) && typeof request.requestId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(request.requestId);
  return false;
}

export function validateForegroundTasksEnvelope(value, identity) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value;
  if (Object.keys(request).sort().join(",") !== "agentId,capability,id,request,runtimeEpoch,sessionId,type,v"
    || request.v !== 1 || request.type !== "foreground_tasks" || typeof request.id !== "string"
    || !/^[a-zA-Z0-9._:-]{1,128}$/.test(request.id) || typeof request.capability !== "string"
    || !/^[a-f0-9]{64}$/.test(request.capability) || typeof request.agentId !== "string"
    || typeof request.sessionId !== "string" || typeof request.runtimeEpoch !== "string"
    || !request.request || typeof request.request !== "object" || Array.isArray(request.request)) return false;
  const supplied = Buffer.from(request.capability, "hex"), expected = Buffer.from(identity.capability, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
  return request.agentId === identity.agentId && request.sessionId === identity.sessionId && request.runtimeEpoch === identity.runtimeEpoch
    && request.request.sessionId === identity.service.sessionId && request.request.epoch === identity.service.epoch && validCommand(request.request);
}

export function decodeForegroundTasksFrame(frame) {
  if (!frame.length || frame.length > MAX_FRAME_BYTES) throw new Error("Invalid foreground-task frame size");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
}

export function foregroundTasksCapability() { return randomBytes(32).toString("hex"); }
export function foregroundTasksFrameLimit() { return MAX_FRAME_BYTES; }
