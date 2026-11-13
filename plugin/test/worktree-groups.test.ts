import assert from "node:assert/strict";
import { test } from "node:test";
import { worktreeGroups, worktreeViews } from "../shared/worktree-groups.ts";
import type { WorkflowSnapshot } from "../shared/workflows.ts";
const row = (path: string, fields = {}) => ({ path, repositoryPath: "/repo", repositoryLabel: "repo", ...fields });
const snapshot = (worktrees: unknown[], sessionId = "root") => ({ sessionId, worktrees }) as WorkflowSnapshot;
const association = (id = "a", sessionId = "root") => ({ sessionId, id, text: "Same title" });
test("exact selector order and missing/empty snapshots", () => {
	assert.deepEqual(worktreeViews.map(view => view.label), ["This chat", "By goal", "All"]);
	assert.deepEqual(worktreeViews.map(view => view.value), ["session", "goal", "all"]);
	for (const view of worktreeViews) {
		assert.deepEqual(worktreeGroups(undefined, view.value), []);
		assert.deepEqual(worktreeGroups(snapshot([]), view.value), []);
	}
});
test("By Goal isolates the session, separates IDs rather than titles, and puts legacy/unassociated rows last", () => {
	const rows = [
		row("unassigned", { createdInSession: true }),
		row("a", { createdInSession: true, worktreeGoal: association() }),
		row("foreign", { createdInSession: false, goalScopeSessionId: "other", worktreeGoal: association() }),
		row("b", { goalScopeSessionId: "root", worktreeGoal: association("b") }),
		row("a-descendant", { repositoryPath: "/second", goalScopeSessionId: "root", worktreeGoal: association() }),
		row("legacy", { createdInSession: true }),
		row("foreign-association", { createdInSession: true, worktreeGoal: association("a", "foreign") }),
		row("no-provenance", { worktreeGoal: association() }),
	];
	const groups = worktreeGroups(snapshot(rows), "goal");
	assert.deepEqual(groups.map(group => [group.key, group.label, group.trees.map(tree => tree.path)]), [
		["goal:a", "Same title", ["a", "a-descendant"]],
		["goal:b", "Same title", ["b"]],
		["unassigned", "No goal", ["unassigned", "legacy", "foreign-association"]],
	]);
	assert.equal(groups[0]!.trees[1]!.repositoryPath, "/second");
	assert.deepEqual(worktreeGroups(snapshot(rows, "new-session"), "goal").map(group => group.key), ["unassigned"]);
});
test("This session and All worktrees retain repository grouping and their exact existing scope predicates", () => {
	const rows = [row("other", { createdInSession: false }), row("ours", { createdInSession: true }), row("descendant", { goalScopeSessionId: "root", worktreeGoal: association() }), row("second", { createdInSession: true, repositoryPath: "/second", repositoryLabel: "second" }), row("legacy")];
	assert.deepEqual(worktreeGroups(snapshot(rows), "session").map(group => [group.label, group.trees.map(tree => tree.path)]), [["repo", ["ours"]], ["second", ["second"]]]);
	assert.deepEqual(worktreeGroups(snapshot(rows), "all").map(group => group.trees.map(tree => tree.path)), [["other", "ours", "descendant", "legacy"], ["second"]]);
	assert.deepEqual(worktreeGroups(snapshot([row("ours", { createdInSession: true })]), "goal").map(group => group.label), ["No goal"]);
});
