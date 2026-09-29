import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useRpc, type PluginAgentPanelProps, type PluginClientContext, type PluginButtonRegistration } from "@getpaseo/plugin/client";
import { harnessStatusRpc, harnessJobsListRpc, harnessJobsOutputRpc, harnessSubagentsListRpc, harnessSubagentReportRpc } from "../shared/harness-readonly";

type Kind = "jobs" | "subagents";
type Agent = { id: string; workspaceId?: string | null; provider?: string; archivedAt?: string | null };

/** Registration is local to this installation. No polling or RPC until a view opens. */
export function contributeHarness(client: PluginClientContext) {
  const entries = new Map<string, { workspaceId: string; buttons: PluginButtonRegistration[] }>();
  const lifetime = new AbortController();
  let stopped = false;
  const panels = [
    client.addWorkspacePanel({ id: "harness-jobs", title: "Background jobs", icon: "Terminal", context: "agent", locations: ["workspace"], Component: JobsPanel }),
    client.addWorkspacePanel({ id: "harness-subagents", title: "Pi subagents", icon: "Users", context: "agent", locations: ["workspace"], Component: SubagentsPanel }),
  ];
  const remove = (id: string) => { entries.get(id)?.buttons.forEach(button => button.remove()); entries.delete(id); };
  const register = (agent: Agent) => {
    if (stopped) return;
    if (agent.provider !== "pi" || agent.archivedAt || !agent.workspaceId) { remove(agent.id); return; }
    if (entries.get(agent.id)?.workspaceId === agent.workspaceId) return;
    remove(agent.id);
    const workspaceId = agent.workspaceId;
    const buttons = (["jobs", "subagents"] as const).map(kind => client.addComposerPill({
      id: `harness-${kind}`, workspaceId, agentId: agent.id,
      button: { title: kind === "jobs" ? "Background jobs (read only)" : "Pi subagents (read only)",
        label: kind === "jobs" ? "Jobs" : "Pi subagents", icon: kind === "jobs" ? "Terminal" : "Users",
        behavior: { kind: "action", onPress: () => client.openPanel(`harness-${kind}`, { workspaceId, agentId: agent.id }) },
      },
    }));
    entries.set(agent.id, { workspaceId, buttons });
  };
  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (stopped) return;
    subscription.subscribe({
      snapshot: ({ entries: agents }) => {
        const ids = new Set(agents.map(({ agent }) => agent.id));
        for (const id of entries.keys()) if (!ids.has(id)) remove(id);
        for (const { agent } of agents) register(agent);
      },
      update: message => {
        if (message.type !== "agent_update") return;
        if (message.payload.kind === "remove") remove(message.payload.agentId); else register(message.payload.agent);
      },
    });
  }).catch(error => { if (!stopped) console.error("Read-only harness observation unavailable", error); });
  return () => { stopped = true; lifetime.abort(); for (const id of entries.keys()) remove(id); panels.forEach(dispose => dispose()); };
}

function JobsPanel(props: PluginAgentPanelProps) { return <HarnessPanel {...props} kind="jobs" />; }
function SubagentsPanel(props: PluginAgentPanelProps) { return <HarnessPanel {...props} kind="subagents" />; }

function elapsed(start: string, end?: string | null) {
  const milliseconds = (end ? Date.parse(end) : Date.now()) - Date.parse(start);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

function HarnessPanel({ kind, agentId, workspaceId, theme, navigation, host }: PluginAgentPanelProps & { kind: Kind }) {
  const statusCall = useRpc(harnessStatusRpc);
  const jobsCall = useRpc(harnessJobsListRpc);
  const tasksCall = useRpc(harnessSubagentsListRpc);
  const outputCall = useRpc(harnessJobsOutputRpc);
  const reportCall = useRpc(harnessSubagentReportRpc);
  const [selected, select] = useState<{ id: string; session: string; epoch: string } | null>(null);
  const target = { agentId, workspaceId };
  const identity = useQuery({ queryKey: ["harness-status", agentId, workspaceId], queryFn: () => statusCall(target), refetchInterval: 5000, refetchOnReconnect: true });
  const session = identity.data?.sessionId;
  const epoch = identity.data?.runtimeEpoch;
  const ready = identity.data?.available === true && !!session && !!epoch && !identity.isError;
  const bound = { ...target, expectedSessionId: session!, expectedRuntimeEpoch: epoch! };
  const list = useQuery({
    queryKey: ["harness-list", kind, agentId, workspaceId, session, epoch], enabled: ready,
    queryFn: () => kind === "jobs" ? jobsCall({ ...bound, limit: 50 }) : tasksCall({ ...bound, limit: 50 }),
    refetchInterval: 5000, refetchOnReconnect: true,
  });
  const selectedId = selected && selected.session === session && selected.epoch === epoch ? selected.id : undefined;
  const detail = useQuery({
    queryKey: ["harness-detail", kind, agentId, workspaceId, session, epoch, selectedId], enabled: ready && !!selectedId,
    queryFn: () => kind === "jobs" ? outputCall({ ...bound, jobId: selectedId!, maxBytes: 24000 }) : reportCall({ ...bound, taskId: selectedId!, maxBytes: 24000 }),
    refetchInterval: 5000, refetchOnReconnect: true,
  });
  const fg = theme.colors.foreground, muted = theme.colors.foregroundMuted, danger = theme.colors.statusDanger;
  const button = (label: string, onPress: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={{ padding: 10, opacity: disabled ? 0.5 : 1 }}><Text style={{ color: fg }}>{label}</Text></Pressable>;
  const rows = ready && !list.isError && list.data?.state === "available" ? list.data.items : [];
  const item = ready && !detail.isError && detail.data?.state === "available" ? detail.data.item : undefined;
  const taskLink = item && "paseoAgentId" in item ? item.paseoAgentId : undefined;
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, gap: 10 }}>
    <Text accessibilityRole="header" style={{ color: fg, fontSize: 18 }}>{kind === "jobs" ? "Background jobs" : "Pi subagents"} — read only</Text>
    <Text style={{ color: muted }}>Viewing does not consume notifications or change running work. Showing up to 50 items owned by this Pi session.</Text>
    {button("Refresh", () => { void identity.refetch(); if (ready) { void list.refetch(); if (selectedId) void detail.refetch(); } }, identity.isFetching || list.isFetching || detail.isFetching)}
    {identity.isPending ? <Text style={{ color: muted }}>Connecting to this Pi session…</Text> : null}
    {identity.isError ? <Text style={{ color: danger }}>Cannot read the session status. Reconnect or refresh.</Text> : null}
    {!identity.isPending && !identity.isError && !ready ? <Text style={{ color: muted }}>{identity.data?.reason ?? "Read-only harness data unavailable. The Pi extensions and bridge may need reloading."}</Text> : null}
    {ready && list.isPending ? <Text style={{ color: muted }}>Loading…</Text> : null}
    {ready && list.isError ? <Text style={{ color: danger }}>Cannot read this view. The session may have changed; refresh to retry.</Text> : null}
    {ready && list.data ? <Text style={{ color: muted }}>{list.data.stale ? "Retained snapshot" : "Observed state"}{list.data.lastUpdated ? ` · ${list.data.lastUpdated}` : " · update time unavailable"}</Text> : null}
    {ready && list.data?.state !== "available" ? <Text style={{ color: muted }}>{list.data?.message}</Text> : null}
    {ready && list.data?.state === "available" && !rows.length ? <Text style={{ color: muted }}>No {kind === "jobs" ? "background jobs" : "native subagent tasks"} in this session.</Text> : null}
    {rows.map(row => {
      const id = "jobId" in row ? row.jobId : row.taskId;
      const label = "jobId" in row ? `${row.name ?? row.jobId} · ${row.status} · ${elapsed(row.createdAt, ["starting", "running"].includes(row.status) ? null : row.updatedAt)}${row.observationOnly ? " · observation only" : ""}` : `${row.title} · ${row.status} · attempt ${row.attempt}`;
      return <View key={id}>{button(label, () => select({ id, session: session!, epoch: epoch! }))}</View>;
    })}
    {selectedId && ready ? <View style={{ gap: 8 }}>
      <Text style={{ color: fg }}>{kind === "jobs" ? "Output" : "Report"}: {selectedId}</Text>
      {detail.isPending ? <Text style={{ color: muted }}>Loading selected item…</Text> : null}
      {detail.isError ? <Text style={{ color: danger }}>Selected item unavailable. Refresh to retry.</Text> : null}
      {!detail.isPending && !detail.isError && !item ? <Text style={{ color: muted }}>{detail.data?.message ?? "No retained output or report is available."}</Text> : null}
      {item ? <><Text style={{ color: muted }}>{item.stale ? "Retained snapshot" : "Observed data"}{item.lastUpdated ? ` · ${item.lastUpdated}` : ""}{item.truncated ? " · truncated" : ""}</Text><Text selectable style={{ color: fg }}>{item.text || "No output or answer recorded yet."}</Text></> : null}
      {taskLink && navigation?.openAgent ? button("Open child chat", () => navigation.openAgent({ agentId: taskLink, serverId: host.id })) : null}
      {button("Close detail", () => select(null))}
    </View> : null}
  </ScrollView>;
}
