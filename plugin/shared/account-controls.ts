import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Mirrored from pi-agent-extensions/shared/account-controls.ts. Keep coordinated.
// Only the openai-codex provider has managed accounts; every request names it.
export const ACCOUNT_PROVIDER_ID = "openai-codex";
export const accountProviderSchema = z.literal(ACCOUNT_PROVIDER_ID);
export type AccountProviderId = z.infer<typeof accountProviderSchema>;
const account = z.object({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
  authKind: z.enum(["oauth", "api-key"]),
}).strict();
const usage = z.object({
  effectiveCredential: z.enum([
    "api-key-configured", "chatgpt-grant-configured", "chatgpt-grant-matched-refreshed",
    "unavailable", "unknown",
  ]),
  status: z.enum(["local-binding-confirmed", "unavailable", "unknown"]),
  remoteEntitlement: z.literal("not-queried"),
  accountKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  settingsUrl: z.enum([
    "https://platform.openai.com/settings/organization/usage",
    "https://chatgpt.com/settings/usage",
  ]).nullable(),
}).strict();
export const accountControlsSnapshotSchema = z.object({
  protocol: z.literal(1),
  serviceEpoch: z.string().min(1).max(256),
  selectionRevision: z.number().int().nonnegative(),
  sessionId: z.string().min(1).max(256),
  providerId: accountProviderSchema,
  pendingAccountNames: z.array(z.string().min(1).max(64)).max(20).optional(),
  accounts: z.array(account).max(100),
  currentAccountId: z.string().min(1).max(256).nullable(),
  defaultSelected: z.boolean(),
  activationStatus: z.enum(["active", "inactive", "activation-pending", "activation-failed"]),
  busy: z.boolean(),
  canSwitch: z.boolean(),
  inheritance: z.enum(["inherited", "explicit"]).optional(),
  usage,
}).strict();
const switchRequest = z.object({
  protocol: z.literal(1),
  requestId: z.string().uuid(),
  expectedSessionId: z.string().min(1).max(256),
  expectedServiceEpoch: z.string().min(1).max(256),
  expectedSelectionRevision: z.number().int().nonnegative(),
  providerId: accountProviderSchema,
  accountId: z.string().min(1).max(256).nullable(),
  inherit: z.boolean().optional(),
}).strict().refine(value => !value.inherit || value.accountId === null,
  { message: "Inheritance clear requires null accountId" });
const switchFailure = z.enum([
  "stale-session", "stale-service", "stale-selection", "busy", "unknown-account",
  "activation-failed", "request-id-conflict", "invalid-request",
]);
const switchResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true), requestId: z.string().uuid(), snapshot: accountControlsSnapshotSchema,
  }).strict(),
  z.object({
    ok: z.literal(false), requestId: z.string().uuid(), reason: switchFailure,
    snapshot: accountControlsSnapshotSchema,
  }).strict(),
]);
const target = { agentId: z.string().min(1).max(256), workspaceId: z.string().min(1).max(256) };
export const accountControlsStatusRpc = defineRpc({
  name: "account_controls_status",
  input: z.object({ ...target, providerId: accountProviderSchema }).strict(),
  output: z.object({
    available: z.boolean(),
    sessionId: z.string().nullable(),
    runtimeEpoch: z.string().uuid().nullable(),
    snapshot: accountControlsSnapshotSchema.nullable(),
    reason: z.string().max(500).nullable(),
  }).strict(),
});
export const accountControlsSwitchRpc = defineRpc({
  name: "account_controls_switch",
  input: z.object({
    ...target,
    expectedSessionId: z.string().min(1).max(256),
    expectedRuntimeEpoch: z.string().uuid(),
    request: switchRequest,
  }).strict(),
  output: switchResult,
});
export type AccountControlsSnapshot = z.infer<typeof accountControlsSnapshotSchema>;
export type AccountSwitchRequest = z.infer<typeof switchRequest>;
export type AccountSwitchResult = z.infer<typeof switchResult>;
