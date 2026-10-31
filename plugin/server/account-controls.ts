import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { accountControlsSnapshotSchema, accountControlsStatusRpc, accountControlsSwitchRpc, type AccountProviderId } from "../shared/account-controls";
import { callAccountControls, readAccountControlsDescriptor, validateAccountControlsDescriptor } from "./account-controls-transport";

// New execution-routing metadata is a private server/Pi contract. Do not add
// fields to snapshots consumed by existing clients' strict RPC validators.
function publicSnapshot(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return accountControlsSnapshotSchema.parse(value);
  const { sessionRouting: _routing, guardedDefaultSwitchVersion: _guardedSwitch, ...snapshot } = value as Record<string, unknown>;
  return accountControlsSnapshotSchema.parse(snapshot);
}

function providerOf(value: unknown): AccountProviderId {
  if (value === undefined || value === "openai") return "openai";
  if (value === "openai-codex") return value;
  throw new Error("Unsupported account provider.");
}
function checkProvider(snapshot: ReturnType<typeof accountControlsSnapshotSchema.parse>, providerId: AccountProviderId) {
  if ((snapshot.providerId ?? "openai") !== providerId ||
      (providerId === "openai-codex" && !snapshot.supportedProviders?.includes(providerId)))
    throw new Error("This Pi account service does not support the requested provider. Reload Pi before using Codex accounts.");
}

export function createAccountControlsHandlers(readDescriptor = readAccountControlsDescriptor, callControls = callAccountControls) {
  async function validateTarget(input: { agentId: string; workspaceId: string }, context: PluginHandlerContext) {
    const current = await context.paseo.agents.ref(input.agentId).refresh();
    if (!current || current.agent.id !== input.agentId || current.agent.workspaceId !== input.workspaceId || current.agent.provider !== "pi")
      throw new Error("Account-controls request does not match current Pi agent workspace.");
  }
  async function validateStillCurrent(input: { agentId: string; workspaceId: string }, context: PluginHandlerContext,
    descriptor: { sessionId: string; runtimeEpoch: string; serviceEpoch: string }) {
    await validateTarget(input, context);
    const current = await readDescriptor(input.agentId);
    if (!validateAccountControlsDescriptor(current, input.agentId) || current.sessionId !== descriptor.sessionId ||
        current.runtimeEpoch !== descriptor.runtimeEpoch || current.serviceEpoch !== descriptor.serviceEpoch)
      throw new Error("The active Pi or account-controls service changed during the request.");
  }
  async function invoke(input: { agentId: string; workspaceId: string; expectedSessionId: string; expectedRuntimeEpoch: string; request: Record<string, unknown> }, context: PluginHandlerContext) {
    const providerId = providerOf(input.request.providerId);
    await validateTarget(input, context);
    const descriptor = await readDescriptor(input.agentId);
    if (!validateAccountControlsDescriptor(descriptor, input.agentId) || descriptor.sessionId !== input.expectedSessionId || descriptor.runtimeEpoch !== input.expectedRuntimeEpoch)
      throw new Error("The active Pi session changed. Refresh before switching accounts.");
    // Older services may ignore providerId. Check capability BEFORE a Codex
    // mutation so they can never silently switch an identically named OpenAI profile.
    if (providerId === "openai-codex") {
      const preflight = publicSnapshot(await callControls(descriptor, { operation: "snapshot", sessionId: descriptor.sessionId, providerId }));
      checkProvider(preflight, providerId);
      if (preflight.sessionId !== descriptor.sessionId || preflight.serviceEpoch !== descriptor.serviceEpoch)
        throw new Error("Account-controls service identity mismatch.");
      await validateStillCurrent(input, context, descriptor);
    }
    const result: any = await callControls(descriptor, { operation: "switch", request: input.request });
    const parsed = { ...result, snapshot: publicSnapshot(result?.snapshot) };
    checkProvider(parsed.snapshot, providerId);
    if (parsed.requestId !== input.request.requestId || parsed.snapshot.sessionId !== descriptor.sessionId || parsed.snapshot.serviceEpoch !== descriptor.serviceEpoch)
      throw new Error("Account-controls service identity mismatch.");
    await validateStillCurrent(input, context, descriptor);
    return parsed;
  }
  return {
    status: async (input: RpcInput<typeof accountControlsStatusRpc>, context: PluginHandlerContext) => {
      const providerId = providerOf(input.providerId);
      await validateTarget(input, context);
      const descriptor = await readDescriptor(input.agentId);
      if (!validateAccountControlsDescriptor(descriptor, input.agentId)) return { available: false, sessionId: null, runtimeEpoch: null, snapshot: null, reason: "Account controls are unavailable for this Pi session." };
      try {
        const snapshot = publicSnapshot(await callControls(descriptor, { operation: "snapshot", sessionId: descriptor.sessionId, ...(providerId === "openai-codex" ? { providerId } : {}) }));
        checkProvider(snapshot, providerId);
        await validateStillCurrent(input, context, descriptor);
        if (snapshot.sessionId !== descriptor.sessionId || snapshot.serviceEpoch !== descriptor.serviceEpoch) throw new Error("Stale account-controls identity");
        return { available: true, sessionId: descriptor.sessionId, runtimeEpoch: descriptor.runtimeEpoch, snapshot, reason: null };
      } catch {
        return { available: false, sessionId: descriptor.sessionId, runtimeEpoch: descriptor.runtimeEpoch, snapshot: null,
          reason: providerId === "openai-codex" ? "Codex account controls are unavailable. Reload Pi if this session uses an older account service." : "OpenAI account controls are unavailable. Refresh to retry." };
      }
    },
    switch: (input: RpcInput<typeof accountControlsSwitchRpc>, context: PluginHandlerContext) => invoke(input, context),
  };
}
