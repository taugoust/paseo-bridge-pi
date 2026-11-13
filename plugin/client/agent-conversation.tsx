import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollView as NativeScrollView } from "react-native";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { SettingsAction } from "@getpaseo/plugin/client/ui";
import { Metadata, NativeButton } from "./presentation";
import { NativeRunningTurnFooter, NativeToolBadge } from "./native-transcript";
import { mergeLiveToolEvents, preferredToolResult, preferredToolPresentation, selectedToolResultSource, literalToolResult } from "./native-tool-details";
import { isNativeScrollViewNearBottom } from "./native-transcript-model";
import { TranscriptMarkdown } from "./transcript-markdown";
import { workerTask } from "./worker-task";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { harnessSubagentConversationRpc } from "../shared/harness-readonly";
import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { harnessSubagentRouteRpc } from "../shared/harness-readonly";

export type AgentConversationTarget = {
  hostId: string; agentId: string; workspaceId: string; sessionId: string;
  taskId: string; childId: string; groupId: string; attempt: number; runtimeId: string | null; runtimeEpoch: string; title: string;
};

export function WorkerConversation({ target, epoch, colors, platform }: {
  target: AgentConversationTarget; epoch: string; colors: any; platform: any;
}) {
  const load = useRpc(harnessSubagentConversationRpc);
  const [cursor, setCursor] = useState<number | undefined>();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const scroll = useRef<NativeScrollView | null>(null);
  const following = useRef(true);
  const toggleTool = (id: string) => {
    // Expanding retained details is a reading action, not an instruction to jump to the live tail.
    following.current = false;
    setExpanded(current => ({ ...current, [id]: !current[id] }));
  };
  const conversation = useQuery({
    queryKey: ["worker-conversation", target.hostId, target.agentId, target.workspaceId, target.sessionId, epoch, target.taskId, target.childId, target.attempt, target.runtimeId, cursor],
    queryFn: () => load({ agentId: target.agentId, workspaceId: target.workspaceId,
      expectedSessionId: target.sessionId, expectedRuntimeEpoch: epoch,
      taskId: target.taskId, childId: target.childId, attempt: target.attempt, runtimeId: target.runtimeId, cursor }),
    refetchInterval: 1200, refetchOnReconnect: true,
  });
  const item = !conversation.isError && conversation.data?.state === "available" ? conversation.data.item : undefined;
  const liveTools = mergeLiveToolEvents(item?.liveEvents ?? []);
  const retainedResults = new Map((item?.messages ?? []).filter(message => message.role === "tool" && message.toolCallId).map(message => [message.toolCallId!, message]));
  const persistedCallIds = new Set((item?.messages ?? []).flatMap(message => (message.parts ?? []).flatMap(part => part.type === "toolCall" ? [part.id] : [])));
  const liveToolById = new Map(liveTools.map(event => [event.toolCallId, event]));
  const visibleCallIds = new Set([...persistedCallIds, ...liveTools.map(event => event.toolCallId)]);
  useEffect(() => { if (following.current) scroll.current?.scrollToEnd({ animated: false }); }, [cursor, item?.lastUpdated, item?.liveSequence, item?.liveText, item?.messages.length, item?.messages.at(-1)?.id, item?.messages.at(-1)?.text, item?.liveEvents?.length]);
  return <View testID="work-agent-conversation" style={{ gap: 8 }}>
    {conversation.isPending ? <Metadata colors={colors}>Loading conversation…</Metadata> : null}
    {conversation.isError ? <><Metadata colors={colors}>Conversation unavailable. Retrying automatically.</Metadata><NativeButton colors={colors} label="Retry conversation" onPress={() => { void conversation.refetch(); }} /></> : null}
    {!conversation.isPending && !conversation.isError && !item ? <Metadata colors={colors}>{conversation.data?.message ?? "No retained conversation is available."}</Metadata> : null}
    {item ? <View style={{ maxHeight: 320, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface0, overflow: "hidden" }}>
      <ScrollView ref={scroll} nestedScrollEnabled style={{ maxHeight: 320 }} contentContainerStyle={{ padding: 12 }}
        onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; following.current = isNativeScrollViewNearBottom({ offsetY: contentOffset.y, contentHeight: contentSize.height, viewportHeight: layoutMeasurement.height, threshold: 32 }); }}
        scrollEventThrottle={100} onContentSizeChange={() => { if (following.current) scroll.current?.scrollToEnd({ animated: false }); }}>
        {item.messages.map(message => {
          const showProse = ["user", "parent", "assistant"].includes(message.role) && !!message.text;
          const showResult = message.role === "tool" && (!message.toolCallId || !visibleCallIds.has(message.toolCallId));
          const showCalls = message.parts?.some(part => part.type === "toolCall");
          if (!showProse && !showResult && !showCalls && !message.truncated) return null;
          return <View key={message.id} style={{ gap: showProse ? 12 : 0, ...(showProse ? { marginVertical: 6 } : {}) }}>
          {message.role === "parent" && message.text && workerTask(message.text) ? <WorkerTask task={workerTask(message.text)!} colors={colors} /> : null}
          {(message.role === "user" || message.role === "parent") && message.text && !(message.role === "parent" && workerTask(message.text)) ? <View style={{ alignSelf: "flex-end", maxWidth: "88%", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.surface1 }}><TranscriptMarkdown text={message.text} colors={colors} platform={platform} /></View> : null}
          {message.role === "assistant" && message.text ? <TranscriptMarkdown text={message.text} colors={colors} platform={platform} /> : null}
          {message.role === "tool" && (!message.toolCallId || !visibleCallIds.has(message.toolCallId)) ? <NativeToolBadge
            name={message.toolName ?? "tool"} status={message.status ?? "unknown"}
            result={literalToolResult(message.text, message.resultFormat)} toolPresentation={message.toolPresentation} toolCallId={message.toolCallId} resultSource="history" colors={colors} expanded={!!expanded[message.toolCallId ?? message.id]}
            onToggle={() => toggleTool(message.toolCallId ?? message.id)} /> : null}
          {message.parts?.map(part => {
            if (part.type !== "toolCall") return null;
            const live = liveToolById.get(part.id);
            const retained = retainedResults.get(part.id);
            const args = part.toolArguments ?? live?.toolArguments ?? part.arguments ?? live?.arguments;
            // A correlated live completion can be newer than the retained page.
            const retainedResult = retained ? retained.text : part.result;
            const retainedPresentation = retained ? retained.toolPresentation : part.toolPresentation;
            const result = preferredToolResult(live?.result, retainedResult, live?.resultFormat, retained?.resultFormat ?? part.resultFormat);
            const toolPresentation = preferredToolPresentation(live?.result, retainedResult, live?.toolPresentation, retainedPresentation);
            return <NativeToolBadge key={`${message.id}:${part.id}`} name={part.name} argumentsValue={args} status={live?.status ?? retained?.status ?? part.status ?? "unknown"}
              result={result} toolPresentation={toolPresentation} toolCallId={part.id} resultSource={selectedToolResultSource(live?.result, retainedResult)} colors={colors}
              expanded={!!expanded[part.id]} onToggle={() => toggleTool(part.id)} />;
          })}
          {message.truncated ? <Metadata colors={colors}>[truncated]</Metadata> : null}
        </View>;
        })}
        {cursor == null && item.liveText ? <TranscriptMarkdown text={item.liveText} colors={colors} platform={platform} /> : null}
        {cursor == null ? liveTools.filter(event => !persistedCallIds.has(event.toolCallId)).map(event => <NativeToolBadge key={`live:${event.toolCallId}`} name={event.name} argumentsValue={event.toolArguments ?? event.arguments} status={event.status ?? "running"}
          result={preferredToolResult(event.result, retainedResults.get(event.toolCallId)?.text, event.resultFormat, retainedResults.get(event.toolCallId)?.resultFormat)}
          toolPresentation={preferredToolPresentation(event.result, retainedResults.get(event.toolCallId)?.text, event.toolPresentation, retainedResults.get(event.toolCallId)?.toolPresentation)}
          toolCallId={event.toolCallId} resultSource={selectedToolResultSource(event.result, retainedResults.get(event.toolCallId)?.text)} colors={colors}
          expanded={!!expanded[event.toolCallId]} onToggle={() => toggleTool(event.toolCallId)} />) : null}
        {cursor == null && item.execution === "running" ? <NativeRunningTurnFooter color={colors.foreground} /> : null}
        {!item.messages.length && !item.liveText ? <Metadata colors={colors}>No messages recorded yet.</Metadata> : null}
      </ScrollView>
    </View> : null}
    {item?.truncated ? <Metadata colors={colors}>Conversation excerpt</Metadata> : null}
    {item?.nextCursor != null ? <NativeButton colors={colors} label="Older messages" onPress={() => { following.current = true; setCursor(item.nextCursor); }} /> : null}
    {cursor != null ? <NativeButton colors={colors} label="Latest messages" onPress={() => { following.current = true; setCursor(undefined); }} /> : null}
  </View>;
}

/** Public plugin screens expose native navigation; composer popovers do not.
 * Native openAgent pops/dismisses this transient screen back to the workspace,
 * opening a normal agent tab rather than leaving a plugin log tab behind.
 */
function OpenIndependentConversation({ params, navigation, theme }: PluginScreenProps) {
  const opened = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string>();
  const agentId = params.agentId;
  const workspaceId = params.workspaceId;
  const serverId = params.serverId;
  const open = () => {
    if (workspaceId) {
      if (typeof workspaceId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(workspaceId) || (serverId != null && (typeof serverId !== "string" || !serverId || serverId.length > 1024))) { setError("Invalid workspace identity."); return; }
      if (!navigation?.openWorkspace) { setError("This Paseo client cannot navigate to the workspace."); return; }
      try { navigation.openWorkspace({ workspaceId, ...(typeof serverId === "string" ? { serverId } : {}) }); }
      catch { setError("Could not open the workspace."); }
      return;
    }
    if (!agentId || !/^[a-zA-Z0-9_-]{1,128}$/.test(agentId)) { setError("Invalid conversation identity."); return; }
    if (!navigation?.openAgent) { setError("This Paseo client cannot navigate to the conversation. It is available in the agent list."); return; }
    try { navigation.openAgent({ agentId }); }
    catch { setError("Could not open the conversation."); }
  };
  useEffect(() => {
    const target = JSON.stringify([agentId, workspaceId, serverId]);
    if (opened.current === target) return;
    opened.current = target;
    setError(undefined);
    open();
  }, [agentId, workspaceId, serverId, navigation]);
  return <View style={{ flex: 1, padding: 16, gap: 12 }}>
    <Metadata colors={theme.colors} style={{ color: error ? theme.colors.statusWarning : theme.colors.foregroundMuted }}>{error ?? (workspaceId ? "Opening workspace…" : "Opening conversation…")}</Metadata>
    {error && (navigation?.openAgent || navigation?.openWorkspace) ? <SettingsAction label="" actionLabel={workspaceId ? "Open workspace" : "Open conversation"} onPress={open} /> : null}
  </View>;
}

export function createAgentConversationTabs(client: PluginClientContext) {
  const pending = new Map<string, Promise<void>>();
  let disposed = false;
  let selectedTarget: string | undefined;
  const disposeScreen = client.addScreen({ id: "independent-conversation", title: "Conversation", Component: OpenIndependentConversation });
  return {
    openWorkspace(target: { workspaceId: string; serverId?: string }): void {
      if (disposed) return;
      selectedTarget = `workspace:${target.workspaceId}`;
      client.openScreen({ screenId: "independent-conversation", params: { workspaceId: target.workspaceId, ...(target.serverId ? { serverId: target.serverId } : {}) } });
    },
    open(target: AgentConversationTarget, isCurrent: () => boolean = () => true): Promise<void> {
      if (disposed) return Promise.reject(new Error("Conversation navigation is unavailable"));
      const key = JSON.stringify(target);
      selectedTarget = key;
      const existing = pending.get(key);
      if (existing) return existing;
      const operation = (async () => {
        if (!target.runtimeId) throw new Error("No existing live child conversation is registered.");
        const route = await client.rpc(harnessSubagentRouteRpc, {
          agentId: target.agentId, workspaceId: target.workspaceId,
          expectedSessionId: target.sessionId, expectedRuntimeEpoch: target.runtimeEpoch,
          taskId: target.taskId, childId: target.childId, groupId: target.groupId, attempt: target.attempt, runtimeId: target.runtimeId,
        });
        if (disposed || !isCurrent() || selectedTarget !== key) throw new Error("The source conversation is no longer selected.");
        client.openScreen({ screenId: "independent-conversation", params: { agentId: route.agentId } });
      })().finally(() => { pending.delete(key); });
      pending.set(key, operation);
      return operation;
    },
    dispose() { disposed = true; disposeScreen(); },
  };
}

/** A worker's task and acceptance criteria, without the harness's fixed reporting instructions. */
function WorkerTask({ task, colors }: { task: { task: string; acceptance: string[] }; colors: any }) {
  return <View style={{ gap: 4 }}>
    <Metadata colors={colors}>Task</Metadata>
    <Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{task.task}</Text>
    {task.acceptance.length ? <View style={{ gap: 2, paddingTop: 4 }}>
      <Metadata colors={colors}>Done when</Metadata>
      {task.acceptance.map((item, index) => <Text key={index} selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>• {item}</Text>)}
    </View> : null}
  </View>;
}
