import { useState, useSyncExternalStore, type ReactNode } from "react";
import { GoalTicketRow, StatusBadge, TaskBar, TabStrip, StoryLog, goalWorkingColor, type StoryTab } from "./goal-ticket-ui";
import { Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { Metadata, NativeButton, type PresentationColors } from "./presentation";
import { openGoalForm } from "./goal-form";
import { GoalQuestions } from "./goal-questions";
import { assignedTickets, type AssignedTicket } from "./assigned-goals";
import type { z } from "zod";
import type { delegatedGoalEntrySchema, workflowSnapshotSchema } from "../shared/workflows";

/** The parent owns records; only the linked child owns execution. */
export type DelegatedGoal = z.infer<typeof delegatedGoalEntrySchema>;
export type DelegatedGoalRegistry = NonNullable<z.infer<typeof workflowSnapshotSchema>["delegatedGoals"]>;
type Ticket = (DelegatedGoal & { assigned?: false }) | AssignedTicket;
type Props = {
  assignedGoal?: z.infer<typeof workflowSnapshotSchema>["goal"];
  completedAssigned?: z.infer<typeof workflowSnapshotSchema>["completedGoals"];
  registry: DelegatedGoalRegistry;
  renderAgent?: (goal: DelegatedGoal) => ReactNode;
  colors: PresentationColors;
  identity: string;
  locked: boolean;
  busy: boolean;
  executionAvailable: boolean;
  limitsEditable?: boolean;
  model: string | null;
  limits: { automaticTurns: number | null; noProgressTurns: number | null };
  post(fields: Record<string, unknown>): Promise<false | { snapshot: { delegatedGoals?: DelegatedGoalRegistry } }>;
};
const terminal = (goal: Pick<DelegatedGoal, "status">) => goal.status === "complete" || goal.status === "cleared";
const drafts = new Map<string, ReturnType<typeof openGoalForm>>();
const draftRevisions = new Map<string, number | undefined>();
// Paseo can remount a workspace panel when its compact framing changes. Keep
// UI intent outside that framing, scoped to the exact session/service binding.
const viewStates = new Map<string, Record<string, unknown>>();
function useViewState<T,>(identity: string, name: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    const saved = viewStates.get(identity);
    return saved && name in saved ? saved[name] as T : initial;
  });
  return [value, (next: T) => {
    const saved = viewStates.get(identity) ?? {};
    saved[name] = next; viewStates.set(identity, saved); setValue(next);
  }] as const;
}
const editRevision = (goal: Ticket | undefined, limitsOnly: boolean) => limitsOnly ? goal?.policyRevision : goal?.revision;
function GoalForm({ colors, draftKey, goal, locked, limits, limitsOnly = false, onCancel, onSubmit }: {
  colors: PresentationColors; draftKey: string; goal?: Ticket; locked: boolean; limitsOnly?: boolean;
  limits: Props["limits"];
  onCancel?: () => void; onSubmit(objective: string, tokenBudget: number | undefined, openedRevision: number | undefined, continuationLimits: { automaticTurns: number | null; noProgressTurns: number | null }): Promise<boolean>;
}) {
  const [openedRevision] = useState(() => {
    if (!draftRevisions.has(draftKey)) draftRevisions.set(draftKey, editRevision(goal, limitsOnly));
    return draftRevisions.get(draftKey);
  });
  const [form] = useState(() => {
    let model = drafts.get(draftKey);
    if (!model) { model = openGoalForm({ objective: goal?.text, tokenBudget: goal?.tokenBudget, continuationLimits: goal?.continuationLimits }); drafts.set(draftKey, model); }
    return model;
  });
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  const stale = !!goal && editRevision(goal, limitsOnly) !== openedRevision;
  const input = { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface2,
    color: colors.foreground, paddingHorizontal: 12, paddingVertical: 12, fontSize: 14, lineHeight: 20 } as const;
  function close(notify = true) { form.close(); drafts.delete(draftKey); draftRevisions.delete(draftKey); if (notify) onCancel?.(); }
  return <View style={{ gap: limitsOnly ? 10 : 20, minWidth: 0, padding: 14, borderRadius: 8, backgroundColor: colors.surface0 }}>
    <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "500" }}>{limitsOnly ? "Edit limits" : goal ? "Edit goal" : "New goal"}</Text>
      {!goal ? <Metadata colors={colors}>Save an outcome. Start when you’re ready.</Metadata> : null}
    </View>
    {!limitsOnly ? <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>Outcome</Text>
      <TextInput accessibilityLabel={goal ? "Goal objective" : "New goal"} placeholder="What should be achieved?"
        placeholderTextColor={colors.foregroundMuted} value={state.objective} onChangeText={form.setObjective}
        multiline maxLength={4000} editable={!locked} style={[input, { minHeight: 144, textAlignVertical: "top" }]} />
      {state.objectiveError ? <Metadata colors={colors} alert style={{ color: colors.statusDanger }}>{state.objectiveError}</Metadata> : null}
    </View> : null}
    <View style={{ gap: 8, ...(!limitsOnly ? { maxWidth: 400 } : {}) }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>Token budget</Text>
      <TextInput accessibilityLabel="Goal token budget" placeholder="Unlimited" placeholderTextColor={colors.foregroundMuted}
        value={state.budget} onChangeText={form.setBudget} keyboardType="numeric" maxLength={7} editable={!locked} style={input} />
      <Metadata colors={colors} alert={!!state.budgetError} style={{ color: state.budgetError ? colors.statusDanger : colors.foregroundMuted }}>
        {state.budgetError ?? (goal ? "Applies to this goal only" : "Created paused • Choose Start when ready")}
      </Metadata>
    </View>
    <View style={{ gap: limitsOnly ? 8 : 12, ...(!limitsOnly ? { maxWidth: 400 } : {}) }}>
      {([ ["Automatic responses", "automaticTurns", form.setAutomaticTurns], ["No-progress responses", "noProgressTurns", form.setNoProgressTurns] ] as const).map(([label, key, set]) => <View key={key} style={{ gap: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>{label}</Text>
        <TextInput accessibilityLabel={`Goal ${label.toLowerCase()}`} placeholder={`Default: ${limits[key] ?? "Unlimited"}`} placeholderTextColor={colors.foregroundMuted}
          value={state[key]} onChangeText={set} keyboardType="numeric" maxLength={16} editable={!locked} style={input} />
      </View>)}
      <Metadata colors={colors} alert={!!state.limitsError}>{state.limitsError ?? (limitsOnly ? "Blank limits inherit configured defaults. Counters are preserved; exceeded limits pause at the next safe boundary." : "Leave empty to use the configured defaults")}</Metadata>
    </View>
    {stale ? <Metadata colors={colors} alert style={{ color: colors.statusWarning }}>This goal changed while you were editing. Cancel and reopen it to review the latest version.</Metadata> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <NativeButton colors={colors} primary label={goal ? "Save changes" : "Create"} disabled={locked || stale || !state.canSubmit}
        onPress={() => { if (locked || stale || !state.canSubmit) return; void onSubmit(state.objective.trim(), state.tokenBudget, openedRevision, state.continuationLimits).then(ok => { if (ok) { form.setObjective(""); form.setBudget(""); close(false); } }); }} style={{ minHeight: 44 }} />
      {onCancel ? <NativeButton colors={colors} label="Cancel" onPress={() => close()} disabled={locked} style={{ minHeight: 44, backgroundColor: "transparent" }} /> : null}
    </View>
  </View>;
}

export function DelegatedGoals({ registry, assignedGoal = null, completedAssigned = [], colors, identity, locked, busy, executionAvailable, limitsEditable = false, model, limits, post, renderAgent }: Props) {
  const allEntries: Ticket[] = [...registry.entries, ...assignedTickets(assignedGoal, completedAssigned)];
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useViewState<string | null>(identity, "selected", allEntries.length ? null : "new");
  const [history, setHistory] = useViewState<boolean>(identity, "history", false);
  const [selectionReview, setSelectionReview] = useViewState<boolean>(identity, "selectionReview", false);
  const [editing, setEditing] = useViewState<boolean>(identity, "editing", false);
  const [editingLimits, setEditingLimits] = useViewState<boolean>(identity, "editingLimits", false);
  const [clearConfirm, setClearConfirm] = useViewState<boolean>(identity, "clearConfirm", false);
  const [clearRevision, setClearRevision] = useViewState<number | undefined>(identity, "clearRevision", undefined);
  const [addingTask, setAddingTask] = useViewState<boolean>(identity, "addingTask", false);
  const [taskText, setTaskText] = useViewState<string>(identity, "taskText", "");
  const [tabs, setTabs] = useViewState<Record<string, StoryTab>>(identity, "storyTabs", {});
  const [expanded, setExpanded] = useViewState<Record<string, boolean>>(identity, "checklists", {});
  const wide = width >= 760;
  const entries = allEntries.filter(goal => terminal(goal) === history);
  // Assignment is independent of execution status. Only an authoritative child
  // link makes an entry delegated; paused children must stay in that list.
  const groups = [
    { title: "Unassigned", entries: entries.filter(entry => !entry.assigned && !entry.child) },
    { title: "Assigned", entries: entries.filter(entry => entry.assigned) },
    { title: "Delegated", entries: entries.filter(entry => !entry.assigned && !!entry.child) },
  ];
  const selection = selected === null && wide && !selectionReview ? entries[0]?.id ?? (history ? null : "new") : selected;
  const goal = allEntries.find(entry => entry.id === selection);
  const tab = goal ? tabs[goal.id] ?? "write-up" : "write-up";
  const disabled = locked || busy;
  const budgetExhausted = !!goal && goal.tokenBudget != null && goal.tokensUsed !== undefined && goal.tokensUsed >= goal.tokenBudget;
  const taskDraft = taskText.trim();
  const taskCapacity = !!goal && goal.tasks.length >= 50;
  const duplicateTask = !!goal && !!taskDraft && goal.tasks.some(task => task.text.trim() === taskDraft);
  const showDetail = wide || selection !== null;
  const showList = wide || selection === null;
  function select(id: string | null) {
    if ((editing || editingLimits) && goal) {
      const key = `${identity}/${editingLimits ? "limits" : "edit"}/${goal.id}`;
      drafts.get(key)?.close(); drafts.delete(key); draftRevisions.delete(key);
    }
    setSelected(id); setSelectionReview(false); setEditing(false); setEditingLimits(false); setClearConfirm(false); setAddingTask(false); setTaskText("");
  }
  async function action(name: string, fields: Record<string, unknown> = {}) {
    if (goal?.assigned || disabled || ((name === "start" || name === "resume") && (!executionAvailable || budgetExhausted))) return false;
    if (name === "answer" && (!goal?.child || goal.status !== "active")) return false;
    if (name === "add_task" && (!goal || taskCapacity || !taskDraft || duplicateTask || goal.status === "active" || terminal(goal))) return false;
    if (goal) setSelected(goal.id);
    return !!(await post({ operation: "start", action: `goals.${name}`, expectedGoalId: goal?.id ?? null,
      ...(name === "limits" ? {} : { expectedEntryRevision: goal?.revision }), ...fields }));
  }
  const button = (label: string, onPress: () => void, isDisabled = disabled) => <NativeButton colors={colors} danger={label === "Clear goal"} primary={label === "Start" || label === "Resume"} label={label} onPress={onPress} disabled={isDisabled} style={{ minHeight: 44, alignSelf: "flex-start", ...(!["Start", "Resume", "Clear goal"].includes(label) ? { backgroundColor: "transparent" } : {}) }} />;
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ minWidth: 0, minHeight: 480 }}>
    <View style={{ flexDirection: wide ? "row" : "column", minWidth: 0, alignItems: "stretch" }}>
      {showList ? <View style={{ width: wide ? 320 : "100%", flexShrink: 0, padding: 16, gap: 16,
        ...(wide ? { borderRightWidth: 1, borderRightColor: colors.border } : {}) }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: colors.foreground, fontWeight: "500", fontSize: 14, flex: 1 }}>{history ? "Goal history" : ""}</Text>
          <NativeButton colors={colors} label="New goal" onPress={() => { setHistory(false); select("new"); }} disabled={locked} style={{ minHeight: 44 }} />
        </View>
        {selectionReview ? <Metadata colors={colors}>Goal saved. Select an entry to review.</Metadata> : null}
        <View style={{ gap: 4 }}>
          {groups.map((group, index) => group.entries.length ? <View key={index} style={{ gap: 4 }}>
            {group.title ? <Text style={{ color: colors.foreground, fontWeight: "500", fontSize: 14, paddingTop: 12 }}>{group.title}</Text> : null}
            {group.entries.map(entry => <GoalTicketRow key={entry.id} colors={colors} title={entry.text} goal={entry}
              selected={selection === entry.id} onPress={() => select(entry.id)} />)}
          </View> : null)}
          {!entries.length ? <View style={{ paddingVertical: 24, gap: 8 }}>
              <Metadata colors={colors}>{history ? "No goal history yet" : "No goals yet"}</Metadata>
              {!history ? <Metadata colors={colors}>Save an outcome and track its checklist</Metadata> : null}
            </View> : null}
        </View>
        <NativeButton colors={colors} label={history ? "Current goals" : "History"} onPress={() => { setHistory(!history); select(null); }} style={{ alignSelf: "flex-start", backgroundColor: "transparent", minHeight: 44 }} />
      </View> : null}
      {showDetail ? <View style={{ flex: wide ? 1 : undefined, minWidth: 0, padding: wide ? 24 : 16, gap: 20 }}>
        {!wide ? <View style={{ alignSelf: "flex-start" }}>{button("Back to goals", () => select(null), false)}</View> : null}
        {selection === "new" ? <GoalForm key={`${identity}/create`} draftKey={`${identity}/create`} colors={colors} locked={disabled} limits={limits}
          onCancel={allEntries.length ? () => select(null) : undefined}
          onSubmit={async (objective, tokenBudget, _revision, continuationLimits) => {
            const known = new Set(registry.entries.map(entry => entry.id));
            const result = await post({ operation: "start", action: "goals.create", expectedGoalId: null,
              objective, continuationLimits, ...(tokenBudget === undefined ? {} : { tokenBudget }) });
            if (result) {
              // Another client may create an entry before the refreshed response.
              // Only auto-select an unambiguous new identity, never the last row
              // or an objective match among several independently-created goals.
              const created = result.snapshot.delegatedGoals?.entries.filter(entry => !known.has(entry.id)) ?? [];
              if (created.length === 1 && created[0].text === objective) select(created[0].id);
              else { select(null); setSelectionReview(true); }
            }
            return !!result;
          }} /> : goal ? editing && !goal.assigned ? <GoalForm key={`${identity}/edit/${goal.id}`} draftKey={`${identity}/edit/${goal.id}`} colors={colors} goal={goal} locked={disabled} limits={limits}
          onCancel={() => setEditing(false)} onSubmit={async (objective, tokenBudget, openedRevision, continuationLimits) => {
            const ok = await action("edit", { objective, expectedEntryRevision: openedRevision, tokenBudget: tokenBudget ?? null, continuationLimits });
            if (ok) setEditing(false); return ok;
          }} /> : <>
          {/* Adapted Progress TicketStoryView summary; not a modal or Explorer pane. */}
          <Text accessibilityRole="header" selectable style={{ color: colors.foreground, fontSize: 18, lineHeight: 26, fontWeight: "600" }}>{goal.text.split("\n")[0]}</Text>
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
              <StatusBadge colors={colors} status={goal.status} waiting={goal.waiting} />
              <Text style={{ flex: 1, minWidth: 100, color: colors.foreground, fontSize: 13, lineHeight: 18 }}>{goal.tasks.find(task => task.status === "in_progress")?.text ?? ""}</Text>
            </View>
            <TaskBar colors={colors} tasks={goal.tasks} />
            {goal.waiting ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{goal.waiting}</Text> : null}
            {goal.assigned ? <View style={{ gap: 4 }}>
              {goal.waiting ? <Metadata colors={colors}>{goal.waitDeadline === undefined ? "Wait deadline unavailable in this runtime" : goal.waitDeadline !== null ? `Safety wake: ${new Date(goal.waitDeadline).toLocaleString()} (when idle)` : "Waiting for an external message or explicit resume; no safety deadline"}</Metadata> : null}
              {goal.lastWake ? <Metadata colors={colors}>Last wake: {goal.lastWake.reason.replaceAll("_", " ")} · {new Date(goal.lastWake.at).toLocaleString()}</Metadata> : null}
              {goal.lastTaskUpdateAt != null ? <Metadata colors={colors}>Last checklist change: {new Date(goal.lastTaskUpdateAt).toLocaleString()}</Metadata> : null}
              {goal.lastBlocker ? <View style={{ gap: 4 }}><Metadata colors={colors}>Recorded blocker: {goal.lastBlocker.reason}</Metadata><Text selectable style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{goal.lastBlocker.evidence}</Text></View> : null}
            </View> : renderAgent?.(goal)}
          {!goal.assigned && !terminal(goal) ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {goal.status === "active" ? button("Pause", () => { void action("pause"); }, disabled) : button(goal.child ? "Resume" : "Start", () => { void action(goal.child ? "resume" : "start"); }, disabled || !executionAvailable || budgetExhausted)}
            {button("Edit", () => { setSelected(goal.id); setEditing(true); }, disabled || goal.status === "active")}
            {button("Clear", () => { setSelected(goal.id); setClearRevision(goal.revision); setClearConfirm(true); }, disabled || goal.status === "active")}
          </View> : null}
          </View>
          {!goal.assigned && !executionAvailable && !terminal(goal) ? <Metadata colors={colors}>Start and Resume are unavailable in this session</Metadata> : !goal.assigned && budgetExhausted && goal.status !== "active" && !terminal(goal) ? <Metadata colors={colors}>Raise or remove the token budget before resuming</Metadata> : null}
          {clearConfirm && !goal.assigned ? <Modal title="Clear goal?" open onOpenChange={setClearConfirm}><Modal.Content><View style={{ gap: 16 }}>
            <Text selectable style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>{goal.text}</Text>
            <Metadata colors={colors}>Clearing does not mark the goal complete. Its checklist remains in History.</Metadata>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {button("Keep goal", () => setClearConfirm(false), disabled)}
              {button("Clear goal", () => { void action("clear", { expectedEntryRevision: clearRevision }).then(ok => { if (ok) select(null); }); }, disabled || goal.status === "active" || terminal(goal) || goal.revision !== clearRevision)}
            </View>
          </View></Modal.Content></Modal> : null}
          <View style={{ paddingHorizontal: 12, paddingVertical: 8, gap: 2, backgroundColor: colors.surface0, borderRadius: 8 }}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "600", flex: 1 }}>Limits</Text>
              {!terminal(goal) ? button("Edit limits", () => { setSelected(goal.id); setEditingLimits(true); }, disabled || editingLimits || !limitsEditable || goal.policyRevision === undefined || (goal.assigned && !goal.activationId)) : null}
            </View>
            <Metadata colors={colors}>Automatic responses: {goal.automaticTurns ?? "Unavailable"} / {goal.assigned && goal.automaticTurns === undefined ? "Unavailable" : (goal.assigned ? goal.effectiveLimits?.automaticTurns : goal.continuationLimits?.automaticTurns) ?? limits.automaticTurns ?? "Unlimited"}</Metadata>
            <Metadata colors={colors}>Tokens: {goal.tokensUsed?.toLocaleString() ?? "Unavailable"} / {goal.tokenBudget === undefined ? "Unavailable" : goal.tokenBudget?.toLocaleString() ?? "Unlimited"}</Metadata>
            <Metadata colors={colors}>No-progress responses: {goal.noProgressTurns ?? "Unavailable"} / {goal.assigned && goal.noProgressTurns === undefined ? "Unavailable" : (goal.assigned ? goal.effectiveLimits?.noProgressTurns : goal.continuationLimits?.noProgressTurns) ?? limits.noProgressTurns ?? "Unlimited"}</Metadata>
            {!goal.assigned && goal.child?.model ? <Metadata colors={colors}>Launch model: {goal.child.model}</Metadata> : null}
          </View>
          {editingLimits && !terminal(goal) ? <GoalForm key={`${identity}/limits/${goal.id}`} draftKey={`${identity}/limits/${goal.id}`} colors={colors} goal={goal} locked={disabled} limits={limits} limitsOnly
            onCancel={() => setEditingLimits(false)} onSubmit={async (_objective, tokenBudget, openedRevision, continuationLimits) => {
              const ok = goal.assigned ? !!(await post({ operation: "start", action: "goal.limits", expectedGoalId: goal.sourceGoalId,
                expectedActivationId: goal.activationId, expectedPolicyRevision: openedRevision, tokenBudget: tokenBudget ?? null, continuationLimits }))
                : await action("limits", { expectedPolicyRevision: openedRevision, tokenBudget: tokenBudget ?? null, continuationLimits });
              if (ok) setEditingLimits(false); return ok;
            }} /> : null}
          <View style={{ gap: 12 }}>
          <TabStrip colors={colors} narrow={!wide} selected={tab} onSelect={next => { setSelected(goal.id); setTabs({ ...tabs, [goal.id]: next }); }} tabs={[
            { id: "write-up", label: "Write-up", icon: "FileText" },
            { id: "timeline", label: "Timeline", icon: "History", count: goal.story?.timeline.length },
            { id: "activity", label: "Activity", icon: "Activity", count: goal.story?.activity.length },
            { id: "questions", label: "Questions", icon: "MessageCircleQuestion", count: goal.story?.questions?.filter(question => question.status === "pending").length },
          ]} />
          {tab === "timeline" ? <StoryLog colors={colors} entries={goal.story?.timeline ?? []} timeline /> : null}
          {tab === "activity" ? <StoryLog colors={colors} entries={goal.story?.activity ?? []} /> : null}
          {tab === "questions" && goal.assigned ? <Metadata colors={colors}>No recorded questions available for this assigned goal</Metadata> : tab === "questions" && !goal.assigned ? <GoalQuestions colors={colors} questions={goal.story?.questions ?? []} identity={`${identity}/${goal.id}`} revision={goal.revision}
            disabled={disabled || terminal(goal) || goal.status !== "active" || !goal.child} onAnswer={(question, answer, openedRevision) => action("answer", {
              expectedEntryRevision: openedRevision, questionId: question.id, questionRevision: question.revision, workerEpoch: question.workerEpoch, answer,
            })} /> : null}
          {tab === "write-up" ? <View style={{ gap: 12, padding: 14, borderRadius: 8, backgroundColor: colors.surface0 }}>
            {goal.text.trim() !== goal.text.split("\n")[0].trim() ? <Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{goal.text}</Text> : null}
          <View style={{ gap: 12 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500", flex: 1 }}>Checklist</Text>
              <Metadata colors={colors}>{goal.tasks.filter(task => task.status === "completed").length} / {goal.tasks.length}</Metadata>
            </View>
            {goal.tasks.length ? (expanded[goal.id] ? goal.tasks : goal.tasks.slice(0, 5)).map((task, index) => <View key={task.id ?? index} accessible accessibilityLabel={`${task.text}: ${task.status.replaceAll("_", " ")}`} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
              <View style={{ paddingTop: 2 }}><Icon name={task.status === "completed" ? "Check" : task.status === "blocked" ? "Ban" : task.status === "in_progress" ? "CirclePlay" : "Circle"} size={14} color={task.status === "completed" ? colors.statusSuccess : task.status === "blocked" ? colors.statusDanger : task.status === "in_progress" ? goalWorkingColor : colors.foregroundMuted} /></View>
              <View style={{ flex: 1, minWidth: 0 }}><Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{task.text}</Text></View>
              {task.status === "blocked" ? <Text style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 19 }}>Blocked</Text> : null}
            </View>) : <Metadata colors={colors}>{goal.status === "active" ? "No tasks reported yet" : "No tasks yet"}</Metadata>}
            {goal.tasks.length > 5 ? button(expanded[goal.id] ? "Show fewer tasks" : `Show all ${goal.tasks.length} tasks`, () => setExpanded({ ...expanded, [goal.id]: !expanded[goal.id] }), false) : null}
            {!goal.assigned && !terminal(goal) && goal.status !== "active" ? button(addingTask ? "Cancel task" : "Add task", () => { setSelected(goal.id); setAddingTask(!addingTask); setTaskText(""); }, disabled || (!addingTask && taskCapacity)) : null}
            {addingTask && !goal.assigned ? <View style={{ gap: 8 }}>
              <TextInput accessibilityLabel="Subtask" value={taskText} onChangeText={setTaskText} editable={!disabled && goal.status !== "active" && !terminal(goal)} maxLength={503} placeholder="Describe a task" placeholderTextColor={colors.foregroundMuted}
                style={{ minHeight: 44, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, color: colors.foreground, backgroundColor: colors.surface2 }} />
              {taskCapacity ? <Metadata colors={colors}>50-task limit reached</Metadata> : duplicateTask ? <Metadata colors={colors} alert style={{ color: colors.statusDanger }}>That task is already in this goal</Metadata> : null}
              {button("Save task", () => { void action("add_task", { text: taskDraft }).then(ok => { if (ok) { setAddingTask(false); setTaskText(""); } }); }, disabled || taskCapacity || goal.status === "active" || terminal(goal) || !taskDraft || duplicateTask)}
            </View> : null}
          </View>
          {goal.summary ? <View style={{ gap: 8 }}><Text style={{ color: colors.foreground, fontWeight: "500", fontSize: 14 }}>Summary</Text><Text selectable style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 20 }}>{goal.summary}</Text></View> : null}
          </View> : null}
          </View>
        </> : <Metadata colors={colors}>{history && !entries.length ? "No goal history yet" : "Select a goal"}</Metadata>}
      </View> : null}
    </View>
  </View>;
}
