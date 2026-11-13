import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon, ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import {
	SettingsSelect,
	Modal,
} from "@getpaseo/plugin/client/ui";
import { useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { QuietWarning, WorkEmpty } from "./work-layout";
import { goalWorkingColor } from "./goal-ticket-ui";
import { Metadata, NativeButton, NativeRow } from "./presentation";
import { WorktreeOwner } from "./worktree-owner";
import { FactText, WorktreeDiffStat, WorktreeFact, WorktreeGroupLabel, WorktreePath, WorktreeScope } from "./worktree-list";
import { worktreeGroups, type WorktreeView } from "../shared/worktree-groups";
import { recordedAgentName } from "../shared/worktree-agent";
import { DelegatedGoals } from "./delegated-goals";
import { GoalAgent } from "./goal-agent";
import { GoalReview } from "./goal-review";
import { GoalQuestionAttachments } from "./goal-question-attachments";
import {
	workflowsStatusRpc,
	workflowsControlRpc,
  workflowsReviewRpc,
	type WorkflowRequest,
	type WorkflowSnapshot,
} from "../shared/workflows";

type Memory = {
	binding?: string;
	answers: Record<string, string>;
	pending: boolean;
	uncertain: boolean;
	error?: string;
	sequence: number;
	worktreeView: WorktreeView;
	refreshed: number;
	failedAt: number;
};
const memories = new Map<string, Memory>();
const uuid = () =>
	"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		return (c === "x" ? r : (r & 3) | 8).toString(16);
	});
export function WorkflowsPanel(props: PluginAgentPanelProps) {
	return (
		<WorkflowsView
			key={JSON.stringify([props.host.id, props.workspaceId, props.agentId])}
			{...props}
			section="goal"
		/>
	);
}
export function WorkflowsSection(
	props: PluginAgentPanelProps,
) {
	return <WorkflowsView {...props} section="goal" embedded />;
}
export function WorktreesPanel(props: PluginAgentPanelProps) {
	return <WorkflowsView {...props} section="worktrees" />;
}
export function WorktreesSection(
	props: PluginAgentPanelProps & {
		onOpenWorkspace?: (id: string) => void;
	},
) {
	return <WorkflowsView {...props} section="worktrees" embedded />;
}
type WorkflowViewProps = Omit<PluginAgentPanelProps, "navigation"> & {
	navigation?: PluginAgentPanelProps["navigation"];
	section: "goal" | "worktrees";
	embedded?: boolean;
	onOpenWorkspace?: (id: string) => void;
};
function WorkflowsView({
	host,
	agentId,
	workspaceId,
	theme,
	layout,
	navigation,
	section,
	embedded = false,
	onOpenWorkspace,
}: WorkflowViewProps) {
	const [selectedTree, setSelectedTree] = useState<string>();
	// Width of the worktree list. Facts stack their labels below 600.
	const [listWidth, setListWidth] = useState(0);
	const status = useRpc(workflowsStatusRpc),
		control = useRpc(workflowsControlRpc), review = useRpc(workflowsReviewRpc);
	const [saved] = useState(() => {
		const key = JSON.stringify([host.id, agentId, workspaceId]);
		let item = memories.get(key);
		if (!item) {
			item = {
				answers: {},
				pending: false,
				uncertain: false,
				sequence: 0,
				worktreeView: "session",
				refreshed: 0,
				failedAt: 0,
			};
			memories.set(key, item);
		}
		return item;
	});
	const [, update] = useState(0),
		mounted = useRef(true);
	const redraw = () => {
		if (mounted.current) update((n) => n + 1);
	};
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const query = useQuery({
		queryKey: ["pi-workflows", host.id, workspaceId, agentId],
		queryFn: async () => {
			const sequence = ++saved.sequence,
				result = await status({ agentId, workspaceId });
			if (result.available && result.snapshot) {
				const next = JSON.stringify([
					result.sessionId,
					result.runtimeEpoch,
					result.snapshot.serviceEpoch,
				]);
				if (
					saved.binding &&
					saved.binding !== next &&
					!saved.pending &&
					!saved.uncertain &&
					!result.snapshot.operationId
				) {
					if (JSON.parse(saved.binding)[0] !== result.sessionId) {
						saved.answers = {};
						saved.worktreeView = "session";
					}
					saved.binding = next;
					saved.error = undefined;
				}
				saved.binding ??= next;
				if (saved.binding === next)
					saved.refreshed = Math.max(saved.refreshed, sequence);
			}
			return result;
		},
		refetchInterval: (q) =>
			q.state.data?.snapshot?.busy ||
			q.state.data?.snapshot?.goal?.status === "active" ||
			q.state.data?.snapshot?.delegatedGoals?.entries.some((entry) => entry.status === "active")
				? 1000
				: 5000,
		refetchOnReconnect: true,
		staleTime: 0,
	});
	const data = query.data,
		snapshot = data?.snapshot,
		completedGoals = snapshot?.completedGoals ?? [],
		binding =
			data?.available && snapshot
				? JSON.stringify([
						data.sessionId,
						data.runtimeEpoch,
						snapshot.serviceEpoch,
					])
				: undefined;
	const current = !!binding && binding === saved.binding && !query.isError,
		locked = !current || saved.pending || saved.uncertain,
		goal = snapshot?.goal,
		dialog = snapshot?.dialog,
		colors = theme.colors,
		byGoal = saved.worktreeView === "goal",
		groups = worktreeGroups(snapshot, saved.worktreeView),
		visibleWorktrees = groups.flatMap(group => group.trees);
	const delegatedGoals = snapshot?.delegatedGoals;
	async function post(fields: Record<string, unknown>): Promise<false | { snapshot: WorkflowSnapshot }> {
		if (
			locked ||
			saved.pending ||
			saved.uncertain ||
			!snapshot ||
			!data?.runtimeEpoch ||
			!data.sessionId
		)
			return false;
		saved.pending = true;
		saved.error = undefined;
		redraw();
		try {
			const result = await control({
				agentId,
				workspaceId,
				expectedRuntimeEpoch: data.runtimeEpoch,
				request: {
					sessionId: data.sessionId,
					serviceEpoch: snapshot.serviceEpoch,
					requestId: uuid(),
					...fields,
				} as WorkflowRequest,
			});
			await query.refetch();
			if (
				result.openedWorkspaceId &&
				mounted.current &&
				saved.binding === binding
			) {
				if (navigation?.openWorkspace)
					navigation.openWorkspace({
						workspaceId: result.openedWorkspaceId,
						serverId: host.id,
					});
				else onOpenWorkspace?.(result.openedWorkspaceId);
			}
			return result;
		} catch {
			saved.uncertain = true;
			saved.failedAt = saved.sequence;
			saved.error =
				"The action may have completed. Review the automatically updated state before another action.";
			return false;
		} finally {
			saved.pending = false;
			redraw();
		}
	}
	const start = (action: string, extra: Record<string, unknown> = {}) =>
		void post({
			operation: "start",
			action,
			expectedGoalId: goal?.id ?? null,
      ...(action.startsWith("goal.") && goal ? { expectedActivationId: goal.activationId, expectedGoalRevision: goal.revision } : {}),
			...extra,
		});
	const button = (label: string, onPress: () => void, disabled = false, primary = false) =>
		<NativeButton colors={colors} label={label} onPress={onPress} disabled={disabled} primary={primary} style={{ alignSelf: "flex-start", minHeight: 44 }} />;
	/** Opens the worktree's workspace. The path link and the Open workspace button share this. */
	const openWorktree = (path: string) => start("worktree.open", { path });

	function renderWorktrees(current: WorkflowSnapshot) {
		const count = visibleWorktrees.length;
		const noRepositories = current.worktreeContainer && !current.worktreeRepositoryCount;
		return (
			<View onLayout={event => setListWidth(event.nativeEvent.layout.width)}
				style={{ gap: 20, width: "100%", maxWidth: 960, alignSelf: "center", minWidth: 0 }}>
				<View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
					<Metadata colors={colors} style={{ flex: 1, paddingHorizontal: 4 }}>
						{current.worktreeLoading ? "Loading worktrees…" : count ? `${count} ${count === 1 ? "worktree" : "worktrees"}` : ""}
					</Metadata>
					{!current.worktreeLoading ? (
						<WorktreeScope colors={colors} value={saved.worktreeView}
							onChange={value => { saved.worktreeView = value; redraw(); }} />
					) : null}
				</View>
				{current.worktreeError && current.worktreeError !== "Worktree inventory timed out; open a repository directly for a narrower view." ? <QuietWarning colors={colors} summary="Some worktrees couldn't be listed and were skipped." detail={current.worktreeError} /> : null}
				{!current.worktreeLoading && !current.worktreeError && !count ? (
					noRepositories ? (
						<WorkEmpty colors={colors} icon="GitBranch" title="No Git repositories found"
							hint="Pi looks for repositories up to two directory levels below this workspace." />
					) : (
						<WorkEmpty colors={colors} icon="GitBranch"
							title={saved.worktreeView === "all" ? "No additional worktrees" : saved.worktreeView === "goal" ? "No worktrees from this chat's goals" : "No worktrees from this chat"}
							hint="Workers and goals that get their own checkout show up here.">
							{saved.worktreeView !== "all" ? (
								<Pressable accessibilityRole="button" hitSlop={8}
									onPress={() => { saved.worktreeView = "all"; redraw(); }}>
									<Metadata colors={colors} style={{ color: colors.foreground }}>Show all worktrees</Metadata>
								</Pressable>
							) : null}
						</WorkEmpty>
					)
				) : null}
				{groups.map(group => (
					<View key={group.key} style={{ gap: 8 }}>
						{/* Legacy runtimes report no repository, so their single group stays unlabelled. */}
						{byGoal || group.trees[0]?.repositoryPath ? (
							<WorktreeGroupLabel colors={colors} icon={byGoal ? "Target" : "FolderGit2"} label={group.label} />
						) : null}
						<View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface1, overflow: "hidden" }}>
							{group.trees.map((tree, index) => (
								<View key={tree.path} style={index ? { borderTopWidth: 1, borderTopColor: colors.border } : undefined}>
									{renderWorktree(tree, current)}
								</View>
							))}
						</View>
					</View>
				))}
			</View>
		);
	}

	function renderWorktree(tree: WorkflowSnapshot["worktrees"][number], current: WorkflowSnapshot) {
		// Ownership and working-copy safety gates are intentionally unchanged.
		const unsafe =
			tree.stale ||
			tree.locked ||
			tree.current ||
			tree.main ||
			tree.inUse === true ||
			tree.changedFiles == null ||
			tree.changedFiles > 0;
		const guarded =
			locked ||
			current.busy ||
			!current.idle ||
			goal?.status === "active" ||
			unsafe;
		const workspaceUnavailable = locked || current.busy || tree.stale || !(onOpenWorkspace || navigation?.openWorkspace);
		const ownerName = tree.recordedOwner ? recordedAgentName(tree.recordedOwner) : null;
		const branch = tree.branch ?? (tree.detached ? "Detached HEAD" : "Branch unavailable");
		const changed = tree.changedFiles;
		const changedLabel = changed ? `${changed} changed ${changed === 1 ? "file" : "files"}` : "";
		const warning = !!tree.setupError || tree.stale || tree.locked;
		const rowState = tree.setupError ? "setup failed"
			: tree.stale ? "stale metadata"
			: tree.locked ? "locked"
			: tree.main ? "main checkout"
			: tree.current ? "current checkout"
			: changed == null ? "status unavailable"
			: changed > 0 ? changedLabel
			: "clean";
		// The branch leads when the owner name is the title. By goal also names the repository.
		const detailParts = [
			ownerName ? branch : "",
			byGoal ? tree.repositoryLabel ?? tree.repositoryPath ?? "Repository unavailable" : "",
			rowState,
		].filter(Boolean);
		// Capitalise the state when it starts the line.
		if (detailParts[0] === rowState) detailParts[0] = rowState.charAt(0).toUpperCase() + rowState.slice(1);
		const detail = detailParts.join(" · ");
		const selected = selectedTree === tree.path;
		const narrow = listWidth > 0 && listWidth < 600;
		const flags = [
			tree.main ? "Main checkout" : "",
			tree.current ? "Current checkout" : "",
			tree.locked ? "Locked" : "",
			tree.stale ? "Stale metadata" : "",
			tree.inUse ? "Assigned ownership" : "",
		].filter(Boolean);
		const removalBlock = tree.inUse
			? "Assigned ownership blocks removal"
			: tree.current
				? "Current worktree cannot be removed"
				: tree.locked
					? "Worktree is locked"
					: tree.stale
						? "Stale worktree metadata"
						: tree.changedFiles == null
							? "Change status unavailable"
							: tree.changedFiles > 0
								? "Uncommitted changes must be preserved"
								: tree.main ? "Main checkout cannot be removed" : locked ? "Refresh the connection before removal" : "Wait until Pi and Goal are idle";
		return (
			<>
				<NativeRow colors={colors} title={ownerName ?? branch}
					detail={detail}
					accessibilityLabel={ownerName ?? branch}
					accessibilityHint="Show checkout details, agent and removal options"
					expanded={selected}
					onPress={() => setSelectedTree(selected ? undefined : tree.path)}
					leading={<Icon name="GitBranch" size={14}
						color={warning ? colors.statusWarning : changed ? goalWorkingColor : colors.foregroundMuted} />}
					trailing={
						<View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
							{tree.diffStat ? <WorktreeDiffStat colors={colors} diffStat={tree.diffStat} /> : null}
							<Icon name={selected ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} />
						</View>
					} />
				{selected ? (
					// Indented to line up with the row title (12 padding, 14 icon, 8 gap).
					<View style={{ gap: 12, paddingLeft: 34, paddingRight: 12, paddingBottom: 12 }}>
						<View style={{ gap: 6 }}>
							<WorktreeFact colors={colors} label="Path" narrow={narrow}>
								<WorktreePath colors={colors} path={tree.path} platform={layout.platform}
									disabled={workspaceUnavailable} onOpen={() => openWorktree(tree.path)} />
							</WorktreeFact>
							<WorktreeFact colors={colors} label="Branch" narrow={narrow}>
								<FactText colors={colors}>{branch}</FactText>
							</WorktreeFact>
							<WorktreeFact colors={colors} label="Changes" narrow={narrow}>
								<FactText colors={colors}>
									{changed == null ? "Working copy status unavailable" : changed ? `${changedLabel}, uncommitted` : "Clean, nothing uncommitted"}
									{tree.includedChanges ? " · includes parent changes" : ""}
								</FactText>
							</WorktreeFact>
							{flags.length ? (
								<WorktreeFact colors={colors} label="State" narrow={narrow}>
									<FactText colors={colors} tone={tree.stale || tree.locked ? "warning" : undefined}>{flags.join(" · ")}</FactText>
								</WorktreeFact>
							) : null}
							{tree.setupError ? (
								<WorktreeFact colors={colors} label="Setup" narrow={narrow}>
									<FactText colors={colors} tone="warning">{tree.setupError}</FactText>
								</WorktreeFact>
							) : null}
							{tree.recordedOwner && data?.sessionId && data.runtimeEpoch ? (
								<WorktreeFact colors={colors} label="Agent" narrow={narrow}>
									<WorktreeOwner key={JSON.stringify([tree.path, data.sessionId, data.runtimeEpoch, tree.recordedOwner])}
										host={host} agentId={agentId} workspaceId={workspaceId} theme={theme} layout={layout}
										owner={tree.recordedOwner} sessionId={data.sessionId} runtimeEpoch={data.runtimeEpoch} hideHeading
										onOpenAgent={navigation?.openAgent ? id => navigation.openAgent({ agentId: id, serverId: host.id }) : undefined} />
								</WorktreeFact>
							) : null}
						</View>
						{guarded ? <Metadata colors={colors}>{removalBlock}</Metadata> : null}
						<View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
							<NativeButton colors={colors} label="Open workspace" disabled={workspaceUnavailable}
								onPress={() => openWorktree(tree.path)}
								style={{ paddingVertical: 4, paddingHorizontal: 10 }} />
							<NativeButton colors={colors} label="Remove…" danger disabled={guarded}
								onPress={() => start("worktree.remove", { path: tree.path })}
								style={{ paddingVertical: 4, paddingHorizontal: 10 }} />
						</View>
					</View>
				) : null}
			</>
		);
	}

	const Container = embedded ? View : ScrollView;
	return (
		<Container
			{...(embedded
				? { style: { padding: section === "worktrees" ? 0 : 8, gap: 8, minWidth: 0 } }
				: {
						style: { flex: 1, backgroundColor: colors.surface0, minWidth: 0 },
						contentContainerStyle: { padding: 12, gap: 12 },
					})}
		>
			{query.isPending ? (
				<Metadata colors={colors}>Connecting to Pi…</Metadata>
			) : null}
			{query.isError ? (
				<Text style={{ color: colors.statusWarning }}>
					Workflow connection unavailable. Retrying automatically.
				</Text>
			) : null}
			{!query.isPending && !query.isError && !data?.available ? (
				<View style={{ flexDirection: "row", gap: 12, alignItems: "flex-start", padding: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface1 }}>
					<Icon name="RefreshCw" size={18} color={colors.foregroundMuted} />
					<View style={{ flex: 1, gap: 4 }}>
						<Text style={{ color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "500" }}>
							This chat runs an older Pi
						</Text>
						<Metadata colors={colors}>
							Goals and worktrees need the current extensions. Reload Pi in this chat to turn them on. Jobs and agents keep working.
						</Metadata>
					</View>
				</View>
			) : null}
			{binding && saved.binding !== binding ? (
				<View>
					<Text style={{ color: colors.statusWarning }}>
						The Pi connection changed. Review the current session before
						continuing.
					</Text>
					{button(
						"Connect current session",
						() => {
							saved.binding = binding;
							saved.uncertain = false;
							saved.error = undefined;
							saved.answers = {};
							redraw();
							void query.refetch();
						},
						saved.pending,
					)}
				</View>
			) : null}
			{current && snapshot ? (
				<>
					{saved.error ? (
						<Text
							accessibilityRole="alert"
							style={{ color: colors.statusWarning }}
						>
							{saved.error}
						</Text>
					) : null}
					{saved.uncertain
						? button(
								"I reviewed the refreshed status",
								() => {
									saved.uncertain = false;
									saved.error = undefined;
									redraw();
								},
								saved.pending ||
									saved.refreshed <= saved.failedAt ||
									query.isFetching,
							)
						: null}
					{snapshot.notice ? (
						<Text
							selectable
							accessibilityRole="alert"
							style={{ color: colors.foregroundMuted }}
						>
							{snapshot.notice}
						</Text>
					) : null}
					{dialog ? (
						<Modal title={dialog.title} open onOpenChange={(open) => {
							if (!open && !locked) void post({ operation: "cancel", operationId: dialog.operationId });
						}}>
							<Modal.Content>
								<View style={{ gap: 16 }}>
									{dialog.message ? (
										<Text selectable style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>
											{dialog.message}
										</Text>
									) : null}
									{dialog.kind === "input" ? (
										<TextInput
											accessibilityLabel={dialog.title}
											value={saved.answers[dialog.id] ?? ""}
											maxLength={8000}
											onChangeText={(value) => {
												saved.answers[dialog.id] = value;
												redraw();
											}}
											editable={!locked}
											style={{
												color: colors.foreground,
												backgroundColor: colors.surface2,
												padding: 12,
												minHeight: 44,
											}}
										/>
									) : null}
									{dialog.kind === "select" ? (
										<SettingsSelect
											label="Selection"
											value={saved.answers[dialog.id] ?? ""}
											options={[
												{ label: "Choose…", value: "" },
												...dialog.options.map((value) => ({
													label: value,
													value,
												})),
											]}
											onValueChange={(value) => {
												saved.answers[dialog.id] = value;
												redraw();
											}}
											disabled={locked}
										/>
									) : null}
									<View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
									{button(
										dialog.kind === "confirm" ? "Confirm" : "Continue",
										() =>
											void post({
												operation: "send",
												operationId: dialog.operationId,
												dialogId: dialog.id,
												value:
													dialog.kind === "confirm"
														? true
														: (saved.answers[dialog.id] ?? ""),
											}),
										locked ||
											(dialog.kind === "select" &&
												!dialog.options.includes(
													saved.answers[dialog.id] ?? "",
												)),
										snapshot.operationAction === "goals.start" || snapshot.operationAction === "goals.resume",
									)}
									{button(
										"Cancel operation",
										() =>
											void post({
												operation: "cancel",
												operationId: dialog.operationId,
											}),
										locked,
									)}
									</View>
								</View>
							</Modal.Content>
						</Modal>
					) : snapshot.busy ? (
						<View>
							<Text style={{ color: colors.foregroundMuted }}>
								Applying workflow operation…
							</Text>
							{snapshot.operationId
								? button(
										"Cancel operation",
										() =>
											void post({
												operation: "cancel",
												operationId: snapshot.operationId,
											}),
										locked,
									)
								: null}
						</View>
					) : null}
					{section === "goal" ? (
						<>
							<DelegatedGoals key={binding} registry={delegatedGoals ?? { version: 1, revision: 0, entries: [] }} assignedGoal={goal ?? null} completedAssigned={completedGoals} colors={colors} identity={binding ?? ""}
								locked={locked || !!dialog || !delegatedGoals || snapshot.capabilities?.delegatedGoals !== true} busy={snapshot.busy} executionAvailable={snapshot.capabilities?.delegatedGoalExecution === true} limitsEditable={snapshot.capabilities?.goalLimitEditing === true} planningAvailable={snapshot.capabilities?.goalPlanning === true} model={null} limits={snapshot.limits} post={post}
                renderQuestionAttachments={(entry,question)=><GoalQuestionAttachments key={`${binding}/${entry.id}/${question.id}`} goal={entry} question={question} colors={colors} disabled={locked||snapshot.busy} available={snapshot.capabilities?.goalReview===true} preview={(referenceId,questionTarget)=>{
                  if(locked||!data.sessionId||!data.runtimeEpoch)return Promise.reject(new Error("Session unavailable"));
                  return review({agentId,workspaceId,sessionId:data.sessionId,serviceEpoch:snapshot.serviceEpoch,expectedRuntimeEpoch:data.runtimeEpoch,expectedGoalId:entry.id,expectedEntryRevision:entry.revision,referenceId,question:questionTarget});
                }} />}
                renderReview={entry => <GoalReview key={`${binding}/${entry.id}`} goal={entry} colors={colors} disabled={locked || snapshot.busy} available={snapshot.capabilities?.goalReview === true}
                  register={fields => post({ operation: "start", action: "goals.reference", expectedGoalId: entry.id, ...fields }).then(Boolean)}
                  preview={(referenceId, expectedEntryRevision) => {
                    if (locked || !data.sessionId || !data.runtimeEpoch) return Promise.reject(new Error("Session unavailable"));
                    return review({ agentId, workspaceId, sessionId: data.sessionId, serviceEpoch: snapshot.serviceEpoch, expectedRuntimeEpoch: data.runtimeEpoch, expectedGoalId: entry.id, expectedEntryRevision, referenceId });
                  }} />}
                renderAgent={entry => entry.child && data?.sessionId && data.runtimeEpoch ? <GoalAgent key={JSON.stringify([binding, entry.child])}
                  child={entry.child} sessionId={data.sessionId} runtimeEpoch={data.runtimeEpoch} host={host} agentId={agentId} workspaceId={workspaceId} theme={theme}
                  onOpenAgent={navigation?.openAgent ? id => navigation.openAgent({ agentId: id, serverId: host.id }) : undefined} /> : null} />
							{!delegatedGoals ? <Metadata colors={colors}>Reload Pi to enable creation of independent goals.</Metadata> : null}
						</>
					) : (
						renderWorktrees(snapshot)
					)}
				</>
			) : null}
		</Container>
	);
}
/** Compatibility export retained; the Goals tab in Work is the primary entry. */
export function contributeWorkflows(
	_client: import("@getpaseo/plugin/client").PluginClientContext,
) {
	return () => {};
}
