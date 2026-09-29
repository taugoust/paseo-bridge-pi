import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
export { validateDescriptor, validateWireResponse } from "./wire";
export type { PermissionGateDescriptor, PermissionGateWireResponse } from "./wire";

export const permissionGateStatusRpc = defineRpc({
  name: "permission_gate_status",
  input: z.object({ agentId: z.string().min(1), workspaceId: z.string().min(1) }),
  output: z.object({
    available: z.boolean(),
    enabled: z.boolean().nullable(),
    sessionId: z.string().nullable(),
    runtimeEpoch: z.string().nullable(),
    reason: z.string().nullable(),
  }),
});

export const permissionGateSetRpc = defineRpc({
  name: "permission_gate_set",
  input: z.object({ agentId: z.string().min(1), workspaceId: z.string().min(1), expectedSessionId: z.string().min(1), expectedRuntimeEpoch: z.string().min(1), enabled: z.boolean() }),
  output: z.object({ enabled: z.boolean() }),
});

export type PermissionGateStatus = {
  available: boolean;
  enabled: boolean | null;
  reason: string | null;
};

