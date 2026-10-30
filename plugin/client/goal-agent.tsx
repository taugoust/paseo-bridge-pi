// AgentRow layout adapted from Progress client/ticket-dialog.tsx (MIT).
// Copyright (c) 2026 Steve Castaneda. See ../licenses/progress-MIT.txt.
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Text, View } from "react-native";
import { useAgent, useRpc, type PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { harnessStatusRpc, harnessSubagentsListRpc, harnessSubagentRouteRpc } from "../shared/harness-readonly";
import { recordedAgentDisplayName, type WorktreeAgentEvidence } from "../shared/worktree-agent";
import { goalAgentRoute, goalAgentEvidence } from "../shared/goal-agent";
import { PressableRow, goalWorkingColor } from "./goal-ticket-ui";
import type { DelegatedGoal } from "./delegated-goals";
import { useGoalText } from "./goal-language";

type Props = Pick<PluginAgentPanelProps, "host" | "agentId" | "workspaceId" | "theme"> & {
  child: NonNullable<DelegatedGoal["child"]>; sessionId: string; runtimeEpoch: string; onOpenAgent?: (id: string) => void;
};
const names = new Map<string, string>();
export function GoalAgent({ child, sessionId, runtimeEpoch, onOpenAgent, ...props }: Props) {
  const { t } = useGoalText();
  const status = useRpc(harnessStatusRpc), list = useRpc(harnessSubagentsListRpc), route = useRpc(harnessSubagentRouteRpc);
  const [pending, setPending] = useState(false), [error, setError] = useState<string>();
  const mounted = useRef(true), current = useRef("");
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const identity = JSON.stringify([props.host.id, props.agentId, props.workspaceId, sessionId, runtimeEpoch, child]);
  const query = useQuery({
    queryKey: ["pi-goal-agent", identity],
    queryFn: async () => {
      const bound = await status({ agentId: props.agentId, workspaceId: props.workspaceId });
      if (!bound.available || bound.sessionId !== sessionId || bound.runtimeEpoch !== runtimeEpoch) return null;
      const root = { agentId: props.agentId, workspaceId: props.workspaceId, sessionId, runtimeEpoch };
      const items: (WorktreeAgentEvidence & { status: string })[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 4; page++) {
        const result = await list({ agentId: props.agentId, workspaceId: props.workspaceId, expectedSessionId: sessionId, expectedRuntimeEpoch: runtimeEpoch, includeDescendants: false, limit: 50, cursor });
        if (result.state !== "available" || result.stale || result.sessionId !== sessionId || result.hierarchyPartial) return null;
        items.push(...result.items); cursor = result.nextCursor; if (!cursor) break;
      }
      const request = goalAgentRoute(child, root, items, !cursor);
      const item = goalAgentEvidence(child, root, items, !cursor);
      return item ? { request, item } : null;
    }, refetchInterval: 5000, staleTime: 0,
  });
  const evidence = !query.isError ? query.data : null;
  const native = useAgent(evidence?.item.paseoAgentId ?? "", agent => ({ id: agent.id, workspaceId: agent.workspaceId, title: agent.title }));
  const name = recordedAgentDisplayName({ ownerSessionId: sessionId, taskId: child.taskId, childId: child.childId },
    evidence?.item.paseoAgentId && evidence.item.paseoWorkspaceId ? { agentId: evidence.item.paseoAgentId, workspaceId: evidence.item.paseoWorkspaceId } : null, native);
  if (name) names.set(identity, name);
  const request = evidence?.request;
  const requestKey = JSON.stringify([identity, request]); current.current = requestKey;
  const colors = props.theme.colors;
  async function open() {
    if (!request || pending || !onOpenAgent) return;
    setPending(true); setError(undefined);
    try {
      const resolved = await route({ agentId: request.agentId, workspaceId: request.workspaceId, expectedSessionId: request.sessionId, expectedRuntimeEpoch: request.runtimeEpoch,
        taskId: request.taskId, childId: request.childId, groupId: request.groupId, runtimeId: request.runtimeId, attempt: request.attempt });
      if (mounted.current && current.current === requestKey) onOpenAgent(resolved.agentId);
    } catch { if (mounted.current && current.current === requestKey) setError(t("Chat unavailable. Try again.")); }
    finally { if (mounted.current) setPending(false); }
  }
  const observed = evidence?.item;
  const state = observed?.reaped && !["completed", "failed", "cancelled", "lost", "reaped"].includes(observed.status) ? undefined : observed?.status;
  const label = t(state ? ({ running: "Running", completed: "Completed", failed: "Failed", lost: "Lost", cancelled: "Stopped" }[state] ?? state) : "Status unknown");
  const rowStyle = { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 3, paddingHorizontal: 6, marginHorizontal: -6, borderRadius: 4, minHeight: 44 } as const;
  const content = <>
      <View accessibilityLabel={label} style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: state === "running" ? goalWorkingColor : state === "completed" ? colors.statusSuccess : state === "failed" || state === "lost" ? colors.statusDanger : colors.foregroundMuted }} />
      <Text numberOfLines={2} style={{ flexShrink: 1, color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{name ?? names.get(identity) ?? t("Goal agent")}</Text>
      <Text style={{ color: state === "completed" ? colors.statusSuccess : colors.foregroundMuted, fontSize: 12 }}>{state ? label : ""}</Text>
      <View style={{ flex: 1 }} />
      {request && onOpenAgent ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17, fontWeight: "500" }}>{t(pending ? "Opening…" : "Open chat")}</Text> : null}
    </>;
  return <View style={{ gap: 4 }}>
    {request && onOpenAgent ? <PressableRow colors={colors} onSurface1 disabled={pending} accessibilityRole="button" accessibilityLabel={t("Open chat")} onPress={() => void open()} style={rowStyle}>{content}</PressableRow>
      : <View style={rowStyle}>{content}</View>}
    {error ? <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: 12 }}>{error}</Text> : null}
  </View>;
}
