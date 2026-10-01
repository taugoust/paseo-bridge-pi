import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Mirrored from pi-agent-extensions/shared/foreground-tasks.ts. Keep protocol changes coordinated.
const taskTarget = z.object({ taskId: z.string().min(1).max(256), childId: z.string().min(1).max(256), workerEpoch: z.string().min(1).max(256) }).strict();
const option = z.object({ value: z.string().max(2000), label: z.string().max(2000), description: z.string().max(4000).optional() }).strict();
const question = z.object({ id: z.string().min(1).max(256), label: z.string().max(500).optional(), prompt: z.string().max(8000), options: z.array(option).max(100), allowOther: z.boolean() }).strict();
const interactionInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("permission"), title: z.string().max(1000), options: z.array(z.string().max(2000)).max(100), detail: z.string().max(12000).optional() }).strict(),
  z.object({ kind: z.literal("questionnaire"), questions: z.array(question).max(100) }).strict(),
]);
const interactionAnswer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("permission"), cancelled: z.boolean(), value: z.string().max(2000).optional() }).strict(),
  z.object({ kind: z.literal("questionnaire"), cancelled: z.boolean(), answers: z.array(z.object({ id: z.string().min(1).max(256), value: z.string().max(2000), wasCustom: z.boolean() }).strict()).max(100) }).strict(),
]);
const task = z.object({
  taskId: z.string().min(1).max(256), childId: z.string().min(1).max(256), workerEpoch: z.string().max(256), groupId: z.string().min(1).max(256),
  attempt: z.number().int().min(1), title: z.string().max(1000), model: z.string().max(512).optional(), status: z.enum(["pending", "running", "waiting-input", "waiting-permission", "completed", "failed", "cancelled", "lost", "reaped"]),
  createdAt: z.string().max(100), updatedAt: z.string().max(100), pendingInteractions: z.number().int().min(0).max(1000), canPrompt: z.boolean(), canStop: z.boolean(),
}).strict();
const interaction = z.object({ id: z.string().min(1).max(256), workerEpoch: z.string().min(1).max(256), createdAt: z.string().max(100), request: interactionInput }).strict();
const message = z.object({ id: z.string().min(1).max(256), role: z.enum(["parent", "user", "assistant", "tool", "system"]), text: z.string().max(48 * 1024), timestamp: z.string().max(100), toolName: z.string().max(500).optional(), truncated: z.boolean().optional() }).strict();
const view = z.object({ task, messages: z.array(message).max(500), interactions: z.array(interaction).max(100), nextCursor: z.string().max(1024).optional(), liveText: z.string().max(48 * 1024).optional(), truncated: z.boolean() }).strict();
const requestId = z.string().uuid();
const command = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list") }).strict(),
  z.object({ operation: z.literal("view"), target: taskTarget, cursor: z.string().max(1024).optional() }).strict(),
  z.object({ operation: z.literal("prompt"), target: taskTarget, requestId, message: z.string().min(1).max(16000) }).strict(),
  z.object({ operation: z.literal("respond"), target: taskTarget, requestId, interactionId: z.string().min(1).max(256), answer: interactionAnswer }).strict(),
  z.object({ operation: z.literal("stop"), target: taskTarget, requestId }).strict(),
]);
export const foregroundTaskResponseSchema = z.object({ protocol: z.literal(1), sessionId: z.string().min(1).max(256), epoch: z.string().min(1).max(256), state: z.enum(["available", "unavailable", "unsupported"]), tasks: z.array(task).max(100).optional(), view: view.optional(), accepted: z.boolean().optional(), message: z.string().max(4000).optional() }).strict();
const response = foregroundTaskResponseSchema;
const identityInput = { agentId: z.string().min(1).max(256), workspaceId: z.string().min(1).max(256) };
const rpcInput = z.object({
  agentId: z.string().min(1).max(256), workspaceId: z.string().min(1).max(256),
  expectedSessionId: z.string().min(1).max(256), expectedRuntimeEpoch: z.string().uuid(),
  request: command,
}).strict();
export const foregroundTasksStatusRpc = defineRpc({ name: "foreground_tasks_status", input: z.object(identityInput).strict(), output: z.object({ available: z.boolean(), sessionId: z.string().nullable(), runtimeEpoch: z.string().uuid().nullable(), tasks: z.array(task).max(100).optional(), reason: z.string().max(1000).nullable() }).strict() });
export const foregroundTasksRpc = defineRpc({ name: "foreground_tasks_control", input: rpcInput, output: response });

export type ForegroundTaskTarget = z.infer<typeof taskTarget>;
export type ForegroundTask = z.infer<typeof task>;
export type ForegroundTaskInteraction = z.infer<typeof interaction>;
export type ForegroundTaskInteractionAnswer = z.infer<typeof interactionAnswer>;
export type ForegroundTaskView = z.infer<typeof view>;
export type ForegroundTaskCommand = z.infer<typeof command>;
export type ForegroundTaskResponse = z.infer<typeof response>;
