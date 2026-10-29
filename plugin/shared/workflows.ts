import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { questionnaireInputSchema, questionnaireAnswerSchema } from "./foreground-tasks";
const id = z.string().min(1).max(256);
const continuationLimitsSchema = z.object({
  automaticTurns: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  noProgressTurns: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
}).strict();
export const goalQuestionSchema = z.object({
  id: z.string().min(1).max(128), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), at: z.number().int().nonnegative().max(8640000000000000),
  workerEpoch: z.string().min(1).max(128), status: z.enum(["pending", "answered", "cancelled"]),
  request: questionnaireInputSchema, answer: questionnaireAnswerSchema.optional(), answeredAt: z.number().int().nonnegative().max(8640000000000000).optional(),
}).strict();
// Optional for legacy runtimes; only durable producer records belong here.
export const goalStorySchema = z.object({
  version: z.literal(1),
  timeline: z.array(z.object({ id: z.string().min(1).max(128), at: z.number().int().nonnegative().max(8640000000000000),
    kind: z.enum(["created", "started", "paused", "resumed", "blocked", "completed", "cleared", "edited", "task"]),
    text: z.string().min(1).max(4000), taskId: z.string().min(1).max(128).optional(), taskStatus: z.enum(["pending", "in_progress", "completed", "blocked"]).optional() }).strict()).max(200),
  activity: z.array(z.object({ id: z.string().min(1).max(128), at: z.number().int().nonnegative().max(8640000000000000), text: z.string().min(1).max(4000) }).strict()).max(200),
  questions: z.array(goalQuestionSchema).max(100).optional(),
}).strict();
export const delegatedGoalEntrySchema = z.object({
  story: goalStorySchema.optional(),
  policyRevision: z.number().int().positive().optional(),
	id: z.string().uuid(), revision: z.number().int().positive(), text: z.string().min(1).max(4000),
	status: z.enum(["paused", "active", "blocked", "usage_limited", "budget_limited", "complete", "cleared"]),
	tasks: z.array(z.object({ id: z.string().max(128), text: z.string().max(503), status: z.enum(["pending", "in_progress", "completed", "blocked"]) }).strict()).max(50),
	child: z.object({ taskId: z.string().max(128), childId: z.string().max(128), jobId: z.string().max(128), attempt: z.number().int().positive() }).strict().nullable(),
	tokenBudget: z.number().int().positive().max(1_000_000).nullable(), tokensUsed: z.number().nonnegative(),
	continuationLimits: continuationLimitsSchema.optional(),
	automaticTurns: z.number().int().nonnegative(), noProgressTurns: z.number().int().nonnegative(),
	summary: z.string().max(6000).nullable(), waiting: z.string().max(1000).nullable(),
}).strict();
export const workflowSnapshotSchema = z
	.object({
		protocol: z.literal(1),
		capabilities: z
			.object({ createPausedGoal: z.boolean().optional(), delegatedGoals: z.boolean().optional(), delegatedGoalExecution: z.boolean().optional(), goalLimitEditing: z.boolean().optional() }).strict()
			.optional(),
		delegatedGoals: z.object({ version: z.literal(1), revision: z.number().int().nonnegative(), entries: z.array(delegatedGoalEntrySchema).max(1000) }).strict().optional(),
		sessionId: id,
		serviceEpoch: z.string().uuid(),
		cwd: z.string().max(4096),
		model: z.string().max(512).nullable(),
		busy: z.boolean(),
		idle: z.boolean(),
		notice: z.string().max(6000).nullable(),
		operationId: z.string().uuid().nullable(),
		operationAction: z.string().max(64).nullable(),
		protectedPaths: z.array(z.string().max(4096)).max(100),
		dialog: z
			.object({
				id: z.string().uuid(),
				operationId: z.string().uuid(),
				kind: z.enum(["input", "select", "confirm"]),
				title: z.string().max(48000),
				message: z.string().max(48000),
				options: z.array(z.string().max(48000)).max(200),
			})
			.strict()
			.nullable(),
		worktrees: z
			.array(
				z
					.object({
						path: z.string().max(4096),
						createdInSession: z.boolean().optional(),
						repositoryPath: z.string().max(4096).optional(),
						repositoryLabel: z.string().max(4096).optional(),
						branch: z.string().max(4096).nullable(),
						head: z.string().max(64).nullable(),
						main: z.boolean(),
						current: z.boolean(),
						locked: z.boolean(),
						stale: z.boolean(),
						detached: z.boolean(),
						changedFiles: z.number().int().min(0).nullable().optional(),
						// Native server comparison statistics, not a changed-file count.
						diffStat: z.object({ additions: z.number().int().min(0), deletions: z.number().int().min(0) }).strict().nullable().optional(),
						// A physically verified recorded owner, not exhaustive agent membership.
						recordedOwner: z.object({
							ownerSessionId: z.string().min(1).max(256),
							taskId: z.string().regex(/^subagent-task-[a-f0-9]{24}$/),
							childId: z.string().regex(/^subagent-child-[a-f0-9]{24}$/),
							canonicalDisplayName: z.string().max(80).optional(),
						}).strict().optional(),
						ownerTaskId: z.string().max(128).optional(),
						ownerTitle: z.string().max(500).optional(),
						workerStatus: z.string().max(40).optional(),
						inUse: z.boolean().optional(),
						includedChanges: z.boolean().optional(),
						setupError: z.string().max(2000).optional(),
					})
					.strict(),
			)
			.max(100),
		worktreeError: z.string().max(2000).nullable(),
		worktreeLoading: z.boolean(),
		worktreeRepositoryCount: z.number().int().min(0).optional(),
		worktreeContainer: z.boolean().optional(),
		goal: z
			.object({
				id,
				activationId: id.optional(),
				revision: z.number().int().nonnegative().optional(),
				policyRevision: z.number().int().positive().optional(),
				continuationLimits: continuationLimitsSchema.optional(),
				effectiveLimits: continuationLimitsSchema.optional(),
				text: z.string().max(4000),
				tasks: z
					.array(
						z
							.object({
								id: z.string().max(128).optional(),
								text: z.string().max(4000),
								status: z.enum([
									"pending",
									"in_progress",
									"completed",
									"blocked",
								]),
							})
							.strict(),
					)
					.max(50)
					.optional(),
				status: z.enum([
					"active",
					"paused",
					"blocked",
					"usage_limited",
					"budget_limited",
					"complete",
				]),
				waiting: z.string().max(1000).nullable(),
        waitDeadline: z.number().nonnegative().nullable().optional(),
        lastTaskUpdateAt: z.number().nonnegative().nullable().optional(),
        lastWake: z.object({ at: z.number().nonnegative(), reason: z.enum(["deadline", "custom_message", "user_input", "explicit_resume"]), customType: z.string().max(128).optional() }).strict().nullable().optional(),
        lastBlocker: z.object({ at: z.number().nonnegative(), reason: z.string().max(1000), evidence: z.string().max(4000), repeatedTurns: z.number().int().nonnegative() }).strict().nullable().optional(),
				iteration: z.number().nonnegative(),
				tokensUsed: z.number().nonnegative(),
				tokenBudget: z.number().positive().nullable(),
				automaticTurns: z.number().nonnegative(),
				noProgressTurns: z.number().nonnegative(),
				safetyPauseCause: z.string().max(100).nullable(),
				summary: z.string().max(6000).nullable(),
			})
			.strict()
			.nullable(),
		lastCompletion: z
			.object({
				id,
				text: z.string().max(4000),
				summary: z.string().max(4000).nullable(),
			})
			.strict()
			.nullable(),
		completedGoals: z
			.array(
				z
					.object({
						id,
						text: z.string().max(4000),
						status: z.enum(["completed", "cleared"]),
						endedAt: z.number().nonnegative(),
						summary: z.string().max(4000).nullable(),
						tasks: z
							.array(
								z
									.object({
										id: z.string().max(128).optional(),
										text: z.string().max(503),
										status: z.enum([
											"pending",
											"in_progress",
											"completed",
											"blocked",
										]),
									})
									.strict(),
							)
							.max(50),
					})
					.strict(),
			)
			.max(50)
			.optional(),
		limits: z
			.object({
				automaticTurns: z.number().positive().nullable(),
				noProgressTurns: z.number().positive().nullable(),
			})
			.strict(),
	})
	.strict();
const base = {
	sessionId: id,
	serviceEpoch: z.string().uuid(),
	requestId: z.string().uuid(),
};
export const workflowRequestSchema = z.discriminatedUnion("operation", [
	z
		.object({
			...base,
			operation: z.literal("start"),
			action: z.enum([
				"goals.create", "goals.start", "goals.pause", "goals.resume", "goals.edit", "goals.limits", "goals.clear", "goals.add_task", "goals.answer",
				"worktree.add",
				"worktree.remove",
				"worktree.prune",
				"worktree.open",
				"goal.start",
				"goal.create_paused",
				"goal.edit",
				"goal.limits",
				"goal.pause",
				"goal.resume",
				"goal.clear",
				"goal.add_task",
			]),
			expectedGoalId: id.nullable(),
			expectedEntryRevision: z.number().int().positive().optional(),
			expectedPolicyRevision: z.number().int().positive().optional(),
			expectedActivationId: id.optional(),
			expectedGoalRevision: z.number().int().nonnegative().optional(),
      questionId: z.string().min(1).max(128).optional(),
      questionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
      workerEpoch: z.string().min(1).max(128).optional(),
      answer: questionnaireAnswerSchema.optional(),
			expectedRegistryRevision: z.number().int().nonnegative().optional(),
			text: z.string().max(503).optional(),
			objective: z.string().max(4000).optional(),
			tokenBudget: z.number().int().positive().max(1_000_000).nullable().optional(),
			continuationLimits: continuationLimitsSchema.optional(),
			path: z.string().max(4096).optional(),
		})
		.strict(),
	z
		.object({
			...base,
			operation: z.literal("send"),
			operationId: z.string().uuid(),
			dialogId: z.string().uuid(),
			value: z.union([z.string().max(8000), z.boolean(), z.null()]),
		})
		.strict(),
	z
		.object({
			...base,
			operation: z.literal("cancel"),
			operationId: z.string().uuid(),
		})
		.strict(),
]).superRefine((request, context) => {
	if (request.operation !== "start") return;
	if (request.tokenBudget === null && !["goals.edit", "goals.limits", "goal.limits"].includes(request.action)) context.addIssue({ code: "custom", path: ["tokenBudget"], message: "Only delegated goal edits accept null to remove a cap" });
  const questionFields = [request.questionId, request.questionRevision, request.workerEpoch, request.answer];
  if (request.action === "goals.answer" ? questionFields.some(value => value === undefined) : questionFields.some(value => value !== undefined))
    context.addIssue({ code: "custom", path: ["answer"], message: "Question answers require exact request identity and the goals.answer action" });
	if (["goal.limits", "goals.limits"].includes(request.action)) {
		if (request.expectedGoalId === null || request.tokenBudget === undefined || request.continuationLimits === undefined || request.objective !== undefined || request.text !== undefined)
			context.addIssue({ code: "custom", message: "Limit edits require identity and explicit limits, without objective or checklist edits" });
	}
	if (["goal.limits", "goals.limits"].includes(request.action) ? request.expectedPolicyRevision === undefined || request.expectedEntryRevision !== undefined || request.expectedRegistryRevision !== undefined : request.expectedPolicyRevision !== undefined)
		context.addIssue({ code: "custom", path: ["expectedPolicyRevision"], message: "Limit edits require an exact policy revision" });
  if (request.action.startsWith("goal.") && request.expectedGoalId !== null) {
    if (request.expectedActivationId === undefined || (request.action !== "goal.limits" && request.expectedGoalRevision === undefined))
      context.addIssue({ code: "custom", message: "Assigned mutations require activation and applicable goal revision" });
  } else if (request.expectedActivationId !== undefined || request.expectedGoalRevision !== undefined) {
    context.addIssue({ code: "custom", message: "Activation fields belong to assigned goal mutations" });
  }
  if (request.action === "goals.limits") return;
	if (!request.action.startsWith("goals.")) return;
	if (request.action === "goals.create") {
		if (request.expectedGoalId !== null || request.expectedEntryRevision !== undefined) context.addIssue({ code: "custom", path: ["expectedGoalId"], message: "Create requires null goal identity" });
	} else if (request.expectedGoalId === null || request.expectedEntryRevision === undefined || request.expectedRegistryRevision !== undefined) {
		context.addIssue({ code: "custom", path: ["expectedEntryRevision"], message: "Existing delegated goals require identity and entry revision" });
	}
});
const target = { agentId: id, workspaceId: id };
export const workflowsStatusRpc = defineRpc({
	name: "workflows_status",
	input: z.object(target).strict(),
	output: z
		.object({
			available: z.boolean(),
			sessionId: id.nullable(),
			runtimeEpoch: z.string().uuid().nullable(),
			snapshot: workflowSnapshotSchema.nullable(),
		})
		.strict(),
});
export const workflowsControlRpc = defineRpc({
	name: "workflows_control",
	input: z
		.object({
			...target,
			expectedRuntimeEpoch: z.string().uuid(),
			request: workflowRequestSchema,
		})
		.strict(),
	output: z
		.object({
			snapshot: workflowSnapshotSchema,
			openedWorkspaceId: id.nullable(),
		})
		.strict(),
});
export type WorkflowSnapshot = z.infer<typeof workflowSnapshotSchema>;
export type WorkflowRequest = z.infer<typeof workflowRequestSchema>;
