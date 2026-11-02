import type { WorkflowSnapshot } from "./workflows";

export type WorktreeView = "goal" | "session" | "all";
export const worktreeViews = [
	{ value: "goal", label: "By Goal" },
	{ value: "session", label: "This session" },
	{ value: "all", label: "All worktrees" },
] as const;
type Tree = WorkflowSnapshot["worktrees"][number];
export type WorktreeGroup = { key: string; label: string; trees: Tree[] };

/** Presentation only. Neither scope nor grouping grants ownership/removal authority. */
export function worktreeGroups(snapshot: WorkflowSnapshot | undefined, view: WorktreeView): WorktreeGroup[] {
	if (!snapshot) return [];
	const trees = snapshot.worktrees.filter(tree => view === "all" || tree.createdInSession === true ||
		(view === "goal" && tree.goalScopeSessionId === snapshot.sessionId));
	const groups = new Map<string, WorktreeGroup>();
	for (const tree of trees) {
		const association = tree.worktreeGoal?.sessionId === snapshot.sessionId ? tree.worktreeGoal : undefined;
		const key = view === "goal" ? association ? `goal:${association.id}` : "unassigned" : `repo:${tree.repositoryPath ?? ""}`;
		let group = groups.get(key);
		if (!group) {
			group = { key, label: view === "goal" ? association?.text ?? "Unassigned" : tree.repositoryLabel ?? tree.repositoryPath ?? "", trees: [] };
			groups.set(key, group);
		}
		group.trees.push(tree);
	}
	const result = [...groups.values()];
	return view === "goal" ? [...result.filter(group => group.key !== "unassigned"), ...result.filter(group => group.key === "unassigned")] : result;
}
