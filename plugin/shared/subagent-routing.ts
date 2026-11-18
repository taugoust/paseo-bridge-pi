import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Mirrored from pi-agent-extensions/shared/subagent-routing.ts, protocol 1.
const identity = z.string().min(1).max(256);
export const subagentRoutingSelectionSchema = z.object({
  providerId: identity,
  accountId: identity.nullable(),
}).strict().refine(value => value.accountId === null || value.providerId === "openai-codex");
export const subagentRoutingSnapshotSchema = z.object({
  protocol: z.literal(1), sessionId: identity, serviceEpoch: identity,
  revision: z.number().int().nonnegative(), selection: subagentRoutingSelectionSchema.nullable(),
}).strict();
const target = { agentId: identity, workspaceId: identity };
export const subagentRoutingStatusRpc = defineRpc({
  name: "subagent_routing_status",
  input: z.object(target).strict(),
  output: z.object({
    available: z.boolean(), sessionId: identity.nullable(), runtimeEpoch: z.string().uuid().nullable(),
    snapshot: subagentRoutingSnapshotSchema.nullable(), providers: z.array(identity).max(256),
  }).strict(),
});
export const subagentRoutingSetRpc = defineRpc({
  name: "subagent_routing_set",
  input: z.object({
    ...target, expectedRuntimeEpoch: z.string().uuid(),
    request: z.object({
      expectedSessionId: identity, expectedServiceEpoch: identity,
      expectedRevision: z.number().int().nonnegative(), selection: subagentRoutingSelectionSchema.nullable(),
    }).strict(),
  }).strict(),
  output: subagentRoutingSnapshotSchema,
});
export type SubagentRoutingSnapshot = z.infer<typeof subagentRoutingSnapshotSchema>;
export type SubagentRoutingSelection = z.infer<typeof subagentRoutingSelectionSchema>;
