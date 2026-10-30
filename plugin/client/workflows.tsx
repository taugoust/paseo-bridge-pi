import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import {
	SettingsSelect,
	Modal,
} from "@getpaseo/plugin/client/ui";
import { useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { Metadata, NativeButton } from "./presentation";
import { WorktreeOwner } from "./worktree-owner";
import { recordedAgentName } from "../shared/worktree-agent";
import { WorktreeWorkspaceAction } from "./worktree-workspace-action";
import { worktreeLinkKeyboardProps } from "../shared/worktree-link";
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
	showAllWorktrees: boolean;
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
				showAllWorktrees: false,
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
						saved.showAllWorktrees = false;
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
		showAllWorktrees = saved.showAllWorktrees === true,
		visibleWorktrees = snapshot?.worktrees.filter(
			(tree) => showAllWorktrees || tree.createdInSession === true,
		) ?? [];
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
	const Container = embedded ? View : ScrollView;
	return (
		<Container
			{...(embedded
				? { style: { padding: 8, gap: 8, minWidth: 0 } }
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
				<Metadata colors={colors}>
					Reload Pi to enable Worktree and Goal.
				</Metadata>
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
						<View style={{ gap: 4, width: "100%", maxWidth: 740, alignSelf: "center" }}>
							<View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12, paddingTop: 8, paddingBottom: 8 }}>
							<Text style={{ paddingHorizontal: 8, color: colors.foreground, fontSize: 14, fontWeight: "600" }}>{visibleWorktrees.length} {visibleWorktrees.length === 1 ? "worktree" : "worktrees"}</Text>
							{!snapshot.worktreeLoading ? (
								<View accessibilityLabel="Worktree scope" style={{ flexDirection: "row", gap: 4, alignSelf: "flex-start", padding: 3, marginHorizontal: 4, borderRadius: 10, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border }}>
									{[false, true].map((all) => (
										<Pressable key={String(all)} accessibilityRole="button"
											accessibilityState={{ selected: showAllWorktrees === all }}
											onPress={() => { saved.showAllWorktrees = all; redraw(); }}
											style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderRadius: 8, backgroundColor: showAllWorktrees === all ? colors.surface2 : "transparent" }}>
											<Text style={{ color: colors.foreground }}>{all ? "All worktrees" : "This session"}</Text>
										</Pressable>
									))}
								</View>
							) : null}
							</View>
							{snapshot.worktreeLoading ? <Text style={{ color: colors.foregroundMuted }}>Loading worktrees…</Text> : null}
							{snapshot.worktreeError && snapshot.worktreeError !== "Worktree inventory timed out; open a repository directly for a narrower view." ? <Text selectable style={{ color: colors.statusWarning }}>{snapshot.worktreeError}</Text> : null}
							{!snapshot.worktreeLoading &&
							!snapshot.worktreeError &&
							!visibleWorktrees.length ? (
								<Text style={{ color: colors.foregroundMuted, padding: 8 }}>
									{snapshot.worktreeContainer &&
									!snapshot.worktreeRepositoryCount
										? "No Git repositories found within two directory levels"
										: showAllWorktrees
											? "No additional worktrees"
											: "No session-created worktrees"}
								</Text>
							) : null}
							{visibleWorktrees.map((tree, index) => {
								// Ownership and working-copy safety gates are intentionally unchanged.
								const unsafe =
										tree.stale ||
										tree.locked ||
										tree.current ||
										tree.main ||
										tree.inUse === true ||
										tree.changedFiles == null ||
										tree.changedFiles > 0,
									guarded =
										locked ||
										snapshot.busy ||
										!snapshot.idle ||
										goal?.status === "active" ||
										unsafe,
									ownerName = tree.recordedOwner ? recordedAgentName(tree.recordedOwner) : null,
									branch = tree.branch ?? (tree.detached ? "Detached HEAD" : "Branch unavailable"),
									rowState = tree.setupError ? "Setup failed" : tree.stale ? "Stale metadata" : tree.locked ? "Locked" : tree.main ? "Main checkout" : tree.current ? "Current checkout" : tree.changedFiles == null ? "Status unavailable" : tree.changedFiles > 0 ? "Uncommitted changes" : "Working copy clean",
									selected = selectedTree === tree.path,
									workspaceUnavailable = locked || snapshot.busy || tree.stale || !(onOpenWorkspace || navigation?.openWorkspace);
								return (
									<View
										key={tree.path}
										style={{
											borderBottomWidth: 1,
											borderBottomColor: colors.border,
										}}
									>
										{tree.repositoryPath &&
										tree.repositoryPath !==
											visibleWorktrees[index - 1]?.repositoryPath ? (
											<Text
												accessibilityRole="header"
												style={{
													color: colors.foreground,
													fontWeight: "600",
													fontSize: 13,
													paddingHorizontal: 12,
													paddingVertical: 8,
													marginTop: 16,
													marginBottom: 4,
													borderRadius: 6,
													backgroundColor: colors.surface1,
												}}
											>
												{tree.repositoryLabel ?? tree.repositoryPath}
												<Text style={{ color: colors.foregroundMuted, fontWeight: "400" }}> · {visibleWorktrees.filter(item => item.repositoryPath === tree.repositoryPath).length}</Text>
											</Text>
										) : null}
										<View style={{ flexDirection: "row", alignItems: "center", minWidth: 0, paddingVertical: 4, paddingRight: 4, backgroundColor: selected ? colors.surface1 : "transparent" }}>
										<Pressable
											accessibilityRole="button"
											accessibilityLabel={`${selected ? "▾" : "▸"} ${ownerName ?? branch}`}
											accessibilityHint="Show checkout details, agent and removal options"
											accessibilityState={{ expanded: selected }}
											onPress={() =>
												setSelectedTree(selected ? undefined : tree.path)
											}
											style={({ pressed }) => ({
												minHeight: 52,
												gap: 3,
												flex: 1,
												minWidth: 0,
												justifyContent: "center",
												paddingHorizontal: 12,
												borderRadius: 8,
												backgroundColor: pressed || selected ? colors.surface2 : "transparent",
											})}
										>
											<Text
												numberOfLines={1}
												style={{ color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" }}
											>
												{selected ? "▾ " : "▸ "}{ownerName ?? branch}
											</Text>
											<Text numberOfLines={1} style={{ color: tree.setupError || tree.stale || tree.locked ? colors.statusWarning : colors.foregroundMuted, fontSize: 12, lineHeight: 18, paddingLeft: 12 }}>{ownerName ? `${branch} · ` : ""}{rowState}</Text>
										</Pressable>
										<WorktreeWorkspaceAction path={tree.path} diffStat={tree.diffStat} disabled={workspaceUnavailable}
											onPress={() => start("worktree.open", { path: tree.path })} colors={colors} />
										</View>
										{selected ? (
											<View style={{ padding: 12, gap: 8, backgroundColor: colors.surface1, borderRadius: 8, marginBottom: 8 }}>
												<Pressable accessibilityRole="link" accessibilityLabel={`Open workspace ${tree.path}`}
													{...worktreeLinkKeyboardProps(layout.platform, workspaceUnavailable, () => start("worktree.open", { path: tree.path }))}
													disabled={workspaceUnavailable}
													accessibilityState={{ disabled: workspaceUnavailable }}
													onPress={() => start("worktree.open", { path: tree.path })}
													style={{ minHeight: 44, justifyContent: "center", opacity: workspaceUnavailable ? 0.5 : 1 }}>
													<Text selectable style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{tree.path} ↗</Text>
												</Pressable>
												<Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{branch}</Text>
												{tree.recordedOwner && data?.sessionId && data.runtimeEpoch ? (
													<WorktreeOwner key={JSON.stringify([tree.path, data.sessionId, data.runtimeEpoch, tree.recordedOwner])}
														host={host} agentId={agentId} workspaceId={workspaceId} theme={theme} layout={layout}
														owner={tree.recordedOwner} sessionId={data.sessionId} runtimeEpoch={data.runtimeEpoch}
														onOpenAgent={navigation?.openAgent ? id => navigation.openAgent({ agentId: id, serverId: host.id }) : undefined} />
												) : null}
												<Text style={{ color: colors.foregroundMuted }}>
													{tree.changedFiles == null ? "Working copy status unavailable" : tree.changedFiles ? "Uncommitted changes" : "Working copy clean"}
													{tree.main ? " · main checkout" : ""}{tree.current ? " · current" : ""}
													{tree.inUse ? " · assigned ownership" : ""}
												</Text>
												{tree.includedChanges ? (
													<Text style={{ color: colors.foregroundMuted }}>
														Includes parent changes
													</Text>
												) : null}
												{tree.setupError ? (
													<Text style={{ color: colors.statusWarning }}>
														{tree.setupError}
													</Text>
												) : null}
												{guarded ? (
													<Text style={{ color: colors.foregroundMuted }}>
														{tree.inUse
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
																				: tree.main ? "Main checkout cannot be removed" : locked ? "Refresh the connection before removal" : "Wait until Pi and Goal are idle"}
													</Text>
												) : null}
												<View style={{ gap: 8, minWidth: 0, width: "100%", maxWidth: 720 }}>
													<NativeButton colors={colors} label="Remove…" disabled={guarded}
														onPress={() => start("worktree.remove", { path: tree.path })}
														style={{ alignSelf: "flex-start", minHeight: 44 }} />
												</View>
											</View>
										) : null}
									</View>
								);
							})}
						</View>
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
