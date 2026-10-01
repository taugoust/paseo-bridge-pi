import { useQuery } from "@tanstack/react-query";
import { type PluginButtonContentProps, type PluginClientContext, type PluginButtonRegistration, useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { foregroundTasksRpc, foregroundTasksStatusRpc, type ForegroundTask, type ForegroundTaskCommand, type ForegroundTaskInteraction, type ForegroundTaskInteractionAnswer } from "../shared/foreground-tasks";

type Agent = { id: string; workspaceId?: string | null; provider?: string; archivedAt?: string | null };
type Memory = {
  selected?: ForegroundTask;
  drafts: Record<string, { text: string; revision: number }>;
  answers: Record<string, Record<string, string>>;
  requestIds: Record<string, string>;
  interactionRequests: Record<string, { id: string; answer: string }>;
  actions: Record<string, { token: string; operation: string }>;
  notices: Record<string, string>;
};
const memories = new Map<string, Memory>();
const memoryListeners = new Set<() => void>();
class RequestRejected extends Error {}
const taskKey = (task: Pick<ForegroundTask, "taskId" | "childId" | "workerEpoch">) => `${task.taskId}\0${task.childId}\0${task.workerEpoch}`;
const interactionKey = (target: string, interactionId: string) => `${target}\0${interactionId}`;
function memory(scope: string): Memory {
  let value = memories.get(scope);
  if (!value) { value = { drafts: {}, answers: {}, requestIds: {}, interactionRequests: {}, actions: {}, notices: {} }; memories.set(scope, value); }
  return value;
}
function notifyMemoryChanged() { for (const listener of memoryListeners) listener(); }
function requestId(): string {
  const crypto = (globalThis as any).crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

export function contributeForegroundTasks(client: PluginClientContext) {
  const entries = new Map<string, { agent: Agent; workspaceId: string; button: PluginButtonRegistration; sequence: number; refreshing: boolean }>();
  const lifetime = new AbortController();
  let stopped = false;
  const summarize = (tasks: ForegroundTask[] | undefined) => {
    const items = tasks ?? [];
    const running = items.filter(task => task.status === "running" || task.status === "pending").length;
    const questions = items.filter(task => task.status === "waiting-input").length;
    const permissions = items.filter(task => task.status === "waiting-permission").length;
    const finished = items.filter(task => ["completed", "failed", "cancelled", "lost", "reaped"].includes(task.status)).length;
    const waiting = questions + permissions;
    return {
      label: waiting ? `FG · ${running} · Q${questions} · P${permissions}` : running ? `FG · ${running}` : finished ? `FG · ✓${finished}` : "Foreground",
      title: `Foreground tasks · ${running} running/starting · ${questions} questions · ${permissions} permissions · ${finished} finished`,
    };
  };
  const refresh = async (entry: { agent: Agent; workspaceId: string; button: PluginButtonRegistration; sequence: number; refreshing: boolean }) => {
    if (stopped || entry.refreshing) return;
    entry.refreshing = true;
    const sequence = ++entry.sequence;
    try {
      const status = await client.rpc(foregroundTasksStatusRpc, { agentId: entry.agent.id, workspaceId: entry.workspaceId });
      if (stopped || entries.get(entry.agent.id) !== entry || entry.sequence !== sequence) return;
      entry.button.update(status.available ? summarize(status.tasks) : { label: "FG · ?", title: status.reason ?? "Foreground-task status unavailable" });
    } catch {
      if (!stopped && entries.get(entry.agent.id) === entry && entry.sequence === sequence) entry.button.update({ label: "FG · ?", title: "Foreground-task status unavailable" });
    } finally { entry.refreshing = false; }
  };
  const remove = (agentId: string) => { entries.get(agentId)?.button.remove(); entries.delete(agentId); };
  const register = (agent: Agent) => {
    if (stopped) return;
    if (agent.provider !== "pi" || agent.archivedAt || !agent.workspaceId) { remove(agent.id); return; }
    const existing = entries.get(agent.id);
    if (existing?.workspaceId === agent.workspaceId) { existing.agent = agent; return; }
    remove(agent.id);
    const button = client.addComposerPill({
      id: "foreground-tasks", workspaceId: agent.workspaceId, agentId: agent.id,
      button: { title: "Foreground tasks", label: "Foreground", icon: "MessagesSquare", behavior: { kind: "popover", Content: ForegroundTasksPopover } },
    });
    const entry = { agent, workspaceId: agent.workspaceId, button, sequence: 0, refreshing: false };
    entries.set(agent.id, entry);
    void refresh(entry);
  };
  const timer = setInterval(() => { for (const entry of entries.values()) void refresh(entry); }, 3000);
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
  }).catch(error => { if (!stopped) console.error("Foreground-task agent observation failed", error); });
  return () => { stopped = true; lifetime.abort(); clearInterval(timer); for (const id of entries.keys()) remove(id); };
}

function ForegroundTasksPopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") return <View />;
  return <ForegroundTasksView key={`${props.host.id}:${props.agentId}:${props.workspaceId}`} {...props} agentId={props.agentId} workspaceId={props.workspaceId} />;
}

function ForegroundTasksView({ agentId, workspaceId, host, theme, close }: PluginButtonContentProps & { agentId: string; workspaceId: string }) {
  const statusCall = useRpc(foregroundTasksStatusRpc);
  const controlCall = useRpc(foregroundTasksRpc);
  const status = useQuery({
    queryKey: ["foreground-tasks", host.id, agentId, workspaceId],
    queryFn: () => statusCall({ agentId, workspaceId }),
    refetchInterval: 2000, refetchOnReconnect: true, staleTime: 1000,
  });
  const parentSession = status.data?.sessionId;
  const runtimeEpoch = status.data?.runtimeEpoch;
  const memoryScope = `${host.id}\0${workspaceId}\0${agentId}\0${parentSession ?? "unresolved"}`;
  const saved = memory(memoryScope);
  const [boundMemoryScope, setBoundMemoryScope] = useState(memoryScope);
  const [selected, setSelected] = useState<ForegroundTask | undefined>(saved.selected);
  const [draft, setDraft] = useState(() => saved.selected ? saved.drafts[taskKey(saved.selected)]?.text ?? "" : "");
  const [message, setMessage] = useState<string | null>(null);
  const [, rerender] = useState(0);
  const mounted = useRef(true);
  const latestIdentity = useRef("");
  latestIdentity.current = parentSession && runtimeEpoch ? `${parentSession}\0${runtimeEpoch}` : "";
  useEffect(() => {
    mounted.current = true;
    const listener = () => rerender(version => version + 1);
    memoryListeners.add(listener);
    return () => { mounted.current = false; memoryListeners.delete(listener); };
  }, []);
  useEffect(() => {
    if (boundMemoryScope === memoryScope) return;
    const next = memory(memoryScope);
    setBoundMemoryScope(memoryScope);
    setSelected(next.selected);
    setDraft(next.selected ? next.drafts[taskKey(next.selected)]?.text ?? "" : "");
    setMessage(null);
  }, [boundMemoryScope, memoryScope]);
  const memoryReady = boundMemoryScope === memoryScope;
  const ready = memoryReady && status.data?.available === true && !!parentSession && !!runtimeEpoch && !status.isError;
  const currentTask = status.data?.tasks?.find(task => selected && taskKey(task) === taskKey(selected));
  const target = selected ? { taskId: selected.taskId, childId: selected.childId, workerEpoch: selected.workerEpoch } : undefined;
  const view = useQuery({
    queryKey: ["foreground-task-view", host.id, agentId, workspaceId, parentSession, runtimeEpoch, target],
    enabled: ready && !!target,
    queryFn: async () => {
      const result = await controlCall({ agentId, workspaceId, expectedSessionId: parentSession!, expectedRuntimeEpoch: runtimeEpoch!, request: { operation: "view", target: target! } });
      if (result.state !== "available" || result.sessionId !== parentSession || !result.view) throw new Error(result.message ?? "Task view unavailable");
      return result.view;
    },
    refetchInterval: 1000, refetchOnReconnect: true, staleTime: 900,
  });
  const themeColors = theme.colors;
  const style = useMemo(() => ({
    foreground: { color: themeColors.foreground }, muted: { color: themeColors.foregroundMuted }, danger: { color: themeColors.statusDanger },
    border: { borderColor: themeColors.border }, input: { color: themeColors.foreground, borderColor: themeColors.border, backgroundColor: themeColors.surface1 },
  }), [themeColors]);
  const selectedKey = selected ? taskKey(selected) : "";
  const busy = Boolean(selectedKey && saved.actions[selectedKey]);
  const uncertain = Boolean(selectedKey && saved.requestIds[`uncertain:${selectedKey}`]);
  const controlsReady = ready && !!view.data && !view.isError && !view.isStale && !view.isFetching && !!currentTask;
  const updateDraft = (value: string) => {
    setDraft(value);
    if (selected) {
      const key = taskKey(selected), prior = saved.drafts[key] ?? { text: "", revision: 0 };
      if (prior.text !== value) delete saved.requestIds[`prompt:${key}`];
      saved.drafts[key] = { text: value, revision: prior.revision + (prior.text === value ? 0 : 1) };
      notifyMemoryChanged();
    }
  };
  const selectTask = (task?: ForegroundTask) => {
    saved.selected = task;
    setSelected(task);
    setDraft(task ? saved.drafts[taskKey(task)]?.text ?? "" : "");
    setMessage(null);
    notifyMemoryChanged();
  };
  const run = async (request: ForegroundTaskCommand, submittedDraft?: { taskKey: string; text: string; revision: number }) => {
    if (!parentSession || !runtimeEpoch || !controlsReady || !selected || !("target" in request)) return;
    const actionKey = taskKey(request.target);
    if (saved.actions[actionKey]) return;
    const token = requestId(), expectedIdentity = `${parentSession}\0${runtimeEpoch}`;
    saved.actions[actionKey] = { token, operation: request.operation };
    delete saved.requestIds[`uncertain:${actionKey}`];
    delete saved.notices[actionKey];
    setMessage(null); notifyMemoryChanged();
    try {
      const result = await controlCall({ agentId, workspaceId, expectedSessionId: parentSession, expectedRuntimeEpoch: runtimeEpoch, request });
      if (latestIdentity.current !== expectedIdentity) {
        if (mounted.current) setMessage("The parent session changed while this request was running; stale results were discarded.");
        return;
      }
      if (result.state !== "available" || result.sessionId !== parentSession) throw new RequestRejected(result.message ?? "The task session changed.");
      if (["prompt", "respond", "stop"].includes(request.operation) && result.accepted !== true) throw new RequestRejected(result.message ?? "The task controller did not accept this action.");
      if (request.operation === "stop") delete saved.requestIds[`stop:${actionKey}`];
      const notice = request.operation === "prompt" ? "Message accepted and queued for the helper; it may wait until the current tool or interaction finishes."
        : request.operation === "respond" ? "Decision accepted." : request.operation === "stop" ? "Stop accepted." : undefined;
      if (notice) { saved.notices[actionKey] = notice; if (mounted.current) setMessage(notice); }
      if (request.operation === "prompt" && submittedDraft) {
        const current = saved.drafts[submittedDraft.taskKey];
        if (current?.revision === submittedDraft.revision && current.text === submittedDraft.text) {
          saved.drafts[submittedDraft.taskKey] = { text: "", revision: current.revision + 1 };
          delete saved.requestIds[`prompt:${submittedDraft.taskKey}`];
          if (saved.selected && taskKey(saved.selected) === submittedDraft.taskKey && mounted.current) setDraft("");
        }
      }
      await Promise.all([status.refetch(), view.refetch()]);
    } catch (error) {
      const knownRejected = error instanceof RequestRejected;
      if (!knownRejected) saved.requestIds[`uncertain:${actionKey}`] = request.operation;
      if (knownRejected) {
        if (request.operation === "prompt") delete saved.requestIds[`prompt:${actionKey}`];
        if (request.operation === "stop") delete saved.requestIds[`stop:${actionKey}`];
        if (request.operation === "respond") delete saved.interactionRequests[interactionKey(actionKey, request.interactionId)];
      }
      if (mounted.current) {
        setMessage(error instanceof Error ? error.message : "The task action could not be confirmed. Refresh to inspect current state.");
        void status.refetch(); void view.refetch();
      }
    } finally {
      if (saved.actions[actionKey]?.token === token) delete saved.actions[actionKey];
      notifyMemoryChanged();
    }
  };
  useEffect(() => {
    if (selected && currentTask?.canStop === false) delete saved.requestIds[`stop:${taskKey(selected)}`];
  }, [selected, currentTask, saved]);
  useEffect(() => {
    if (!selected || !view.data) return;
    const key = taskKey(selected), active = new Set(view.data.interactions.map(interaction => interactionKey(key, interaction.id)));
    for (const storedKey of Object.keys(saved.interactionRequests)) {
      if (storedKey.startsWith(`${key}\0`) && !active.has(storedKey)) {
        delete saved.interactionRequests[storedKey];
        delete saved.answers[storedKey];
      }
    }
  }, [selected, view.data, saved]);

  const activeInteractions = view.data?.interactions ?? [];
  const activeCurrentTask = currentTask;
  const button = (label: string, onPress: () => void, disabled = false, danger = false) => (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
      style={[{ padding: 10, borderWidth: 1, borderRadius: 6, opacity: disabled ? 0.5 : 1 }, style.border]}>
      <Text style={danger ? style.danger : style.foreground}>{label}</Text>
    </Pressable>
  );
  const targetFor = (item: ForegroundTask) => ({ taskId: item.taskId, childId: item.childId, workerEpoch: item.workerEpoch });

  return <View style={{ width: "100%", minWidth: 280, maxWidth: 420, maxHeight: 410, gap: 10, padding: 12 }}>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <Text accessibilityRole="header" style={[style.foreground, { fontSize: 18, fontWeight: "600" }]}>Foreground tasks</Text>
      {button("Close", close)}
    </View>
    {status.isPending ? <Text style={style.muted}>Connecting to this Pi session…</Text> : null}
    {status.isError ? <Text style={style.danger}>Could not read task state. Reconnect; pending decisions are not replayed.</Text> : null}
    {!status.isPending && !status.isError && !ready ? <Text style={style.muted}>{status.data?.reason ?? "Foreground-task control unavailable."}</Text> : null}
    {ready && !selected ? <View style={{ gap: 8 }}>
      {status.data?.tasks?.length ? status.data.tasks.slice(-40).map(task => <View key={taskKey(task)}>
        {task.workerEpoch
          ? button(`${task.title} · ${task.status}${task.model ? ` · ${task.model}` : ""}${task.pendingInteractions ? ` · ${task.pendingInteractions} awaiting you` : ""}`, () => selectTask(task))
          : <Text style={style.muted}>{task.title} · {task.status} · worker no longer available</Text>}
      </View>) : <Text style={style.muted}>No foreground helpers running for this parent session.</Text>}
    </View> : null}
    {selected ? <>
      {button("← Tasks", () => selectTask(undefined), busy)}
      <Text style={style.muted}>{selected.title} · {activeCurrentTask?.status ?? "checking"}{activeCurrentTask?.model ? ` · ${activeCurrentTask.model}` : ""}</Text>
      {view.isPending && !view.data ? <Text style={style.muted}>Loading conversation…</Text> : null}
      {view.isError ? <Text style={style.danger}>Conversation unavailable or stale; controls are disabled.</Text> : null}
      {!currentTask && ready ? <Text style={style.danger}>This helper is no longer in the active task list; its controls are disabled.</Text> : null}
      {activeInteractions.length ? <Text style={style.muted}>Needs your input</Text> : null}
      {activeInteractions.map(interaction => {
        const key = interactionKey(taskKey(selected), interaction.id);
        const values = saved.answers[key] ?? {};
        const updateValues = (update: (prior: Record<string, string>) => Record<string, string>) => {
          saved.answers[key] = update(saved.answers[key] ?? {});
          rerender(value => value + 1); notifyMemoryChanged();
        };
        return <InteractionCard key={`${interaction.id}:${interaction.workerEpoch}`} interaction={interaction}
          task={activeCurrentTask ?? selected} values={values} setValues={updateValues}
          disabled={!controlsReady || interaction.workerEpoch !== selected.workerEpoch}
          onAnswer={answer => {
            const encoded = JSON.stringify(answer), prior = saved.interactionRequests[key];
            if (prior && prior.answer !== encoded) { setMessage("A different answer for this request is already pending confirmation."); return; }
            const id = prior?.id ?? requestId();
            saved.interactionRequests[key] = { id, answer: encoded }; notifyMemoryChanged();
            void run({ operation: "respond", target: targetFor(selected), requestId: id, interactionId: interaction.id, answer });
          }} style={style} button={button} />;
      })}
      {activeCurrentTask?.canPrompt && ready ? <View style={{ gap: 6 }}>
        <TextInput accessibilityLabel="Message foreground helper" placeholder="Send a message" multiline value={draft} onChangeText={updateDraft}
          editable={!uncertain && controlsReady} placeholderTextColor={theme.colors.foregroundMuted}
          style={[style.input, { minHeight: 56, maxHeight: 120, borderWidth: 1, borderRadius: 6, padding: 8 }]} />
        {button("Send message", () => {
          const content = draft.trim(); if (!content) return;
          const key = taskKey(selected), record = saved.drafts[key] ?? { text: draft, revision: 0 };
          const idKey = `prompt:${key}`, id = saved.requestIds[idKey] ?? requestId(); saved.requestIds[idKey] = id;
          void run({ operation: "prompt", target: targetFor(selected), requestId: id, message: content }, { taskKey: key, text: record.text, revision: record.revision });
        }, busy || uncertain || !controlsReady || !draft.trim())}
      </View> : null}
      {activeCurrentTask?.canStop ? button("Stop helper", () => {
        const key = taskKey(selected), idKey = `stop:${key}`, id = saved.requestIds[idKey] ?? requestId(); saved.requestIds[idKey] = id;
        void run({ operation: "stop", target: targetFor(selected), requestId: id });
      }, busy || !controlsReady, true) : null}
      {busy ? <Text style={style.muted}>Applying…</Text> : null}
      {uncertain ? <Text style={style.danger}>The result is uncertain. It will not be replayed automatically.</Text> : null}
      {message || saved.notices[selectedKey] ? <Text accessibilityRole={message ? "alert" : undefined} style={message && uncertain ? style.danger : style.muted}>{message ?? saved.notices[selectedKey]}</Text> : null}
      {view.data ? <View style={{ gap: 8 }}>
        <Text accessibilityRole="header" style={[style.foreground, { fontWeight: "600" }]}>Recent activity · newest first</Text>
        {view.data.liveText ? <Text selectable style={style.foreground}>Current streaming excerpt: {view.data.liveText}</Text> : null}
        {view.data.messages.slice(-20).reverse().map(entry => <View key={entry.id} style={[{ padding: 8, borderBottomWidth: 1 }, style.border]}>
          <Text style={style.muted}>{entry.role}{entry.toolName ? ` · ${entry.toolName}` : ""}{entry.truncated ? " · message truncated" : ""}</Text>
          <Text selectable style={style.foreground}>{entry.text}</Text>
        </View>)}
        {view.data.messages.length > 20 ? <Text style={style.muted}>Showing the newest 20 of {view.data.messages.length} fetched messages; older page messages are omitted.</Text> : null}
        {view.data.truncated ? <Text style={style.muted}>{view.data.nextCursor ? "Earlier worker activity is available but not shown in this view." : "Earlier worker history was truncated and cannot be recovered."}</Text> : null}
      </View> : null}
    </> : null}
  </View>;
}

function InteractionCard({ interaction, task, values, setValues, disabled, onAnswer, style, button }: {
  interaction: ForegroundTaskInteraction; task: ForegroundTask; values: Record<string, string>;
  setValues: (update: (prior: Record<string, string>) => Record<string, string>) => void; disabled: boolean;
  onAnswer: (answer: ForegroundTaskInteractionAnswer) => void; style: { foreground: any; muted: any; danger: any; input: any; border: any };
  button: (label: string, onPress: () => void, disabled?: boolean, danger?: boolean) => any;
}) {
  if (interaction.workerEpoch !== task.workerEpoch) return <Text key={interaction.id} style={style.danger}>This pending request belongs to an expired worker and cannot be answered.</Text>;
  const request = interaction.request;
  return <View key={interaction.id} style={[{ gap: 8, padding: 10, borderWidth: 1, borderRadius: 6 }, style.border]}>
    <Text style={[style.foreground, { fontWeight: "600" }]}>{request.kind === "permission" ? request.title : "Questions from helper"}</Text>
    {request.kind === "permission" ? <>
      {request.detail ? <Text selectable style={style.muted}>{request.detail}</Text> : null}
      {request.options.map(option => button(option, () => onAnswer({ kind: "permission", cancelled: false, value: option }), disabled, /deny|reject/i.test(option)))}
      {button("Deny / cancel", () => onAnswer({ kind: "permission", cancelled: true }), disabled, true)}
    </> : request.questions.map(question => <View key={question.id} style={{ gap: 6 }}>
      <Text style={style.foreground}>{question.label ?? question.prompt}</Text>
      {question.label ? <Text style={style.muted}>{question.prompt}</Text> : null}
      {question.options.map(option => {
        const key = `${interaction.id}:${question.id}`;
        return button(`${values[key] === option.value ? "✓ " : ""}${option.label}`, () => setValues(prior => ({ ...prior, [key]: option.value })), disabled);
      })}
      {question.allowOther ? <TextInput accessibilityLabel={`Custom answer for ${question.label ?? question.prompt}`} placeholder="Other answer"
        value={question.options.some(option => option.value === values[`${interaction.id}:${question.id}`]) ? "" : values[`${interaction.id}:${question.id}`] ?? ""} onChangeText={value => setValues(prior => ({ ...prior, [`${interaction.id}:${question.id}`]: value }))}
        editable={!disabled} placeholderTextColor={style.muted.color} style={[style.input, { borderWidth: 1, borderRadius: 6, padding: 8 }]} /> : null}
    </View>)}
    {request.kind === "questionnaire" ? button("Submit answers", () => {
      const answers = request.questions.map(question => {
        const value = values[`${interaction.id}:${question.id}`] ?? "";
        const match = question.options.find(option => option.value === value);
        return { id: question.id, value, wasCustom: Boolean(value) && !match };
      });
      if (answers.some(answer => !answer.value.trim())) return;
      onAnswer({ kind: "questionnaire", cancelled: false, answers });
    }, disabled || request.questions.some(question => !(values[`${interaction.id}:${question.id}`] ?? "").trim())) : null}
    {request.kind === "questionnaire" ? button("Cancel questions", () => onAnswer({ kind: "questionnaire", cancelled: true, answers: [] }), disabled, true) : null}
  </View>;
}
