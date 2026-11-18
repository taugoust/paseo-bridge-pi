import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { subagentRoutingSetRpc, subagentRoutingSnapshotSchema, subagentRoutingStatusRpc } from "../shared/subagent-routing";
import { callSubagentRouting, readSubagentRoutingDescriptor, validateSubagentRoutingDescriptor } from "./subagent-routing-transport";

export function createSubagentRoutingHandlers(readDescriptor = readSubagentRoutingDescriptor, callRouting = callSubagentRouting) {
  async function validateTarget(input: { agentId: string; workspaceId: string }, context: PluginHandlerContext) {
    const current = await context.paseo.agents.ref(input.agentId).refresh();
    if (!current || current.agent.id !== input.agentId || current.agent.workspaceId !== input.workspaceId || current.agent.provider !== "pi")
      throw new Error("Pi session changed. Refresh and try again.");
  }
  async function validateCurrent(input: { agentId: string; workspaceId: string }, context: PluginHandlerContext, descriptor: { sessionId: string; runtimeEpoch: string; serviceEpoch: string }) {
    await validateTarget(input, context);
    const current = await readDescriptor(input.agentId);
    if (!validateSubagentRoutingDescriptor(current, input.agentId) || current.sessionId !== descriptor.sessionId || current.runtimeEpoch !== descriptor.runtimeEpoch || current.serviceEpoch !== descriptor.serviceEpoch)
      throw new Error("Pi session changed. Refresh and try again.");
  }
  return {
    status: async (input: RpcInput<typeof subagentRoutingStatusRpc>, context: PluginHandlerContext) => {
      await validateTarget(input, context);
      const descriptor = await readDescriptor(input.agentId);
      const unavailable = { available: false, sessionId: null, runtimeEpoch: null, snapshot: null, providers: [] };
      if (!validateSubagentRoutingDescriptor(descriptor, input.agentId)) return unavailable;
      try {
        const snapshot = subagentRoutingSnapshotSchema.parse(await callRouting(descriptor, { operation: "snapshot", sessionId: descriptor.sessionId }));
        const providers = await callRouting(descriptor, { operation: "providers", sessionId: descriptor.sessionId });
        if (!Array.isArray(providers) || providers.length > 256 || providers.some(p => typeof p !== "string" || !p || p.length > 256))
          throw new Error("Invalid providers");
        if (snapshot.sessionId !== descriptor.sessionId || snapshot.serviceEpoch !== descriptor.serviceEpoch) throw new Error("Stale routing identity");
        await validateCurrent(input, context, descriptor);
        return { available: true, sessionId: descriptor.sessionId, runtimeEpoch: descriptor.runtimeEpoch, snapshot, providers: providers as string[] };
      } catch { return unavailable; }
    },
    set: async (input: RpcInput<typeof subagentRoutingSetRpc>, context: PluginHandlerContext) => {
      await validateTarget(input, context);
      const descriptor = await readDescriptor(input.agentId);
      if (!validateSubagentRoutingDescriptor(descriptor, input.agentId) || descriptor.sessionId !== input.request.expectedSessionId || descriptor.runtimeEpoch !== input.expectedRuntimeEpoch || descriptor.serviceEpoch !== input.request.expectedServiceEpoch)
        throw new Error("Pi session changed. Refresh and try again.");
      const snapshot = subagentRoutingSnapshotSchema.parse(await callRouting(descriptor, { operation: "set", request: input.request }));
      if (snapshot.sessionId !== descriptor.sessionId || snapshot.serviceEpoch !== descriptor.serviceEpoch) throw new Error("Stale routing identity");
      await validateCurrent(input, context, descriptor);
      return snapshot;
    },
  };
}
