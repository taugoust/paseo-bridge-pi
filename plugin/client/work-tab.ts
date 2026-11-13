export type WorkSection = "jobs" | "agents" | "worktrees" | "goals";
export type WorkViewState = {
	section?: WorkSection;
	completed: boolean;
	scroll: Map<string, number>;
	/** Counts presses on the Work pill. Each new press opens the section with live work. */
	opened?: number;
	/** The last press the open tab has acted on. */
	handled?: number;
};

/** One instance per host-scoped client contribution. Closing a native tab does
 * not dispose this UI state, and this store has no work-control capabilities. */
export function createWorkTabState() {
	const selected = new Map<string, string>();
	const views = new Map<string, WorkViewState>();
	// Claim once per contribution, even when a saved source proves invalid. A
	// later settings update must not silently select a different conversation.
	const claimed = new Set<string>();
	const explicit = new Map<string, number>();
	let revision = 0;
	const listeners = new Set<() => void>();
	const key = (workspaceId: string, agentId: string) => JSON.stringify([workspaceId, agentId]);
	return {
		selected(workspaceId: string) { return selected.get(workspaceId); },
		claimed(workspaceId: string) { return claimed.has(workspaceId); },
		claim(workspaceId: string) { claimed.add(workspaceId); },
		explicit(workspaceId: string) { return explicit.get(workspaceId); },
		select(workspaceId: string, agentId: string, restored = false) {
			claimed.add(workspaceId);
			if (!restored) explicit.set(workspaceId, ++revision);
			selected.set(workspaceId, agentId);
			listeners.forEach(listener => listener());
		},
		view(workspaceId: string, agentId: string) {
			const id = key(workspaceId, agentId);
			let view = views.get(id);
			if (!view) {
				view = { completed: false, scroll: new Map() };
				views.set(id, view);
			}
			return view;
		},
		remove(workspaceId: string, agentId: string) {
			views.delete(key(workspaceId, agentId));
			if (selected.get(workspaceId) !== agentId) return;
			selected.delete(workspaceId);
			// Keep the explicit-interaction marker: removing a subsequently
			// selected source must not revive an older in-flight restoration.
			listeners.forEach(listener => listener());
		},
		refresh() { listeners.forEach(listener => listener()); },
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
	};
}
