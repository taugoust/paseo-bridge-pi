import { createHash } from "node:crypto";
import { constants, lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { harnessJobsListRpc, harnessJobsOutputRpc, harnessSubagentsListRpc, harnessSubagentReportRpc,
  harnessStatusRpc } from "../shared/harness-readonly";
import { callHarnessReadOnly, validateHarnessReadOnlyDescriptor } from "./harness-readonly-transport";

export async function readHarnessDescriptor(agentId: string): Promise<unknown> {
  if (!agentId || agentId.length > 256) return undefined;
  const key = createHash("sha256").update(agentId).digest("hex");
  const directoryPath = join(homedir(), ".pi", "paseo-bridge", "operators");
  try {
    const directory = await lstat(directoryPath);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (typeof process.getuid === "function" && directory.uid !== process.getuid()) || (directory.mode & 0o777) !== 0o700) return undefined;
    const handle = await open(join(directoryPath, `${key}.readonly.json`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const stat = await handle.stat(); if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) return undefined; return JSON.parse(await handle.readFile("utf8")); }
    finally { await handle.close(); }
  } catch { return undefined; }
}

export function createHarnessReadOnlyHandlers(readDescriptor = readHarnessDescriptor) {
  async function validateTarget(input: { agentId: string; workspaceId: string }, context: PluginHandlerContext) {
    const current = await context.paseo.agents.ref(input.agentId).refresh();
    if (!current || current.agent.id !== input.agentId || current.agent.workspaceId !== input.workspaceId) throw new Error("Read-only request does not match the current agent workspace.");
  }
  async function invoke(input: { agentId: string; workspaceId: string; expectedSessionId: string; expectedRuntimeEpoch: string }, method: string, payload: Record<string, unknown>, context: PluginHandlerContext) {
    await validateTarget(input, context);
    const descriptor = await readDescriptor(input.agentId);
    if (!validateHarnessReadOnlyDescriptor(descriptor, input.agentId) || descriptor.sessionId !== input.expectedSessionId || descriptor.runtimeEpoch !== input.expectedRuntimeEpoch) throw new Error("The active Pi session changed; refresh before requesting harness data.");
    const result = await callHarnessReadOnly(descriptor, method, { ...payload, sessionId: descriptor.sessionId });
    await validateTarget(input, context);
    const currentDescriptor = await readDescriptor(input.agentId);
    if (!validateHarnessReadOnlyDescriptor(currentDescriptor, input.agentId) || currentDescriptor.sessionId !== descriptor.sessionId
      || currentDescriptor.runtimeEpoch !== descriptor.runtimeEpoch) throw new Error("The active Pi session changed while reading harness data.");
    return result;
  }
  return {
    status: async (input: RpcInput<typeof harnessStatusRpc>, context: PluginHandlerContext) => {
      await validateTarget(input, context);
      const raw = await readDescriptor(input.agentId);
      if (!validateHarnessReadOnlyDescriptor(raw, input.agentId)) return { available: false, sessionId: null, runtimeEpoch: null, reason: "No connected Pi session is publishing harness read-only status." };
      try {
        const result: any = await callHarnessReadOnly(raw, "status", { sessionId: raw.sessionId });
        if (!result || result.available !== true || result.sessionId !== raw.sessionId) throw new Error("Stale status");
        await validateTarget(input, context);
        const currentDescriptor = await readDescriptor(input.agentId);
        if (!validateHarnessReadOnlyDescriptor(currentDescriptor, input.agentId) || currentDescriptor.sessionId !== raw.sessionId
          || currentDescriptor.runtimeEpoch !== raw.runtimeEpoch) throw new Error("Stale status identity");
        return { available: true, sessionId: raw.sessionId, runtimeEpoch: raw.runtimeEpoch, reason: null };
      } catch { return { available: false, sessionId: null, runtimeEpoch: null, reason: "Read-only harness endpoint is unavailable." }; }
    },
    jobsList: (input: RpcInput<typeof harnessJobsListRpc>, context: PluginHandlerContext) => invoke(input, "jobs.list", { limit: input.limit, cursor: input.cursor }, context),
    jobsOutput: (input: RpcInput<typeof harnessJobsOutputRpc>, context: PluginHandlerContext) => invoke(input, "jobs.output", { jobId: input.jobId, maxBytes: input.maxBytes }, context),
    subagentsList: (input: RpcInput<typeof harnessSubagentsListRpc>, context: PluginHandlerContext) => invoke(input, "subagents.list", { limit: input.limit, cursor: input.cursor }, context),
    subagentReport: (input: RpcInput<typeof harnessSubagentReportRpc>, context: PluginHandlerContext) => invoke(input, "subagents.report", { taskId: input.taskId, maxBytes: input.maxBytes }, context),
  };
}
