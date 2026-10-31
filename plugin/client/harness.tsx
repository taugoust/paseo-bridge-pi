import { observeAgentDirectory, retainContribution } from "./agent-directory";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { readJobs } from "./jobs-pages";
import { readSubagents } from './subagent-pages';
import { orderTaskTree, taskGroupKey, treeAttemptKey } from "../shared/subagent-tree";
import { treeConnectors, type TreeAnchor } from "../shared/tree-connectors";
import { groupSubagentAttempts, attemptIdentity } from "./subagent-attempts";
import { Pressable, Text, View, type ScrollView as NativeScrollView } from "react-native";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsAction } from "@getpaseo/plugin/client/ui";
import {
	useRpc,
	useSettings,
	type PluginAgentPanelProps,
	type PluginButtonIconProps,
	type PluginClientContext,
	type PluginWorkspacePanelProps,
	type PluginButtonRegistration,
} from "@getpaseo/plugin/client";
import {
	harnessStatusRpc,
	harnessJobsListRpc,
	harnessJobsOutputRpc,
	harnessSubagentsListRpc,
	harnessSubagentReportRpc,
} from "../shared/harness-readonly";

import { ForegroundTasksSection } from "./foreground-tasks";
import {
	WorktreesPanel,
	WorktreesSection,
	WorkflowsSection,
	WorkflowsPanel,
} from "./workflows";
import { foregroundTasksStatusRpc } from "../shared/foreground-tasks";
import { isActiveAgent, isActiveWorkStatus } from "../shared/work-display";
import { isDormantIndependentAgent } from "../shared/independent-state";
import { WorkStatusRing } from "./work-status-ring";
import { Metadata, NativeButton, NativeRow, OutputWell, WorkAction } from "./presentation";
import {
	createAgentConversationTabs,
	WorkerConversation,
	type AgentConversationTarget,
} from "./agent-conversation";

import { createWorkTabState, type WorkViewState } from "./work-tab";
import { workSourceSettings } from "../shared/work-source";
import { nativeChildTitle, type ChildTitleRow } from "../shared/existing-child-identity";
type ChildTitleResolver = (row: ChildTitleRow) => string;

type Kind = "jobs" | "subagents";

type Agent = {
	id: string;
	workspaceId?: string | null;
	provider?: string;
	archivedAt?: string | null;
	title?: string | null;
};

/** Registration is local. Queries run only for a mounted button or open view. */
export function contributeHarness(client: PluginClientContext) {
	return retainContribution(client, "work", () => registerHarness(client));
}

function registerHarness(client: PluginClientContext) {
	const entries = new Map<
		string,
		{
			workspaceId: string;
			title?: string | null;
			buttons: PluginButtonRegistration[];
		}
	>();
	// Titles and controls share the same background-inclusive inventory.
	const nativeTitles = new Map<string, { workspaceId: string; title?: string | null }>();
	let stopped = false;
	const conversations = createAgentConversationTabs(client);
	const work = createWorkTabState();
	let hydrated = false;
	const saving = new Map<string, number>();
	const retries = new Set<ReturnType<typeof setTimeout>>();
	const retry = (run: () => void) => {
		if (stopped) return;
		const timer = setTimeout(() => { retries.delete(timer); if (!stopped) run(); }, 5000);
		retries.add(timer);
	};
	function WorkPanel(props: PluginWorkspacePanelProps) {
		const settings = useSettings(workSourceSettings);
		const [, refresh] = useState(0);
		useEffect(() => {
			const unsubscribe = work.subscribe(() => refresh(value => value + 1));
			refresh(value => value + 1);
			return unsubscribe;
		}, []);
		const agentId = work.selected(props.workspaceId);
		const workspaceId = props.workspaceId;
		useEffect(() => {
			if (settings.status !== "ready" || !hydrated || stopped) return;
			if (!work.claimed(workspaceId)) {
				work.claim(workspaceId);
				const hint = settings.values.sources.find(source =>
					source.hostId === props.host.id && source.workspaceId === workspaceId);
				const entry = hint && entries.get(hint.agentId);
				if (hint && entry?.workspaceId === workspaceId) {
					const current = () => !stopped && !work.explicit(workspaceId) &&
						entries.get(hint.agentId) === entry && entry.workspaceId === workspaceId;
					const restore = () => {
						if (!current()) return;
						void client.rpc(harnessStatusRpc, { agentId: hint.agentId, workspaceId }).then(identity => {
							if (!current()) return;
							if (!identity.available || !identity.sessionId) { retry(restore); return; }
							if (identity.sessionId === hint.sessionId) work.select(workspaceId, hint.agentId, true);
						}).catch(() => { if (current()) retry(restore); });
					};
					restore();
				}
			}
			const explicit = work.explicit(workspaceId);
			if (!agentId || !explicit || saving.get(workspaceId) === explicit) return;
			const entry = entries.get(agentId);
			if (entry?.workspaceId !== workspaceId) return;
			saving.set(workspaceId, explicit);
			const current = () => !stopped && work.explicit(workspaceId) === explicit &&
				work.selected(workspaceId) === agentId && entries.get(agentId) === entry;
			void client.rpc(harnessStatusRpc, { agentId, workspaceId }).then(async identity => {
				if (!current()) return;
				if (!identity.available || !identity.sessionId) {
					retry(() => { if (current()) { saving.delete(workspaceId); work.refresh(); } });
					return;
				}
				// Merge only this host/workspace. Revision conflicts preserve other
				// clients' hints rather than overwriting their concurrent writes.
				const sources = settings.values.sources.filter(source =>
					source.hostId !== props.host.id || source.workspaceId !== workspaceId);
				const saved = await settings.save({ sources: [...sources, {
					hostId: props.host.id, workspaceId, agentId, sessionId: identity.sessionId,
				}] }, settings.revision);
				if (!saved && current()) {
					await settings.reload();
					retry(() => { if (current()) { saving.delete(workspaceId); work.refresh(); } });
				}
			}).catch(() => { if (current()) retry(() => { if (current()) { saving.delete(workspaceId); work.refresh(); } }); });
		});
		if (!agentId) {
			return (
				<View style={{ flex: 1, padding: 16 }}>
					<Metadata colors={props.theme.colors}>
						Select Work from a conversation to view its work.
					</Metadata>
				</View>
			);
		}
		const entry = entries.get(agentId);
		const current = () =>
			!stopped && work.selected(workspaceId) === agentId &&
			entries.get(agentId) === entry && entry?.workspaceId === workspaceId;
		return (
			<WorkOverview
				{...props}
				key={JSON.stringify([props.host.id, workspaceId, agentId])}
				context="agent"
				agentId={agentId}
				view={work.view(workspaceId, agentId)}
				sourceTitle={entry?.title || "Conversation work"}
				resolveChildTitle={row => nativeChildTitle(row, id => nativeTitles.get(id))}
				openConversation={async (target) => {
					if (!current() || target.hostId !== props.host.id)
						throw new Error("The source conversation is no longer selected.");
					await conversations.open(target, current);
				}}
				openWorkspace={(id) => {
					if (current()) conversations.openWorkspace({ workspaceId: id, serverId: props.host.id });
				}}
			/>
		);
	}
	const panels = [
		client.addWorkspacePanel({
			id: "work",
			title: "Work",
			icon: "Briefcase",
			context: "workspace",
			locations: ["workspace"],
			Component: WorkPanel,
		}),
		client.addWorkspacePanel({
			id: "harness-jobs",
			title: "Background jobs",
			icon: "Terminal",
			context: "agent",
			locations: ["workspace"],
			Component: JobsPanel,
		}),
		client.addWorkspacePanel({
			id: "harness-subagents",
			title: "Subagents",
			icon: "Users",
			context: "agent",
			locations: ["workspace"],
			Component: SubagentsPanel,
		}),
		client.addWorkspacePanel({
			id: "pi-worktrees",
			title: "Worktrees",
			icon: "GitBranch",
			context: "agent",
			locations: ["workspace"],
			Component: WorktreesPanel,
		}),
		client.addWorkspacePanel({
			id: "pi-workflows",
			title: "Goals",
			icon: "Workflow",
			context: "agent",
			locations: ["workspace"],
			Component: WorkflowsPanel,
		}),
	];
	const remove = (id: string) => {
		const entry = entries.get(id);
		entry?.buttons.forEach((button) => button.remove());
		entries.delete(id);
		if (entry) { work.remove(entry.workspaceId, id); work.refresh(); }
	};
	const register = (agent: Agent) => {
		if (stopped) return;
		if (
			agent.provider !== "pi" ||
			agent.archivedAt ||
			!agent.workspaceId ||
			isDormantIndependentAgent(agent)
		) {
			remove(agent.id);
			return;
		}
		const existing = entries.get(agent.id);
		if (existing?.workspaceId === agent.workspaceId) {
			if (existing.title !== agent.title) {
				existing.title = agent.title;
				work.refresh();
			}
			return;
		}
		remove(agent.id);
		const workspaceId = agent.workspaceId;
		const entry = {
			workspaceId,
			title: agent.title,
			buttons: [] as PluginButtonRegistration[],
		};
		const report = (label: string) => {
			if (!stopped && entries.get(agent.id) === entry)
				entry.buttons[0]?.update({ label });
		};
		entry.buttons.push(
			client.addComposerPill({
				id: "work",
				workspaceId,
				agentId: agent.id,
				button: {
					title: "Work",
					label: "Work",
					icon: (props) => <WorkIndicator {...props} report={report} />,
					behavior: {
						kind: "action",
						onPress: () => {
							if (stopped || entries.get(agent.id) !== entry) return;
							work.select(workspaceId, agent.id);
							client.openPanel("work", { workspaceId, location: "workspace" });
						},
					},
				},
			}),
		);
		entries.set(agent.id, entry);
		work.refresh();
	};
	const updateNativeTitle = (agent: Agent) => {
		if (stopped) return;
		const old = nativeTitles.get(agent.id);
		if (agent.provider !== "pi" || agent.archivedAt || !agent.workspaceId) {
			if (nativeTitles.delete(agent.id)) work.refresh();
			return;
		}
		if (old?.workspaceId === agent.workspaceId && old.title === agent.title) return;
		nativeTitles.set(agent.id, { workspaceId: agent.workspaceId, title: agent.title });
		work.refresh();
	};
	const stopDirectory = observeAgentDirectory(client, {
		snapshot: agents => {
			const ids = new Set(agents.map(agent => agent.id));
			for (const id of nativeTitles.keys()) if (!ids.has(id)) nativeTitles.delete(id);
			for (const id of entries.keys()) if (!ids.has(id)) remove(id);
			for (const agent of agents) { updateNativeTitle(agent); register(agent); }
			hydrated = true;
			work.refresh();
		},
		upsert: agent => { updateNativeTitle(agent); register(agent); },
		remove: id => { nativeTitles.delete(id); remove(id); work.refresh(); },
	});
	return () => {
		stopped = true;
		stopDirectory();
		nativeTitles.clear();
		for (const timer of retries) clearTimeout(timer);
		for (const id of entries.keys()) remove(id);
		panels.forEach((dispose) => dispose());
		conversations.dispose();
	};
}

function JobsPanel(props: PluginAgentPanelProps) {
	return <HarnessPanel {...props} kind="jobs" />;
}
function SubagentsPanel(props: PluginAgentPanelProps) {
	return <HarnessPanel {...props} kind="subagents" />;
}
type JobScope = { agentId: string; workspaceId: string; host: { id: string } };
function useWorkSummary({ agentId, workspaceId, host }: JobScope) {
	const statusCall = useRpc(harnessStatusRpc),
		jobsCall = useRpc(harnessJobsListRpc),
		agentsCall = useRpc(harnessSubagentsListRpc),
		foregroundCall = useRpc(foregroundTasksStatusRpc);
	const target = { agentId, workspaceId };
	const identity = useQuery({
		queryKey: ["harness-status", agentId, workspaceId, host.id],
		queryFn: () => statusCall(target),
		refetchInterval: 5000,
		refetchOnReconnect: true,
	});
	const session = identity.data?.sessionId,
		epoch = identity.data?.runtimeEpoch;
	const ready =
		identity.data?.available === true &&
		!!session &&
		!!epoch &&
		!identity.isError;
	const bound = {
		...target,
		expectedSessionId: session!,
		expectedRuntimeEpoch: epoch!,
	};
	const jobs = useQuery({
		queryKey: [
			"harness-list",
			"jobs",
			agentId,
			workspaceId,
			session,
			epoch,
			host.id,
		],
		enabled: ready,
		queryFn: () => readJobs(cursor => jobsCall({ ...bound, limit: 50, ...(cursor ? { cursor } : {}) })),
		refetchInterval: 5000,
		refetchOnReconnect: true,
	});
	const agents = useQuery({
		queryKey: [
			"harness-list",
			"subagents",
			agentId,
			workspaceId,
			session,
			epoch,
			host.id,
		],
		enabled: ready,
		queryFn: () => readSubagents(cursor => agentsCall({ ...bound, includeDescendants: true, limit: 50, ...(cursor ? { cursor } : {}) })),
		refetchInterval: 5000,
		refetchOnReconnect: true,
	});
	const foreground = useQuery({
		queryKey: ["foreground-tasks", host.id, agentId, workspaceId],
		queryFn: () => foregroundCall(target),
		refetchInterval: 2000,
		refetchOnReconnect: true,
		staleTime: 1000,
	});
	const foregroundRows =
		!foreground.isError && foreground.data?.available
			? foreground.data.tasks
			: undefined;
	const foregroundIds = new Set(foregroundRows?.map((row) => row.taskId));
	const count = (
		rows: readonly { status: string; reaped?: boolean; needsAttention?: boolean }[] | undefined,
		agents = false,
	) => {
		const active = rows?.filter((row) => agents ? isActiveAgent(row) : isActiveWorkStatus(row.status)) ?? [];
		return {
			available: rows !== undefined,
			total: rows?.length ?? 0,
			active: active.length,
			waitingCount: active.filter((row) => row.status === "waiting").length,
			runningCount: active.filter((row) => ["starting", "launching", "pending", "running"].includes(row.status)).length,
			running: active.some((row) => ["starting", "launching", "pending", "running"].includes(row.status)),
			attention: active.some(
				(row) => row.needsAttention || /waiting|blocked|needs/.test(row.status),
			),
		};
	};
	return {
		jobs: count(
			ready && !jobs.isError && jobs.data?.state === "available"
				? jobs.data.items
				: undefined,
		),
		foreground: count(foregroundRows),
		foregroundIds,
		hierarchyMessage: agents.data?.hierarchyMessage,
		agents: count(
			ready && !agents.isError && agents.data?.state === "available"
				? [...groupSubagentAttempts(agents.data.items).values()].map(attempts => attempts[0]).filter(
						(row) =>
							row.kind !== "foreground" && !foregroundIds.has(row.taskId),
					)
				: undefined,
			true,
		),
	};
}
function WorkIndicator(
	props: PluginButtonIconProps & {
		report(label: string): void;
	},
) {
	if (props.context !== "agent") return null;
	return <MountedWorkIndicator {...props} />;
}
function MountedWorkIndicator(
	props: Extract<PluginButtonIconProps, { context: "agent" }> & {
		report(label: string): void;
	},
) {
	const summary = useWorkSummary(props);
	const runningJobs = summary.jobs.runningCount + summary.foreground.runningCount;
	const agents = summary.agents.runningCount,
		jobs = runningJobs || summary.jobs.active + summary.foreground.active;
	// Retain waiting tasks in Work without advertising idle-only work as spinning.
	const count = agents || runningJobs || Math.max(0, jobs - summary.jobs.waitingCount - summary.foreground.waitingCount);
	const attention = agents
		? summary.agents.attention
		: summary.jobs.attention || summary.foreground.attention;
	const label = agents
		? `${agents} working`
		: jobs
			? `${jobs} ${jobs === 1 ? "job" : "jobs"}`
			: "Work";
	useEffect(() => {
		props.report(label);
	}, [label, props.report]);
	return count ? (
		<WorkStatusRing
			attention={attention}
			foreground={props.theme.colors.foreground}
			platform={props.layout.platform}
		/>
	) : (
		<Icon name="Briefcase" size={props.size} color={props.color} />
	);
}
type CompletedView = { completed: boolean; toggleCompleted(): void };
function WorkOverview(
	props: PluginAgentPanelProps & {
		view: WorkViewState;
		sourceTitle: string;
		resolveChildTitle: ChildTitleResolver;
		openConversation(target: AgentConversationTarget): Promise<void>;
		openWorkspace(id: string): void;
	},
) {
	const summary = useWorkSummary(props);
	const [section, setSection] = useState<
		"jobs" | "agents" | "worktrees" | "goals"
	>(() => props.view.section ?? (
		summary.agents.active ? "agents" :
			summary.jobs.active || summary.foreground.active ? "jobs" : "goals"
	));
	const colors = props.theme.colors;
	const [completed, setCompleted] = useState(props.view.completed);
	props.view.section = section;
	props.view.completed = completed;
	const completedView = {
		completed,
		toggleCompleted: () => {
			props.view.completed = !completed;
			setCompleted(!completed);
		},
	};
	return (
		<View style={{ flex: 1, width: "100%", minWidth: 0, gap: 8 }}>
			<View
				accessibilityRole="tablist"
				style={{ flexDirection: "row", gap: 4, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}
			>
				{(["jobs", "agents", "worktrees", "goals"] as const).map((value) => (
					<Pressable
						key={value}
						accessibilityRole="tab"
						accessibilityState={{ selected: section === value }}
						onPress={() => {
							props.view.completed = false;
							props.view.section = value;
							setCompleted(false);
							setSection(value);
						}}
						style={({ pressed }) => ({
							backgroundColor: pressed ? colors.surface2 : "transparent",
							flex: 1,
							minWidth: 0,
							minHeight: 44,
							alignItems: "center",
							justifyContent: "center",
							paddingVertical: 10,
							paddingHorizontal: 4,
							borderBottomWidth: 2,
							borderBottomColor:
								section === value ? colors.foreground : "transparent",
						})}
					>
						<Text
							numberOfLines={1}
							style={{
								textAlign: "center",
								fontSize: 14,
								fontWeight: section === value ? "600" : "500",
								lineHeight: 20,
								color:
									section === value
										? colors.foreground
										: colors.foregroundMuted,
							}}
						>
							{value === "jobs"
								? "Jobs"
								: value === "agents"
									? "Agents"
									: value === "worktrees"
										? "Worktrees"
										: "Goals"}
						</Text>
					</Pressable>
				))}
			</View>
			<WorkScroll key={`${section}/${completed}`} view={props.view} scrollKey={`${section}/${completed}`}>
				{section === "jobs" ? (
					<JobsOverview {...props} {...completedView} />
				) : section === "agents" ? (
					<AgentsOverview {...props} {...completedView} />
				) : section === "worktrees" ? (
					<WorktreesSection {...props} onOpenWorkspace={props.openWorkspace} />
				) : (
					<WorkflowsSectionEmbed {...props} />
				)}
			</WorkScroll>
		</View>
	);
}
/** Native panel bodies are bounded, not scroll containers. Keep the section bar
 * fixed and retain each section's offset outside the mounted tab. */
function WorkScroll({ view, scrollKey, children }: {
	view: WorkViewState;
	scrollKey: string;
	children: ReactNode;
}) {
	const scroll = useRef<NativeScrollView | null>(null);
	const offset = useRef(view.scroll.get(scrollKey) ?? 0);
	const restoring = useRef(offset.current > 0);
	const viewportHeight = useRef(0);
	const contentHeight = useRef(0);
	const restore = () => {
		if (!restoring.current || !viewportHeight.current ||
			contentHeight.current - viewportHeight.current < offset.current) return;
		scroll.current?.scrollTo({ y: offset.current, animated: false });
		restoring.current = false;
	};
	return (
		<ScrollView
			ref={scroll}
			style={{ flex: 1, minWidth: 0 }}
			contentOffset={{ x: 0, y: offset.current }}
			scrollEventThrottle={16}
			onLayout={(event) => {
				viewportHeight.current = event.nativeEvent.layout.height;
				restore();
			}}
			onContentSizeChange={(_width, height) => {
				contentHeight.current = height;
				restore();
			}}
			onTouchStart={() => { restoring.current = false; }}
			onScrollBeginDrag={() => { restoring.current = false; }}
			onScroll={(event) => {
				// Loading placeholders can clamp the initial offset to zero. Keep
				// the saved position until hydrated content can accommodate it.
				if (!restoring.current) {
					offset.current = event.nativeEvent.contentOffset.y;
					view.scroll.set(scrollKey, offset.current);
				}
			}}
		>
			{children}
		</ScrollView>
	);
}
function WorkflowsSectionEmbed(
	props: PluginAgentPanelProps,
) {
	return <WorkflowsSection {...props} />;
}

function JobsOverview(
	props: PluginAgentPanelProps &
		CompletedView,
) {
	const { completed } = props;
	const summary = useWorkSummary(props);
	const mode = completed ? "completed" : "active";
	const foreground = completed
		? summary.foreground.total - summary.foreground.active
		: summary.foreground.active;
	const background = completed
		? summary.jobs.total - summary.jobs.active
		: summary.jobs.active;
	const available = summary.foreground.available && summary.jobs.available;
	const colors = props.theme.colors;
	const empty = !foreground && !background;

	const emptyLabel = available
		? completed
			? "No completed jobs"
			: "No active jobs"
		: "Loading job status…";
	return (
		<View style={{ width: "100%", gap: empty ? 0 : 8 }}>
			{foreground > 0 ? (
				<ForegroundTasksSection
					key={`foreground-${mode}`}
					{...props}
					viewMode={mode}
				/>
			) : null}
			{background > 0 ? (
				<HarnessPanel
					key={`background-${mode}`}
					{...props}
					kind="jobs"
					viewMode={mode}
					embedded
				/>
			) : null}
			{completed ? (
				empty ? (
					<Text style={{ color: colors.foregroundMuted, padding: 12 }}>
						{emptyLabel}
					</Text>
				) : null
			) : (
				<WorkAction
					label={empty ? emptyLabel : ""}
					actionLabel="Completed"
					onPress={props.toggleCompleted}
				/>
			)}
		</View>
	);
}

function AgentsOverview(
	props: PluginAgentPanelProps &
		CompletedView & {
			resolveChildTitle: ChildTitleResolver;
			openConversation(target: AgentConversationTarget): Promise<void>;
		},
) {
	const { completed } = props;
	const summary = useWorkSummary(props);
	const count = completed
		? summary.agents.total - summary.agents.active
		: summary.agents.active;
	const mode = completed ? "completed" : "active";
	const emptyLabel = summary.agents.available
		? completed ? "No completed agents" : "No active agents"
		: "Loading agent status…";
	return (
		<View style={{ width: "100%", gap: count ? 8 : 0 }}>
			{count > 0 ? <HarnessPanel
				key={mode}
				{...props}
				kind="subagents"
				viewMode={mode}
				excludeTaskIds={summary.foregroundIds}
				openConversation={props.openConversation}
				embedded
			/> : null}
			{completed ? (!count ? <Text style={{ color: props.theme.colors.foregroundMuted, padding: 12 }}>{emptyLabel}</Text> : null) : (
				<WorkAction label={count ? "" : emptyLabel} actionLabel="Completed" onPress={props.toggleCompleted} />
			)}
		</View>
	);
}

function elapsed(start: string, end?: string | null) {
	const milliseconds = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
	if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
	const seconds = Math.floor(milliseconds / 1000);
	return seconds < 60
		? `${seconds}s`
		: seconds < 3600
			? `${Math.floor(seconds / 60)}m`
			: `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

function HarnessPanel({
	kind,
	agentId,
	workspaceId,
	theme,
	layout,
	navigation,
	host,
	embedded = false,
	viewMode = "all",
	excludeTaskIds,
	openConversation,
	resolveChildTitle,
}: Omit<PluginAgentPanelProps, "navigation"> & {
	navigation?: PluginAgentPanelProps["navigation"];
	kind: Kind;
	embedded?: boolean;
	viewMode?: "all" | "active" | "completed";
	excludeTaskIds?: ReadonlySet<string>;
	openConversation?: (target: AgentConversationTarget) => Promise<void>;
	resolveChildTitle?: ChildTitleResolver;
}) {
	const statusCall = useRpc(harnessStatusRpc);
	const jobsCall = useRpc(harnessJobsListRpc);
	const tasksCall = useRpc(harnessSubagentsListRpc);
	const outputCall = useRpc(harnessJobsOutputRpc);
	const reportCall = useRpc(harnessSubagentReportRpc);
	const [selected, select] = useState<{
		id: string;
		attemptIdentity?: string;
		session: string;
		epoch: string;
	} | null>(null);
	const opening = useRef(false), mounted = useRef(true);
	const [openingId, setOpeningId] = useState<string>();
	const [openError, setOpenError] = useState<string>();
	// Keep status centers in list coordinates: row heights change when titles wrap or reports expand.
	const treeContainer = useRef<View>(null);
	const treeRowRefs = useRef(new Map<string, View>());
	const measureTreeRows = () => {
		if (!treeContainer.current || kind !== "subagents") return;
		for (const [key, node] of treeRowRefs.current) node.measureLayout(treeContainer.current, (x, y) => recordPoint(setTreeLayouts, key, { x, y }), () => {});
	};
	const [treeLayouts, setTreeLayouts] = useState<Record<string, TreeAnchor>>({});
	const [statusAnchors, setStatusAnchors] = useState<Record<string, TreeAnchor>>({});
	const recordPoint = (setter: typeof setTreeLayouts, key: string, point: TreeAnchor) => setter(previous => previous[key]?.x === point.x && previous[key]?.y === point.y ? previous : { ...previous, [key]: point });
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	const target = { agentId, workspaceId };
	const identity = useQuery({
		queryKey: ["harness-status", agentId, workspaceId, host.id],
		queryFn: () => statusCall(target),
		refetchInterval: 5000,
		refetchOnReconnect: true,
	});
	const session = identity.data?.sessionId;
	const epoch = identity.data?.runtimeEpoch;
	const ready =
		identity.data?.available === true &&
		!!session &&
		!!epoch &&
		!identity.isError;
	const bound = {
		...target,
		expectedSessionId: session!,
		expectedRuntimeEpoch: epoch!,
	};
	const list = useQuery({
		queryKey: [
			"harness-list",
			kind,
			agentId,
			workspaceId,
			session,
			epoch,
			host.id,
		],
		enabled: ready,
		queryFn: () =>
			kind === "jobs"
				? readJobs(cursor => jobsCall({ ...bound, limit: 50, ...(cursor ? { cursor } : {}) }))
				: readSubagents(cursor => tasksCall({ ...bound, includeDescendants: true, limit: 50, ...(cursor ? { cursor } : {}) })),

		refetchInterval: 5000,
		refetchOnReconnect: true,
	});
	const isActiveRow = (row: { status: string; reaped?: boolean }) =>
		kind === "subagents" ? isActiveAgent(row) : isActiveWorkStatus(row.status);
	const attemptGroups = groupSubagentAttempts((list.data?.items ?? []).filter((row): row is Extract<typeof row, { childId: string }> => "childId" in row));
	const selectedId =
		selected &&
		selected.session === session &&
		selected.epoch === epoch &&
		(kind !== "subagents" || (!!attemptGroups.get(selected.id)?.[0] && attemptIdentity(attemptGroups.get(selected.id)![0]) === selected.attemptIdentity)) &&
		(kind === "subagents" || viewMode === "all" ||
			list.data?.items.some(
				(row) =>
					("jobId" in row ? row.jobId : taskGroupKey(row)) === selected.id &&
					isActiveRow(row) === (viewMode === "active"),
			))
			? selected.id
			: undefined;
	const selectedAttempt = selectedId ? attemptGroups.get(selectedId)?.[0] : undefined;
	const detailBound = selectedAttempt?.source ? {
		agentId: selectedAttempt.source.agentId, workspaceId: selectedAttempt.source.workspaceId,
		expectedSessionId: selectedAttempt.source.sessionId, expectedRuntimeEpoch: selectedAttempt.source.runtimeEpoch,
	} : bound;
	const detail = useQuery({
		queryKey: [
			"harness-detail",
			kind,
			agentId,
			workspaceId,
			session,
			epoch,
			selectedId,
			host.id,
		],
		enabled: ready && !!selectedId && !(kind === "subagents" && openConversation),
		queryFn: () =>
			kind === "jobs"
				? outputCall({ ...bound, jobId: selectedId!, maxBytes: 24000 })
				: reportCall({ ...detailBound, taskId: selectedAttempt?.taskId ?? selectedId!, maxBytes: 24000 }),
		refetchInterval: 5000,
		refetchOnReconnect: true,
	});
	const fg = theme.colors.foreground,
		muted = theme.colors.foregroundMuted,
		danger = theme.colors.statusDanger;
	const button = (
		label: string,
		onPress: () => void,
		disabled = false,
		brief = false,
		status?: string,
		presentation?: { title: string; detail: string; expanded?: boolean; opensChat: boolean },
		anchorKey?: string,
	) => (
		<NativeRow
			colors={theme.colors}
			onLeadingAnchor={anchorKey ? point => recordPoint(setStatusAnchors, anchorKey, point) : undefined}
			title={presentation?.title ?? label}
			accessibilityLabel={label}
			detail={presentation?.detail ?? status}
			detailTone={status === "lost" || status === "failed" ? "danger" : undefined}
			expanded={presentation?.expanded}
			leading={status ? <View style={kind === "subagents" ? { width: 14, height: 14, alignItems: "center", justifyContent: "center" } : undefined}>{(['starting', 'launching', 'pending', 'running'].includes(status)
				? <View accessibilityLabel="Running"><WorkStatusRing attention={false} foreground={fg} platform={layout.platform} /></View>
				: <View accessibilityLabel={kind === "jobs" ? status : status === "lost" ? "Lost" : status === "failed" ? "Failed" : "Idle"} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: status === "lost" || status === "failed" ? danger : kind === "jobs" && status !== "completed" ? muted : theme.colors.statusSuccess }} />)}</View> : undefined}
			trailing={<Icon name={presentation?.opensChat ? "ArrowUpRight" : presentation?.expanded ? "ChevronUp" : "ChevronDown"} size={14} color={muted} />}
			disabled={disabled}
			onPress={onPress}
			style={{ paddingVertical: 8, minHeight: 44 }}
		/>
	);
	const primaryItems = kind === "subagents" ? [...attemptGroups.values()].map(attempts => attempts[0]) : list.data?.items ?? [];
	const tree = orderTaskTree([...attemptGroups.values()].map(attempts => attempts[0]).filter(row => row.kind !== "foreground" && !excludeTaskIds?.has(row.taskId)));
	const depths = new Map(tree.map(({ row, depth }) => [taskGroupKey(row), depth]));
	const retained = new Set<string>();
	const ancestors: string[] = [];
	for (const { row, depth } of tree) {
		ancestors.length = depth;
		ancestors[depth] = taskGroupKey(row);
		if (viewMode === "all" || isActiveRow(row) === (viewMode === "active")) for (const key of ancestors) retained.add(key);
	}
	const rows =
		ready && !list.isError && list.data?.state === "available"
			? (kind === "subagents" ? tree.map(entry => entry.row) : primaryItems).filter(
					(row) =>
						(kind !== "subagents" ||
							!("kind" in row) ||
							row.kind !== "foreground") &&
						(!("taskId" in row) || !excludeTaskIds?.has(row.taskId)) &&
						(kind === "subagents" && "taskId" in row ? retained.has(taskGroupKey(row)) : viewMode === "all" || isActiveRow(row) === (viewMode === "active")),
				)
			: [];
	type WorkerRow = Extract<(typeof rows)[number], { childId: string }>;
	const selectedWorker = kind === "subagents" && openConversation
		? rows.find((row): row is WorkerRow => "childId" in row && taskGroupKey(row) === selectedId && attemptIdentity(row) === selected?.attemptIdentity) : undefined;
	const workerTitle = (row: ChildTitleRow) => resolveChildTitle?.(row) ?? nativeChildTitle(row, () => undefined);
	const conversationTarget = (row: WorkerRow): AgentConversationTarget => ({ hostId: host.id, agentId: row.source?.agentId ?? agentId, workspaceId: row.source?.workspaceId ?? workspaceId,
		sessionId: row.source?.sessionId ?? session!, runtimeEpoch: row.source?.runtimeEpoch ?? epoch!, taskId: row.taskId, childId: row.childId, groupId: row.groupId, attempt: row.attempt, runtimeId: row.runtimeId, title: workerTitle(row) });
	const openWorker = (row: WorkerRow) => {
		if (!openConversation || opening.current) return;
		opening.current = true; setOpeningId(row.childId); setOpenError(undefined);
		void openConversation(conversationTarget(row))
			.catch(error => { if (mounted.current) setOpenError(error instanceof Error ? error.message.slice(0, 300) : "Could not open the conversation."); })
			.finally(() => { opening.current = false; if (mounted.current) setOpeningId(undefined); });
	};
	const item =
		ready && !detail.isError && detail.data?.state === "available"
			? detail.data.item
			: undefined;
	const taskLink =
		item && "paseoAgentId" in item ? item.paseoAgentId : undefined;
	const selectedDetail =
		selectedId && ready ? (
			<View style={{ gap: 8, padding: 10, paddingTop: 0, ...(kind === "subagents" && viewMode !== "completed" && selectedAttempt && rows.some(row => "childId" in row && row.parentKey === treeAttemptKey(selectedAttempt)) ? { paddingLeft: 30 } : {}) }}>
				{selectedWorker ? <>
					{selectedWorker.title !== workerTitle(selectedWorker) ? <Metadata colors={theme.colors}>Task: {selectedWorker.title}</Metadata> : null}
					<WorkerConversation key={JSON.stringify([session, epoch, selectedWorker.childId, selectedWorker.attempt, selectedWorker.runtimeId])}
						target={conversationTarget(selectedWorker)} epoch={conversationTarget(selectedWorker).runtimeEpoch} colors={theme.colors} platform={layout.platform} />
				</> : <>
				{detail.isPending ? (
					<Text style={{ color: muted }}>Loading selected item…</Text>
				) : null}
				{detail.isError ? (
					<Text style={{ color: danger }}>
						Selected item unavailable. Retrying automatically.
					</Text>
				) : null}
				{!detail.isPending && !detail.isError && !item ? (
					<Text style={{ color: muted }}>
						{detail.data?.message ??
							"No retained output or report is available."}
					</Text>
				) : null}
				{item ? (
					<>
						{item.truncated ? (
							<Text style={{ color: muted }}>Output truncated</Text>
						) : null}
						<OutputWell
							colors={theme.colors}
							text={item.text || "No output or answer recorded yet."}
							platform={layout.platform}
							maxHeight={320}
							monospace={kind === "jobs"}
						/>
					</>
				) : null}
				</>}
				{selectedWorker && openConversation
					? <NativeButton colors={theme.colors} label="Open child chat" disabled={!!openingId} onPress={() => openWorker(selectedWorker)} />
					: taskLink && navigation?.openAgent
						? <NativeButton colors={theme.colors} label="Open child chat" onPress={() => navigation.openAgent({ agentId: taskLink, serverId: host.id })} />
						: null}
				{selectedWorker && (attemptGroups.get(taskGroupKey(selectedWorker))?.length ?? 0) > 1 ? <AttemptHistory key={JSON.stringify([session, epoch, attemptIdentity(selectedWorker)])} rows={attemptGroups.get(taskGroupKey(selectedWorker))!.slice(1)} target={conversationTarget} colors={theme.colors} platform={layout.platform} /> : null}
			</View>
		) : null;
	const connectorRows = kind === "subagents" && viewMode !== "completed" ? rows.filter((row): row is WorkerRow => "childId" in row).map(row => ({ key: treeAttemptKey(row), parentKey: row.parentKey })) : [];
	const connectorAnchors = new Map(connectorRows.flatMap(({ key }) => {
		const layout = treeLayouts[key], anchor = statusAnchors[key];
		const row = rows.find(row => "childId" in row && treeAttemptKey(row) === key);
		const border = row && viewMode !== "completed" && !isActiveRow(row) && !(kind === "subagents" && viewMode === "active") ? 1 : 0;
		return layout && anchor ? [[key, { x: layout.x + anchor.x + border, y: layout.y + anchor.y + border, radius: row && ['starting', 'launching', 'pending', 'running'].includes(row.status) ? 7 : 4 }] as const] : [];
	}));
	const connectors = treeConnectors(connectorRows, connectorAnchors);
	const content = (
		<View
			ref={treeContainer}
			onLayout={kind === "subagents" ? measureTreeRows : undefined}
			style={{
				paddingHorizontal:
					embedded
						? 4
						: kind === "jobs" ? 16 : 12,
				paddingVertical:
					embedded && viewMode === "completed"
						? 0
						: embedded
							? 4
							: kind === "jobs" ? 16 : 12,
				gap: viewMode === "completed" ? 8 : 6,
			}}
		>
			{!embedded || (kind === "jobs" && viewMode !== "completed") ? (
				<Text accessibilityRole="header" style={{ color: fg, fontSize: 18 }}>
					{kind === "jobs" ? "Background" : "Subagents"}
				</Text>
			) : null}
			{identity.isPending ? (
				<Text style={{ color: muted }}>Connecting to this Pi session…</Text>
			) : null}
			{identity.isError ? (
				<Text style={{ color: danger }}>
					Session status unavailable. Retrying automatically.
				</Text>
			) : null}
			{!identity.isPending && !identity.isError && !ready ? (
				<Text style={{ color: muted }}>
					{identity.data?.reason ??
						"Read-only harness data unavailable. The Pi extensions and bridge may need reloading."}
				</Text>
			) : null}
			{ready && list.isPending ? (
				<Text style={{ color: muted }}>Loading…</Text>
			) : null}
			{ready && list.isError ? (
				<Text style={{ color: danger }}>
					This view is unavailable. Retrying automatically.
				</Text>
			) : null}
			{ready && (list.data?.state !== "available" || (kind === "jobs" && list.data?.message)) ? (
				<Text style={{ color: muted }}>{list.data?.message}</Text>
			) : null}
			{ready && !list.isError && list.data?.state === "available" && !rows.length ? (
				<Text style={{ color: muted }}>
					No {kind === "jobs" ? "background jobs" : viewMode === "completed" ? "reaped agents" : "retained agents"} in
					this session.
				</Text>
			) : null}
			{[...rows].sort((a, b) => Number("fromSubagent" in a && a.fromSubagent === true) - Number("fromSubagent" in b && b.fromSubagent === true)).map((row, index, ordered) => {
				const id = "jobId" in row ? row.jobId : taskGroupKey(row);
				const title = "jobId" in row ? row.name || row.jobId : workerTitle(row);
				const state = row.status === "completed" && viewMode === "completed"
					? "jobId" in row ? "Succeeded" : "Completed"
					: kind === "subagents" && viewMode === "active" && row.status === "completed"
						? "Idle" : row.status.replace(/[_-]/g, " ").replace(/^./, value => value.toUpperCase());
				const metadata = "jobId" in row
					? [state, elapsed(row.createdAt, ["starting", "running"].includes(row.status) ? null : row.updatedAt), row.observationOnly ? "Observation only" : ""].filter(Boolean).join(" · ")
					: [state, row.needsAttention ? "Needs attention" : ""].filter(Boolean).join(" · ");
				const label = "jobId" in row
					? `${row.name ?? row.jobId}${viewMode === "active" || row.status === "completed" ? "" : ` · ${row.status}`} · ${elapsed(row.createdAt, ["starting", "running"].includes(row.status) ? null : row.updatedAt)}${row.observationOnly ? " · observation only" : ""}`
					: `${title} · ${metadata}`;
				const opensChat = kind === "subagents" && viewMode === "completed" && !!openConversation && !("childId" in row && (attemptGroups.get(taskGroupKey(row))?.length ?? 0) > 1);
				return (
					<Fragment key={"childId" in row ? treeAttemptKey(row) : id}>
					{"fromSubagent" in row && row.fromSubagent === true && (index === 0 || !("fromSubagent" in ordered[index - 1] && ordered[index - 1].fromSubagent === true)) ? (
						<Text accessibilityRole="header" style={{ color: fg, fontSize: 18 }}>From subagents</Text>
					) : null}
					<View ref={kind === "subagents" && "childId" in row ? node => { const key = treeAttemptKey(row); if (node) treeRowRefs.current.set(key, node); else treeRowRefs.current.delete(key); } : undefined} onLayout={kind === "subagents" && "childId" in row ? event => { const { x, y } = event.nativeEvent.layout; recordPoint(setTreeLayouts, treeAttemptKey(row), { x, y }); measureTreeRows(); } : undefined} accessibilityLabel={"childId" in row ? `Agent hierarchy level ${(depths.get(id) ?? 0) + 1}` : undefined}
						style={{
							...("childId" in row ? { marginLeft: (depths.get(id) ?? 0) * 16 } : {}),
							...(viewMode !== "completed" && !isActiveRow(row) && !(kind === "subagents" && viewMode === "active")
								? {
										borderWidth: 1,
										borderColor:
											selectedId === id
												? theme.colors.foregroundMuted
												: theme.colors.border,
										borderRadius: kind === "jobs" ? 10 : 8,
										backgroundColor: theme.colors.surface1,
										overflow: "hidden",
										marginBottom: 0,
									}
								: {})
						}}
					>
						{viewMode === "completed" ? <SettingsAction
							label={title} hint={metadata}
							actionLabel={opensChat ? "Open" : selectedId === id ? "Hide" : "Details"}
							disabled={!!openingId}
							onPress={() => {
								if (opensChat && "childId" in row) openWorker(row);
								else select(selectedId === id ? null : { id, session: session!, epoch: epoch!, ...("childId" in row ? { attemptIdentity: attemptIdentity(row) } : {}) });
							}}
						/> : button(
							label,
							() => {
								if (opensChat && "childId" in row) openWorker(row);
								else select(selectedId === id ? null : { id, session: session!, epoch: epoch!, ...("childId" in row ? { attemptIdentity: attemptIdentity(row) } : {}) });
							},
							!!openingId,
							viewMode !== "completed",
							row.status,
							{ title, detail: metadata, opensChat, expanded: opensChat ? undefined : selectedId === id },
							kind === "subagents" && "childId" in row ? treeAttemptKey(row) : undefined,
						)}
						{selectedId === id ? selectedDetail : null}
					</View>
					</Fragment>
				);
			})}
			{connectors.length ? <View testID="work-tree-connectors" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
				{connectors.map((line, index) => <View key={index} style={{ position: "absolute", left: line.x, top: line.y, width: line.width, height: line.height, backgroundColor: theme.colors.border }} />)}
			</View> : null}
			{openingId ? <Text style={{ color: muted }}>Opening conversation…</Text> : null}
			{openError ? <Text accessibilityRole="alert" style={{ color: danger }}>{openError}</Text> : null}
		</View>
	);
	return embedded ? (
		content
	) : (
		<ScrollView style={{ flex: 1 }}>{content}</ScrollView>
	);
}

function AttemptHistory<T extends { taskId: string; childId: string; attempt: number; runtimeId: string | null; status: string }>({ rows, target, colors, platform }: {
 rows: T[]; target: (row: T) => AgentConversationTarget; colors: PluginWorkspacePanelProps["theme"]["colors"]; platform: string;
}) {
 const [expanded, setExpanded] = useState(false);
 const [selected, setSelected] = useState<string>();
 const row = rows.find(item => attemptIdentity(item) === selected);
 return <View style={{ paddingLeft: 16 }}>
  <NativeRow colors={colors} title={`Previous attempts (${rows.length})`} expanded={expanded} onPress={() => setExpanded(!expanded)} trailing={<Icon name={expanded ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} />} />
  {expanded ? rows.map(item => <NativeRow key={attemptIdentity(item)} colors={colors} title={`Attempt ${item.attempt}`} detail={item.status.replace(/[_-]/g, " ").replace(/^./, value => value.toUpperCase())} detailTone={item.status === "lost" || item.status === "failed" ? "danger" : undefined} expanded={selected === attemptIdentity(item)} onPress={() => setSelected(selected === attemptIdentity(item) ? undefined : attemptIdentity(item))} />) : null}
  {expanded && row ? <WorkerConversation key={attemptIdentity(row)} target={target(row)} epoch={target(row).runtimeEpoch} colors={colors} platform={platform} /> : null}
 </View>;
}
