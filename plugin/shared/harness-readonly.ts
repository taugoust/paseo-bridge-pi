import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const target = { agentId: z.string().min(1).max(256), workspaceId: z.string().min(1).max(256) };
const base = { ...target, expectedSessionId: z.string().min(1).max(256), expectedRuntimeEpoch: z.string().uuid() };
const page = { ...base, limit: z.number().int().min(1).max(50).optional(), cursor: z.string().max(1024).optional() };
const common = {
  protocol: z.literal(1), state: z.enum(["available", "unavailable", "unsupported"]),
  sessionId: z.string().min(1).max(256), lastUpdated: z.string().nullable(), stale: z.boolean(), message: z.string().max(4000).optional(),
};
const job = z.object({
  jobId: z.string().regex(/^job-[a-f0-9]{24}$/), status: z.string().max(40), name: z.string().max(500).optional(),
  createdAt: z.string(), updatedAt: z.string().nullable(), observationOnly: z.boolean(),
});
const taskIdentity = {
  taskId: z.string().regex(/^subagent-task-[a-f0-9]{24}$/), childId: z.string().max(256), groupId: z.string().max(256),
  runtimeId: z.string().max(256).nullable(), attempt: z.number().int().min(1), lastUpdated: z.string().nullable(), stale: z.boolean(),
  paseoAgentId: z.string().max(256).optional(), paseoWorkspaceId: z.string().max(256).optional(),
};
const task = z.object({ ...taskIdentity, status: z.string().max(40), title: z.string().max(500), summary: z.string().max(4000).optional() });
export const harnessStatusRpc = defineRpc({ name: "harness_status", input: z.object(target), output: z.object({
  available: z.boolean(), sessionId: z.string().nullable(), runtimeEpoch: z.string().uuid().nullable(), reason: z.string().nullable(),
}) });
export const harnessJobsListRpc = defineRpc({ name: "harness_jobs_list", input: z.object(page), output: z.object({
  ...common, items: z.array(job).max(50), nextCursor: z.string().max(1024).optional(),
}) });
export const harnessJobsOutputRpc = defineRpc({ name: "harness_jobs_output", input: z.object({
  ...base, jobId: z.string().regex(/^job-[a-f0-9]{24}$/), maxBytes: z.number().int().min(1).max(48 * 1024).optional(),
}), output: z.object({ ...common, item: z.object({
  jobId: z.string(), text: z.string().max(48 * 1024), truncated: z.boolean(), source: z.enum(["log", "pane", "none"]),
  lastUpdated: z.string().nullable(), stale: z.boolean(),
}).optional() }) });
export const harnessSubagentsListRpc = defineRpc({ name: "harness_subagents_list", input: z.object(page), output: z.object({
  ...common, items: z.array(task).max(50), nextCursor: z.string().max(1024).optional(),
}) });
export const harnessSubagentReportRpc = defineRpc({ name: "harness_subagent_report", input: z.object({
  ...base, taskId: z.string().regex(/^subagent-task-[a-f0-9]{24}$/), maxBytes: z.number().int().min(1).max(48 * 1024).optional(),
}), output: z.object({ ...common, item: z.object({ ...taskIdentity, text: z.string().max(48 * 1024), truncated: z.boolean() }).optional() }) });
