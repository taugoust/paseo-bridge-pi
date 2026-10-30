import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
	readAccountControlsDescriptor,
	validateAccountControlsDescriptor,
	type AccountControlsDescriptor,
} from "./account-controls-transport";
import { callBtw } from "./btw-transport";
import { attachWorktreeDiffStats } from "./worktree-diff-stats";
import { listWorktreeWorkspaces } from "./worktree-workspaces";
import { workflowUiPayload } from "./workflow-ui-payload";
import {
	workflowSnapshotSchema,
	workflowsStatusRpc,
	workflowsControlRpc,
  workflowsReviewRpc,
  goalReviewPreviewSchema,
	type WorkflowSnapshot,
} from "../shared/workflows";
export const readWorkflowsDescriptor = (agentId: string) =>
	readAccountControlsDescriptor(
		agentId,
		join(homedir(), ".pi", "paseo-bridge", "workflows"),
	);
export const callWorkflows = (
	descriptor: AccountControlsDescriptor,
	request: Record<string, unknown>,
) => callBtw(descriptor, request, 5000, "workflows");
const responseSchema = workflowSnapshotSchema.extend({
	openPath: z.string().max(4096).optional(),
});

/** Surface the previous clear notice as a history item from older Pi runtimes. */
function archiveLegacyClearedGoal(
	snapshot: WorkflowSnapshot,
	agentId: string,
): WorkflowSnapshot {
	const prefix = "Goal cleared: ";
	if (!snapshot.notice?.startsWith(prefix)) return snapshot;
	const text = snapshot.notice.slice(prefix.length).trim().slice(0, 4000);
	if (!text) return { ...snapshot, notice: null };
	const completedGoals = [...(snapshot.completedGoals ?? [])];
	if (
		!completedGoals.some(
			(goal) => goal.status === "cleared" && goal.text === text,
		)
	)
		completedGoals.push({
			id: `legacy-clear-${createHash("sha256").update(agentId).update(text).digest("hex").slice(0, 32)}`,
			text,
			status: "cleared",
			endedAt: 0,
			summary: null,
			tasks: [],
		});
	return { ...snapshot, notice: null, completedGoals: completedGoals.slice(-50) };
}
export function createWorkflowsHandlers(
	read = readWorkflowsDescriptor,
	call = callWorkflows,
) {
	async function target(
		input: { agentId: string; workspaceId: string },
		context: PluginHandlerContext,
	) {
		const current = await context.paseo.agents.ref(input.agentId).refresh();
		if (
			!current ||
			current.agent.id !== input.agentId ||
			current.agent.workspaceId !== input.workspaceId ||
			current.agent.provider !== "pi" ||
			current.agent.archivedAt
		)
			throw new Error("Workflow target no longer matches this Pi workspace");
	}
	async function recheck(
		input: { agentId: string; workspaceId: string },
		context: PluginHandlerContext,
		descriptor: AccountControlsDescriptor,
	) {
		await target(input, context);
		const now = await read(input.agentId);
		if (
			!validateAccountControlsDescriptor(now, input.agentId) ||
			["sessionId", "runtimeEpoch", "serviceEpoch", "capability"].some(
				(key) =>
					now[key as keyof AccountControlsDescriptor] !==
					descriptor[key as keyof AccountControlsDescriptor],
			)
		)
			throw new Error("Workflow session changed; refresh");
	}
	return {
    review: async (input: RpcInput<typeof workflowsReviewRpc>, context: PluginHandlerContext) => {
      await target(input, context);
      const d = await read(input.agentId);
      if (!validateAccountControlsDescriptor(d, input.agentId) || d.runtimeEpoch !== input.expectedRuntimeEpoch || d.sessionId !== input.sessionId || d.serviceEpoch !== input.serviceEpoch) throw new Error("Goal review session changed; refresh");
      const result = await call(d, { operation: "review", sessionId: input.sessionId, serviceEpoch: input.serviceEpoch, expectedGoalId: input.expectedGoalId, expectedEntryRevision: input.expectedEntryRevision, referenceId: input.referenceId }) as { sessionId?: string; serviceEpoch?: string; preview?: unknown };
      await recheck(input, context, d);
      if (result.sessionId !== d.sessionId || result.serviceEpoch !== d.serviceEpoch) throw new Error("Goal review identity changed");
      return goalReviewPreviewSchema.parse(result.preview);
    },
		status: async (
			input: RpcInput<typeof workflowsStatusRpc>,
			context: PluginHandlerContext,
		) => {
			await target(input, context);
			const d = await read(input.agentId);
			if (!validateAccountControlsDescriptor(d, input.agentId))
				return {
					available: false,
					sessionId: null,
					runtimeEpoch: null,
					snapshot: null,
				};
			let snapshot = archiveLegacyClearedGoal(
				workflowSnapshotSchema.parse(
					workflowUiPayload(await call(d, {
						operation: "snapshot",
						sessionId: d.sessionId,
						serviceEpoch: d.serviceEpoch,
					})),
				),
				input.agentId,
			);
			if (snapshot.worktrees.length) snapshot = await attachWorktreeDiffStats(snapshot, input.workspaceId, context);
			await recheck(input, context, d);
			if (
				snapshot.sessionId !== d.sessionId ||
				snapshot.serviceEpoch !== d.serviceEpoch
			)
				throw new Error("Workflow identity mismatch");
			return {
				available: true,
				sessionId: d.sessionId,
				runtimeEpoch: d.runtimeEpoch,
				snapshot,
			};
		},
		control: async (
			input: RpcInput<typeof workflowsControlRpc>,
			context: PluginHandlerContext,
		) => {
			await target(input, context);
			const d = await read(input.agentId);
			if (
				!validateAccountControlsDescriptor(d, input.agentId) ||
				d.runtimeEpoch !== input.expectedRuntimeEpoch ||
				d.sessionId !== input.request.sessionId ||
				d.serviceEpoch !== input.request.serviceEpoch
			)
				throw new Error("Workflow target changed; no request sent");
			if (input.request.operation === "send" && input.request.value === true) {
				const state = workflowSnapshotSchema.parse(
					workflowUiPayload(await call(d, {
						operation: "snapshot",
						sessionId: d.sessionId,
						serviceEpoch: d.serviceEpoch,
					})),
				);
				if (
					state.sessionId !== d.sessionId ||
					state.serviceEpoch !== d.serviceEpoch
				)
					throw new Error("Workflow identity mismatch");
				if (state.operationAction === "worktree.remove") {
					if (
						state.dialog?.id !== input.request.dialogId ||
						state.operationId !== input.request.operationId ||
						state.protectedPaths.length !== 1
					)
						throw new Error("Worktree confirmation changed");
					const selectedPath = await realpath(state.protectedPaths[0]);
					let cursor: string | undefined;
					for (let page = 0; ; page++) {
						if (page >= 25)
							throw new Error("Cannot verify all open agents; removal refused");
						const agents = await context.paseo.agents.list({
							scope: "active",
							page: { limit: 200, ...(cursor ? { cursor } : {}) },
						});
						for (const { agent } of agents.entries) {
							if (agent.id === input.agentId || agent.archivedAt) continue;
							const cwd = await realpath(agent.cwd).catch(() =>
								resolve(agent.cwd),
							);
							if (cwd === selectedPath || cwd.startsWith(selectedPath + sep))
								throw new Error(
									"An open Paseo agent uses this worktree. Close or archive it before removal.",
								);
						}
						if (typeof agents.pageInfo?.hasMore !== "boolean")
							throw new Error("Incomplete agent inventory; removal refused");
						if (!agents.pageInfo.hasMore) break;
						if (
							!agents.pageInfo.nextCursor ||
							agents.pageInfo.nextCursor === cursor
						)
							throw new Error("Incomplete agent inventory; removal refused");
						cursor = agents.pageInfo.nextCursor;
					}
					await recheck(input, context, d);
				}
			}
			const result = responseSchema.parse(workflowUiPayload(await call(d, input.request)));
			await recheck(input, context, d);
			if (
				result.sessionId !== d.sessionId ||
				result.serviceEpoch !== d.serviceEpoch
			)
				throw new Error("Workflow identity mismatch");
			let openedWorkspaceId: string | null = null;
			if (
				result.openPath &&
				input.request.operation === "start" &&
				input.request.action === "worktree.open"
			) {
				if (result.openPath !== input.request.path)
					throw new Error("Worktree path changed; refresh before opening");
				const parent = await context.paseo.workspaces
					.ref(input.workspaceId)
					.refresh();
				if (!parent) throw new Error("Parent workspace is unavailable");
				await recheck(input, context, d);
				// Prefer the worker's existing workspace instead of allocating a new
				// tmux window on every click. Cwd is used only to find an explicit ID.
				const target = await realpath(result.openPath);
				let cursor: string | undefined;
				for (let page = 0; ; page++) {
					if (page >= 100) throw new Error("Workspace inventory is incomplete");
					const listed = await listWorktreeWorkspaces(context, parent.projectId, cursor);
					for (const workspace of listed.entries) {
						if (workspace.projectId === parent.projectId && workspace.workspaceDirectory && await realpath(workspace.workspaceDirectory).catch(() => null) === target) { openedWorkspaceId = workspace.id; break; }
					}
					if (openedWorkspaceId || listed.pageInfo?.hasMore === false) break;
					if (!listed.pageInfo?.nextCursor || listed.pageInfo.nextCursor === cursor) throw new Error("Workspace inventory is incomplete");
					cursor = listed.pageInfo.nextCursor;
				}
				await recheck(input, context, d);
				if (!openedWorkspaceId) {
				const workspace = await context.paseo.workspaces.create({
					source: {
						kind: "directory",
						path: result.openPath,
						projectId: parent.projectId,
					},
					title: "Worktree",
					idempotencyKey: `pi-worktree:${input.agentId}:${d.serviceEpoch}:${input.request.requestId}`,
					requestId: input.request.requestId,
				});
				openedWorkspaceId = workspace.id;
				}
				await recheck(input, context, d);
			}
			const { openPath: _path, ...snapshot } = result;
			return { snapshot, openedWorkspaceId };
		},
	};
}
