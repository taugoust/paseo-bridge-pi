import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  ACCOUNT_PROVIDER_ID,
  accountControlsSnapshotSchema,
  accountControlsStatusRpc,
  accountControlsSwitchRpc,
} from "../shared/account-controls";
import {
  callAccountControls,
  readAccountControlsDescriptor,
  validateAccountControlsDescriptor,
} from "./account-controls-transport";

/** Account controls manage only openai-codex; anything else is rejected before transport. */
function requireCodex(value: unknown) {
  if (value !== ACCOUNT_PROVIDER_ID) throw new Error("Unsupported account provider.");
}

export function createAccountControlsHandlers(
  readDescriptor = readAccountControlsDescriptor,
  callControls = callAccountControls,
) {
  async function validateTarget(
    input: { agentId: string; workspaceId: string },
    context: PluginHandlerContext,
  ) {
    const current = await context.paseo.agents.ref(input.agentId).refresh();
    if (!current || current.agent.id !== input.agentId ||
        current.agent.workspaceId !== input.workspaceId || current.agent.provider !== "pi")
      throw new Error("Account-controls request does not match current Pi agent workspace.");
  }
  async function validateStillCurrent(
    input: { agentId: string; workspaceId: string },
    context: PluginHandlerContext,
    descriptor: { sessionId: string; runtimeEpoch: string; serviceEpoch: string },
  ) {
    await validateTarget(input, context);
    const current = await readDescriptor(input.agentId);
    if (!validateAccountControlsDescriptor(current, input.agentId) ||
        current.sessionId !== descriptor.sessionId ||
        current.runtimeEpoch !== descriptor.runtimeEpoch ||
        current.serviceEpoch !== descriptor.serviceEpoch)
      throw new Error("The active Pi or account-controls service changed during the request.");
  }
  async function invoke(
    input: {
      agentId: string; workspaceId: string; expectedSessionId: string;
      expectedRuntimeEpoch: string; request: Record<string, unknown>;
    },
    context: PluginHandlerContext,
  ) {
    requireCodex(input.request.providerId);
    await validateTarget(input, context);
    const descriptor = await readDescriptor(input.agentId);
    if (!validateAccountControlsDescriptor(descriptor, input.agentId) ||
        descriptor.sessionId !== input.expectedSessionId ||
        descriptor.runtimeEpoch !== input.expectedRuntimeEpoch)
      throw new Error("The active Pi session changed. Refresh before switching accounts.");
    const result: any = await callControls(descriptor, { operation: "switch", request: input.request });
    const parsed = { ...result, snapshot: accountControlsSnapshotSchema.parse(result?.snapshot) };
    if (parsed.requestId !== input.request.requestId ||
        parsed.snapshot.sessionId !== descriptor.sessionId ||
        parsed.snapshot.serviceEpoch !== descriptor.serviceEpoch)
      throw new Error("Account-controls service identity mismatch.");
    await validateStillCurrent(input, context, descriptor);
    return parsed;
  }
  return {
    status: async (
      input: RpcInput<typeof accountControlsStatusRpc>,
      context: PluginHandlerContext,
    ) => {
      requireCodex(input.providerId);
      await validateTarget(input, context);
      const descriptor = await readDescriptor(input.agentId);
      if (!validateAccountControlsDescriptor(descriptor, input.agentId))
        return {
          available: false, sessionId: null, runtimeEpoch: null, snapshot: null,
          reason: "Account controls are unavailable for this Pi session.",
        };
      try {
        const snapshot = accountControlsSnapshotSchema.parse(await callControls(descriptor, {
          operation: "snapshot", sessionId: descriptor.sessionId, providerId: ACCOUNT_PROVIDER_ID,
        }));
        await validateStillCurrent(input, context, descriptor);
        if (snapshot.sessionId !== descriptor.sessionId ||
            snapshot.serviceEpoch !== descriptor.serviceEpoch)
          throw new Error("Stale account-controls identity");
        return {
          available: true, sessionId: descriptor.sessionId,
          runtimeEpoch: descriptor.runtimeEpoch, snapshot, reason: null,
        };
      } catch {
        return {
          available: false, sessionId: descriptor.sessionId,
          runtimeEpoch: descriptor.runtimeEpoch, snapshot: null,
          reason: "Codex account controls are unavailable. Refresh to retry.",
        };
      }
    },
    switch: (input: RpcInput<typeof accountControlsSwitchRpc>, context: PluginHandlerContext) =>
      invoke(input, context),
  };
}
