import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, symlink, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const require = createRequire(import.meta.url),
	root = fileURLToPath(new URL("../", import.meta.url));
test("worktree removal rechecks open Paseo agents including symlinked subdirectories and fails closed on incomplete inventory", {
	skip: !process.env.PASEO_PLUGIN_COMPILER,
}, async () => {
	const dir = await mkdtemp(join(tmpdir(), "worktree-guard-")),
		tree = join(dir, "tree"),
		alias = join(dir, "alias");
	await mkdir(tree);
	await mkdir(join(tree, "sub"));
	await symlink(tree, alias);
	try {
		const plugin = join(dir, "plugin"); await mkdir(plugin);
		await cp(resolve(root, "server"), join(plugin, "server"), { recursive: true });
		await cp(resolve(root, "shared"), join(plugin, "shared"), { recursive: true });
		await writeFile(join(plugin, "index.server.ts"), 'export { createWorkflowsHandlers } from "./server/workflows";');
		const { compilePlugin } = await import(
				pathToFileURL(resolve(process.env.PASEO_PLUGIN_COMPILER))
			),
			{ serverBundle } = await compilePlugin({
				server: join(plugin, "index.server.ts"),
			});
		const { createWorkflowsHandlers } = (0, eval)(serverBundle)((name) =>
			name === "@getpaseo/plugin" ? { defineRpc: (x) => x } : require(name),
		);
		const descriptor = {
			version: 1,
			socketPath: "/tmp/not-used",
			capability: "a".repeat(64),
			agentId: "agent",
			sessionId: "session",
			runtimeEpoch: randomUUID(),
			serviceEpoch: randomUUID(),
		};
		const op = randomUUID(),
			dialog = randomUUID();
		const state = {
			protocol: 1,
			sessionId: "session",
			serviceEpoch: descriptor.serviceEpoch,
			cwd: dir,
			model: "openai/gpt-6-luna",
			busy: true,
			idle: true,
			notice: null,
			operationId: op,
			operationAction: "worktree.remove",
			protectedPaths: [tree],
			dialog: {
				id: dialog,
				operationId: op,
				kind: "confirm",
				title: "Remove Git worktree",
				message: "Delete approved tree",
				options: [],
			},
			worktrees: [],
			worktreeError: null,
			worktreeLoading: false,
			goal: null,
			lastCompletion: null,
			limits: { automaticTurns: 3, noProgressTurns: 2 },
		};
		let mutations = 0,
			otherCwd = join(alias, "sub"),
			incomplete = false;
		const handlers = createWorkflowsHandlers(
			async () => descriptor,
			async (_d, r) => {
				if (r.operation !== "snapshot") mutations++;
				return state;
			},
		);
		const context = {
			paseo: {
				agents: {
					ref: () => ({
						refresh: async () => ({
							agent: { id: "agent", workspaceId: "workspace", provider: "pi" },
						}),
					}),
					list: async () => ({
						entries: [
							{
								agent: {
									id: "other",
									cwd: otherCwd,
									provider: "claude",
									archivedAt: null,
								},
							},
						],
						pageInfo: { hasMore: incomplete, nextCursor: null },
					}),
				},
			},
		};
		// New producer contract is additive; both legacy and verified recorded-owner rows parse.
		const legacyTree = { path: tree, branch: "pi/owner", head: null, main: false, current: false, locked: false, stale: false, detached: false, ownerTitle: "RAW TASK MUST NOT BECOME A CANONICAL NAME" };
		state.worktrees = [legacyTree];
		let status = await handlers.status({ agentId: "agent", workspaceId: "workspace" }, context);
		assert.equal(status.snapshot.worktrees[0].recordedOwner, undefined);
		const recordedOwner = { ownerSessionId: "session", taskId: `subagent-task-${"a".repeat(24)}`, childId: `subagent-child-${"b".repeat(24)}`, canonicalDisplayName: "Stock Pi Bridge" };
		state.worktrees = [{ ...legacyTree, recordedOwner }];
		status = await handlers.status({ agentId: "agent", workspaceId: "workspace" }, context);
		assert.deepEqual(status.snapshot.worktrees[0].recordedOwner, recordedOwner);
		const worktreeGoal = { sessionId: "session", id: "goal-a", text: "Authoritative Goal" };
		state.worktrees = [{ ...legacyTree, recordedOwner, goalScopeSessionId: "session", worktreeGoal }];
		status = await handlers.status({ agentId: "agent", workspaceId: "workspace" }, context);
		assert.equal(status.snapshot.worktrees[0].goalScopeSessionId, "session");
		assert.deepEqual(status.snapshot.worktrees[0].worktreeGoal, worktreeGoal, "producer provenance survives strict server transport");
		state.worktrees = [{ ...legacyTree, recordedOwner: { ...recordedOwner, canonicalDisplayName: undefined } }];
		status = await handlers.status({ agentId: "agent", workspaceId: "workspace" }, context);
		assert.equal(status.snapshot.worktrees[0].recordedOwner.canonicalDisplayName, undefined, "legacy names are not recovered from raw ownerTitle");
		// Current harness adds lifecycle metadata. This UI ignores only those
		// known additive fields; it neither renders completion nor changes gates.
		state.capabilities = { ownedWorktreeCompletion: true, delegatedGoals: true };
		state.worktreeCompletions = [{ version: 1, taskId: recordedOwner.taskId, ownerSessionId: "session", decidedBySessionId: "session", reason: "Explicit producer completion", completedAt: new Date().toISOString(), branchOid: "a".repeat(40), phase: "marked", path: tree, branch: "pi/owner", retained: true }];
		state.worktreeCompletionError = null;
		status = await handlers.status({ agentId: "agent", workspaceId: "workspace" }, context);
		assert.equal(status.snapshot.worktreeCompletions, undefined);
		assert.deepEqual(status.snapshot.capabilities, { delegatedGoals: true });
		state.unrecognizedFutureField = true;
		await assert.rejects(handlers.status({ agentId: "agent", workspaceId: "workspace" }, context), /Unrecognized key/);
		delete state.unrecognizedFutureField;
		state.worktrees = [];
		const input = {
			agentId: "agent",
			workspaceId: "workspace",
			expectedRuntimeEpoch: descriptor.runtimeEpoch,
			request: {
				operation: "send",
				sessionId: "session",
				serviceEpoch: descriptor.serviceEpoch,
				requestId: randomUUID(),
				operationId: op,
				dialogId: dialog,
				value: true,
			},
		};
		await assert.rejects(handlers.control(input, context), /open Paseo agent/);
		assert.equal(mutations, 0);
		otherCwd = dir;
		incomplete = true;
		await assert.rejects(
			handlers.control(input, context),
			/Incomplete agent inventory/,
		);
		assert.equal(mutations, 0);
		incomplete = false;
		await handlers.control(input, context);
		assert.equal(mutations, 1);
		await assert.rejects(
			handlers.control(
				{ ...input, request: { ...input.request, dialogId: randomUUID() } },
				context,
			),
			/confirmation changed/,
		);
		assert.equal(mutations, 1);
		// Existing-workspace opening resolves the exact real worktree path, not the parent repo.
		let proposedPath = tree, workspaceIncomplete = false, creations = 0, onlyForeign = false;
		let allocatedSource, listedFilter;
		const openHandlers = createWorkflowsHandlers(async () => descriptor, async () => ({ ...state, busy: false, operationId: null, operationAction: null, dialog: null, protectedPaths: [], openPath: proposedPath }));
		const openContext = { paseo: { ...context.paseo, workspaces: {
			ref: () => ({ refresh: async () => ({ id: "workspace", projectId: "project" }) }),
			list: async options => { listedFilter = options.filter; return { entries: workspaceIncomplete ? [] : [{ id: "foreign-child", projectId: "foreign-project", workspaceDirectory: tree }, { id: "parent-existing", projectId: "project", workspaceDirectory: dir }, ...(onlyForeign || !options.filter.includeBackground ? [] : [{ id: "child-existing", projectId: "project", workspaceDirectory: alias, background: true }])], pageInfo: { hasMore: workspaceIncomplete, nextCursor: null } }; },
			create: async options => { creations++; allocatedSource = options.source; return { id: "allocated-exact-child" }; },
		} } };
		const openInput = { ...input, request: { operation: "start", action: "worktree.open", path: tree, sessionId: "session", serviceEpoch: descriptor.serviceEpoch, requestId: randomUUID() } };
		assert.equal((await openHandlers.control(openInput, openContext)).openedWorkspaceId, "child-existing", "canonical alias must resolve to the child workspace, never the parent");
		assert.equal(creations, 0, "existing target does not allocate another workspace");
		assert.deepEqual(listedFilter, { projectId: "project", includeBackground: true }, "exact background worker workspace is reused without creating a duplicate");
		onlyForeign = true;
		assert.equal((await openHandlers.control(openInput, openContext)).openedWorkspaceId, "allocated-exact-child", "a foreign-project same-cwd workspace is not reused");
		assert.deepEqual(allocatedSource, { kind: "directory", path: tree, projectId: "project" });
		assert.equal(creations, 1);
		onlyForeign = false;
		proposedPath = dir;
		await assert.rejects(openHandlers.control(openInput, openContext), /Worktree path changed/);
		proposedPath = tree; workspaceIncomplete = true;
		await assert.rejects(openHandlers.control(openInput, openContext), /Workspace inventory is incomplete/);
		assert.equal(creations, 1, "incomplete inventory does not allocate");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
