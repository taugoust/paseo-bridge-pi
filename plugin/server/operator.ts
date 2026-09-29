import { createHash } from "node:crypto";
import { constants, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { PermissionGateDescriptor } from "../shared/permission-gate";
import { permissionGateSetRpc, permissionGateStatusRpc, validateDescriptor } from "../shared/permission-gate";
import { descriptorMatchesExpectedSession } from "../shared/wire";
import { callOperator } from "./operator-transport";

export type DescriptorReader = (agentId: string) => Promise<unknown>;

export function operatorDescriptorPath(agentId: string, baseDir = join(homedir(), ".pi", "paseo-bridge")) {
  const key = createHash("sha256").update(agentId).digest("hex");
  return join(baseDir, "operators", `${key}.json`);
}

export const readOperatorDescriptor: DescriptorReader = async (agentId) => {
  if (!agentId || agentId.length > 256) return undefined;
  try {
    const directoryPath = join(homedir(), ".pi", "paseo-bridge", "operators");
    const directory = await lstat(directoryPath);
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || (typeof process.getuid === "function" && directory.uid !== process.getuid())
      || (directory.mode & 0o777) !== 0o700) return undefined;
    const handle = await open(operatorDescriptorPath(agentId), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid())
        || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) return undefined;
      return JSON.parse(await handle.readFile("utf8")) as unknown;
    } finally { await handle.close(); }
  } catch { return undefined; }
};

export function createHandlers(readDescriptor: DescriptorReader) {
  const validateTarget = async (input: { agentId: string; workspaceId: string }, context: PluginHandlerContext) => {
    const result = await context.paseo.agents.ref(input.agentId).refresh();
    if (!result || result.agent.id !== input.agentId || result.agent.workspaceId !== input.workspaceId) throw new Error("Permission request does not match the current agent workspace.");
  };
  const status = async (input: RpcInput<typeof permissionGateStatusRpc>, context: PluginHandlerContext) => {
    await validateTarget(input, context);
    const raw = await readDescriptor(input.agentId);
    if (!validateDescriptor(raw, input.agentId)) return { available: false, enabled: null, sessionId: null, runtimeEpoch: null, reason: "This agent has no active permission operator." };
    try {
      const enabled = await callOperator(raw, "status");
      return { available: true, enabled, sessionId: raw.sessionId, runtimeEpoch: raw.runtimeEpoch, reason: null };
    } catch {
      return { available: false, enabled: null, sessionId: null, runtimeEpoch: null, reason: "Permission operator is unavailable; no change was made." };
    }
  };
  const set = async (input: RpcInput<typeof permissionGateSetRpc>, context: PluginHandlerContext) => {
    await validateTarget(input, context);
    const raw = await readDescriptor(input.agentId);
    if (!validateDescriptor(raw, input.agentId)) throw new Error("This agent has no active permission operator.");
    if (!descriptorMatchesExpectedSession(raw, input.expectedSessionId, input.expectedRuntimeEpoch)) throw new Error("This agent's permission session changed. Refresh status before applying a setting.");
    return { enabled: await callOperator(raw, "set", input.enabled) };
  };
  return { status, set };
}
