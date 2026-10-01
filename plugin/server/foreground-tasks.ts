import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { foregroundTaskResponseSchema, foregroundTasksRpc, foregroundTasksStatusRpc } from "../shared/foreground-tasks";
import { callForegroundTasks, readForegroundTasksDescriptor, validateForegroundTasksDescriptor } from "./foreground-tasks-transport";

export function createForegroundTasksHandlers(readDescriptor = readForegroundTasksDescriptor, callTasks = callForegroundTasks) {
  async function validateTarget(input: { agentId: string; workspaceId: string }, context: PluginHandlerContext) {
    const current = await context.paseo.agents.ref(input.agentId).refresh();
    if (!current || current.agent.id !== input.agentId || current.agent.workspaceId !== input.workspaceId || current.agent.provider !== "pi") {
      throw new Error("Foreground-task request does not match the current Pi agent workspace.");
    }
  }

  async function invoke(input: { agentId: string; workspaceId: string; expectedSessionId: string; expectedRuntimeEpoch: string }, request: Record<string, unknown>, context: PluginHandlerContext) {
    await validateTarget(input, context);
    const descriptor = await readDescriptor(input.agentId);
    if (!validateForegroundTasksDescriptor(descriptor, input.agentId) || descriptor.sessionId !== input.expectedSessionId || descriptor.runtimeEpoch !== input.expectedRuntimeEpoch) {
      throw new Error("The active Pi session changed. Refresh before controlling the task.");
    }
    const result = foregroundTaskResponseSchema.parse(await callTasks(descriptor, request));
    if (result.sessionId !== descriptor.sessionId || result.epoch !== descriptor.serviceEpoch) throw new Error("Foreground-task service identity mismatch.");
    await validateTarget(input, context);
    const currentDescriptor = await readDescriptor(input.agentId);
    if (!validateForegroundTasksDescriptor(currentDescriptor, input.agentId) || currentDescriptor.sessionId !== descriptor.sessionId
      || currentDescriptor.runtimeEpoch !== descriptor.runtimeEpoch || currentDescriptor.serviceEpoch !== descriptor.serviceEpoch) {
      throw new Error("The active Pi or foreground-task session changed during the request.");
    }
    return result;
  }

  return {
    status: async (input: RpcInput<typeof foregroundTasksStatusRpc>, context: PluginHandlerContext) => {
      await validateTarget(input, context);
      const raw = await readDescriptor(input.agentId);
      if (!validateForegroundTasksDescriptor(raw, input.agentId)) return { available: false, sessionId: null, runtimeEpoch: null, reason: "No connected Pi foreground-task controller is available." };
      try {
        const result = foregroundTaskResponseSchema.parse(await callTasks(raw, { operation: "list", sessionId: raw.sessionId, epoch: raw.serviceEpoch }));
        await validateTarget(input, context);
        const currentDescriptor = await readDescriptor(input.agentId);
        if (!validateForegroundTasksDescriptor(currentDescriptor, input.agentId) || currentDescriptor.sessionId !== raw.sessionId
          || currentDescriptor.runtimeEpoch !== raw.runtimeEpoch || currentDescriptor.serviceEpoch !== raw.serviceEpoch) throw new Error("Stale foreground-task identity");
        if (result.sessionId !== raw.sessionId || result.epoch !== raw.serviceEpoch) throw new Error("Foreground-task service identity mismatch");
        return result.state === "available"
          ? { available: true, sessionId: raw.sessionId, runtimeEpoch: raw.runtimeEpoch, tasks: result.tasks ?? [], reason: null }
          : { available: false, sessionId: raw.sessionId, runtimeEpoch: raw.runtimeEpoch, reason: result.message ?? "Foreground tasks are unavailable." };
      } catch (error) {
        return { available: false, sessionId: raw.sessionId, runtimeEpoch: raw.runtimeEpoch,
          reason: error instanceof Error ? error.message.slice(0, 1000) : "Foreground-task controller is unavailable." };
      }
    },
    control: (input: RpcInput<typeof foregroundTasksRpc>, context: PluginHandlerContext) => invoke(input, input.request as unknown as Record<string, unknown>, context),
  };
}
