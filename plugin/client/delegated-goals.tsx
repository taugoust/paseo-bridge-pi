import { useState, useSyncExternalStore, type ReactNode } from "react";
import { PressableRow, StatusBadge, TaskBar, StoryLog, goalWorkingColor, recordedGoalStatus } from "./goal-ticket-ui";
import { WorkStatusRing } from "./work-status-ring";
import { CompletedHeading, WorkEmpty } from "./work-layout";
import { Platform, Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { Icon, Modal } from "@getpaseo/plugin/client/ui";
import { Metadata, NativeRow, type PresentationColors } from "./presentation";
import { GoalButton as NativeButton, useGoalText } from "./goal-language";
import { openGoalForm } from "./goal-form";
import { GoalQuestions, type GoalQuestion } from "./goal-questions";
import { assignedTickets, type AssignedTicket } from "./assigned-goals";
import { GoalRecordedDetails } from "./goal-recorded-details";
import { GoalPlanning } from "./goal-planning";
import type { z } from "zod";
import type { delegatedGoalEntrySchema, workflowSnapshotSchema } from "../shared/workflows";
import { GoalPullRequests } from "./goal-prs";

/** The parent owns records; only the linked child owns execution. */
export type DelegatedGoal = z.infer<typeof delegatedGoalEntrySchema>;
export type DelegatedGoalRegistry = NonNullable<z.infer<typeof workflowSnapshotSchema>["delegatedGoals"]>;
type SavedGoalPresentation = DelegatedGoal & { binding: "unassigned" | "subagent"; assigned?: false; sourceId: string; reactKey: string };
type CurrentSessionGoalPresentation = AssignedTicket;
/** One presentation contract for both goal sources; binding alone governs owner-specific capabilities. */
type GoalPresentation = SavedGoalPresentation | CurrentSessionGoalPresentation;
type Ticket = GoalPresentation;
const isCurrentSession = (goal: Ticket): goal is CurrentSessionGoalPresentation => goal.binding === "current-session";
export function savedPresentation(goal: DelegatedGoal): SavedGoalPresentation {
  return { ...goal, binding: goal.child ? "subagent" : "unassigned", sourceId: goal.id, reactKey: `catalog:${goal.id}` };
}
type Props = {
  assignedGoal?: z.infer<typeof workflowSnapshotSchema>["goal"];
  completedAssigned?: z.infer<typeof workflowSnapshotSchema>["completedGoals"];
  registry: DelegatedGoalRegistry;
  renderAgent?: (goal: DelegatedGoal) => ReactNode;
  renderReview?: (goal: DelegatedGoal) => ReactNode;
  renderQuestionAttachments?: (goal: DelegatedGoal, question: GoalQuestion) => ReactNode;
  colors: PresentationColors;
  identity: string;
  locked: boolean;
  busy: boolean;
  executionAvailable: boolean;
  limitsEditable?: boolean;
  planningAvailable?: boolean;
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
  onCancel?: () => void; onSubmit(objective: string, tokenBudget: number | undefined, openedRevision: number | undefined, continuationLimits: { automaticTurns: number | null; noProgressTurns: number | null }, tasks: string[]): Promise<boolean>;
}) {
  const { t } = useGoalText();
  const [tasks, setTasks] = useState<string[]>([]);
  const [taskDraft, setTaskDraft] = useState("");
  const addDraft = () => {
    const text = taskDraft.trim();
    if (!text || tasks.includes(text) || tasks.length >= 50) return;
    setTasks([...tasks, text]); setTaskDraft("");
  };
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
      <Text style={{ color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "500" }}>{t(limitsOnly ? "Edit limits" : goal ? "Edit goal" : "New goal")}</Text>
      {!goal ? <Metadata colors={colors}>{t("Save an outcome. Start when you’re ready.")}</Metadata> : null}
    </View>
    {!limitsOnly ? <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>{t("Outcome")}</Text>
      <TextInput accessibilityLabel={t(goal ? "Goal objective" : "New goal")} placeholder={t("What should be achieved?")}
        placeholderTextColor={colors.foregroundMuted} value={state.objective} onChangeText={form.setObjective}
        multiline maxLength={4000} editable={!locked} style={[input, { minHeight: 144, textAlignVertical: "top" }]} />
      {state.objectiveError ? <Metadata colors={colors} alert style={{ color: colors.statusDanger }}>{t(state.objectiveError)}</Metadata> : null}
    </View> : null}
    {!goal && !limitsOnly ? <View style={{ gap: 8 }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>{t("Tasks")}</Text>
      <Metadata colors={colors}>{t("Optional. The checklist the goal should cover. More can be added later.")}</Metadata>
      {tasks.map((task, index) => <View key={task} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
        <Icon name="Circle" size={14} color={colors.foregroundMuted} />
        <Text style={{ flex: 1, color: colors.foreground, fontSize: 14, lineHeight: 20 }}>{task}</Text>
        <NativeButton colors={colors} label="Remove" onPress={() => setTasks(tasks.filter((_, i) => i !== index))}
          style={{ backgroundColor: "transparent", borderColor: "transparent", paddingVertical: 2, paddingHorizontal: 6 }} />
      </View>)}
      <View style={{ flexDirection: "row", gap: 8 }}>
        <TextInput accessibilityLabel={t("New task")} placeholder={t("Add a task and press Enter")} placeholderTextColor={colors.foregroundMuted}
          value={taskDraft} onChangeText={setTaskDraft} onSubmitEditing={addDraft} blurOnSubmit={false} maxLength={503} editable={!locked}
          style={[input, { flex: 1, paddingVertical: 8 }]} />
        <NativeButton colors={colors} label="Add" onPress={addDraft} disabled={locked || !taskDraft.trim() || tasks.includes(taskDraft.trim())} />
      </View>
    </View> : null}
    <View style={{ gap: 8, ...(!limitsOnly ? { maxWidth: 400 } : {}) }}>
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>{t("Token budget")}</Text>
      <TextInput accessibilityLabel={t("Goal token budget")} placeholder={t("Unlimited")} placeholderTextColor={colors.foregroundMuted}
        value={state.budget} onChangeText={form.setBudget} keyboardType="numeric" maxLength={7} editable={!locked} style={input} />
      <Metadata colors={colors} alert={!!state.budgetError} style={{ color: state.budgetError ? colors.statusDanger : colors.foregroundMuted }}>
        {t(state.budgetError ?? (goal ? "Applies to this goal only" : "Created paused • Choose Start when ready"))}
      </Metadata>
    </View>
    <View style={{ gap: limitsOnly ? 8 : 12, ...(!limitsOnly ? { maxWidth: 400 } : {}) }}>
      {([ ["Automatic responses", "automaticTurns", form.setAutomaticTurns], ["No-progress responses", "noProgressTurns", form.setNoProgressTurns] ] as const).map(([label, key, set]) => <View key={key} style={{ gap: 8 }}>
        <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: "500" }}>{t(label)}</Text>
        <TextInput accessibilityLabel={t(`Goal ${label.toLowerCase()}`)} placeholder={t("Default: {{value}}",{value:limits[key] ?? t("Unlimited")})} placeholderTextColor={colors.foregroundMuted}
          value={state[key]} onChangeText={set} keyboardType="numeric" maxLength={16} editable={!locked} style={input} />
      </View>)}
      <Metadata colors={colors} alert={!!state.limitsError}>{t(state.limitsError ?? (limitsOnly ? "Blank limits inherit configured defaults. Counters are preserved; exceeded limits pause at the next safe boundary." : "Leave empty to use the configured defaults"))}</Metadata>
    </View>
    {stale ? <Metadata colors={colors} alert style={{ color: colors.statusWarning }}>{t("This goal changed while you were editing. Cancel and reopen it to review the latest version.")}</Metadata> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <NativeButton colors={colors} primary label={goal ? "Save changes" : "Create"} disabled={locked || stale || !state.canSubmit}
        onPress={() => { if (locked || stale || !state.canSubmit) return; void onSubmit(state.objective.trim(), state.tokenBudget, openedRevision, state.continuationLimits, tasks).then(ok => { if (ok) { form.setObjective(""); form.setBudget(""); setTasks([]); close(false); } }); }} style={{ minHeight: 44 }} />
      {onCancel ? <NativeButton colors={colors} label="Cancel" onPress={() => close()} disabled={locked} style={{ minHeight: 44, backgroundColor: "transparent" }} /> : null}
    </View>
  </View>;
}

export function DelegatedGoals({ registry, assignedGoal = null, completedAssigned = [], colors, identity, locked, busy, executionAvailable, limitsEditable = false, planningAvailable = false, model, limits, post, renderAgent, renderReview, renderQuestionAttachments }: Props) {
  const { t, time } = useGoalText();
  const allEntries: Ticket[] = [
    ...registry.entries.map(savedPresentation),
    ...assignedTickets(assignedGoal, completedAssigned),
  ];
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useViewState<string | null>(identity, "selected", null);
  const [history, setHistory] = useViewState<boolean>(identity, "history", false);
  const [selectionReview, setSelectionReview] = useViewState<boolean>(identity, "selectionReview", false);
  const [editing, setEditing] = useViewState<boolean>(identity, "editing", false);
  const [editingLimits, setEditingLimits] = useViewState<boolean>(identity, "editingLimits", false);
  const [clearConfirm, setClearConfirm] = useViewState<boolean>(identity, "clearConfirm", false);
  const [clearRevision, setClearRevision] = useViewState<number | undefined>(identity, "clearRevision", undefined);
  const [addingTask, setAddingTask] = useViewState<boolean>(identity, "addingTask", false);
  const [taskText, setTaskText] = useViewState<string>(identity, "taskText", "");
  const [expanded, setExpanded] = useViewState<Record<string, boolean>>(identity, "checklists", {});
  const [detailsOpen, setDetailsOpen] = useViewState<Record<string, boolean>>(identity, "details", {});
  const narrow = width > 0 && width < 600;
  const current = allEntries.filter(goal => !terminal(goal));
  const finished = allEntries.filter(terminal);
  // The list groups goals by what they are doing, like Jobs and Agents.
  const waitingGoal = (goal: Ticket) => goal.status === "blocked" || goal.status === "usage_limited" || goal.status === "budget_limited"
    || (goal.status === "active" && (!!goal.waiting || !!goal.story?.questions?.some(question => question.status === "pending")));
  const groups = [
    { title: "Running", entries: current.filter(goal => goal.status === "active" && !waitingGoal(goal)) },
    { title: "Waiting", entries: current.filter(waitingGoal) },
    { title: "Not started", entries: current.filter(goal => goal.status === "paused") },
  ];
  const selection = selected;
  const goal = allEntries.find(entry => entry.id === selection);
  const disabled = locked || busy;
  const budgetExhausted = !!goal && goal.tokenBudget != null && goal.tokensUsed !== undefined && goal.tokensUsed >= goal.tokenBudget;
  const taskDraft = taskText.trim();
  const taskCapacity = !!goal && goal.tasks.length >= 50;
  const duplicateTask = !!goal && !!taskDraft && goal.tasks.some(task => task.text.trim() === taskDraft);
  const [moreOpen, setMoreOpen] = useState(false);
  function select(id: string | null) {
    if ((editing || editingLimits) && goal) {
      const key = `${identity}/${editingLimits ? "limits" : "edit"}/${goal.id}`;
      drafts.get(key)?.close(); drafts.delete(key); draftRevisions.delete(key);
    }
    setSelected(id); setSelectionReview(false); setEditing(false); setEditingLimits(false); setClearConfirm(false); setAddingTask(false); setTaskText(""); setMoreOpen(false);
  }
  async function action(name: string, fields: Record<string, unknown> = {}) {
    if ((goal && isCurrentSession(goal)) || disabled || ((name === "start" || name === "resume") && (!executionAvailable || budgetExhausted))) return false;
    if (name === "answer" && (!goal?.child || goal.status !== "active")) return false;
    if (name === "add_task" && (!goal || taskCapacity || !taskDraft || duplicateTask || goal.status === "active" || terminal(goal))) return false;
    if (goal) setSelected(goal.id);
    return !!(await post({ operation: "start", action: `goals.${name}`, expectedGoalId: goal?.id ?? null,
      ...(name === "limits" ? {} : { expectedEntryRevision: goal?.revision }), ...fields }));
  }
  const small = { paddingVertical: 4, paddingHorizontal: 10 } as const;
  const button = (label: string, onPress: () => void, isDisabled = disabled) => <NativeButton colors={colors} danger={label === "Clear goal"}
    primary={label === "Start" || label === "Resume"} label={label} onPress={onPress} disabled={isDisabled} style={small} />;
  const back = <PressableRow colors={colors} accessibilityRole="button" accessibilityLabel={t("Back to goals")} onPress={() => select(null)}
    style={{ flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", paddingVertical: 4, paddingRight: 8, borderRadius: 6 }}>
    <Icon name="ChevronLeft" size={14} color={colors.foregroundMuted} />
    <Metadata colors={colors}>{t("Goals")}</Metadata>
  </PressableRow>;
  const section = (key: string, title: string, count: number | undefined, children: ReactNode, defaultOpen = false) => {
    const id = `${goal?.id}/${key}`, open = detailsOpen[id] ?? defaultOpen;
    return <View style={{ gap: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 }}>
      <PressableRow colors={colors} accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open}
        onPress={() => setDetailsOpen({ ...detailsOpen, [id]: !open })}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, borderRadius: 6 }}>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={colors.foregroundMuted} />
        <Text style={{ color: colors.foreground, fontWeight: "500", fontSize: 14 }}>{t(title)}</Text>
        {count !== undefined ? <Metadata colors={colors}>{count}</Metadata> : null}
      </PressableRow>
      {open ? <View style={{ gap: 12, paddingLeft: 20 }}>{children}</View> : null}
    </View>;
  };

  // A new goal: the form, with a way back.
  if (selection === "new") return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ minWidth: 0, gap: 16 }}>
    {allEntries.length ? back : null}
    <GoalForm key={`${identity}/create`} draftKey={`${identity}/create`} colors={colors} locked={disabled} limits={limits}
      onCancel={() => select(null)}
      onSubmit={async (objective, tokenBudget, _revision, continuationLimits, tasks) => {
        const known = new Set(registry.entries.map(entry => entry.id));
        const result = await post({ operation: "start", action: "goals.create", expectedGoalId: null,
          objective, continuationLimits, ...(tokenBudget === undefined ? {} : { tokenBudget }) });
        if (result) {
          // Another client may create an entry before the refreshed response.
          // Only auto-select an unambiguous new identity, never the last row
          // or an objective match among several independently-created goals.
          const created = result.snapshot.delegatedGoals?.entries.filter(entry => !known.has(entry.id)) ?? [];
          if (created.length === 1 && created[0].text === objective) {
            let entry: DelegatedGoal | undefined = created[0];
            for (const text of tasks) {
              if (!entry) break;
              const added = await post({ operation: "start", action: "goals.add_task", expectedGoalId: entry.id, expectedEntryRevision: entry.revision, text });
              entry = added ? added.snapshot.delegatedGoals?.entries.find(item => item.id === created[0].id) : undefined;
            }
            select(created[0].id);
          } else { select(null); setSelectionReview(true); }
        }
        return !!result;
      }} />
  </View>;

  // The list: goals grouped like Jobs and Agents, finished goals collapsed at the bottom.
  if (!goal) {
    if (!current.length && !history) return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ minWidth: 0 }}>
      <WorkEmpty colors={colors} icon="Target" title={t("No goals yet")}
        hint={t("A goal is an outcome with a checklist. Save one now and start it when you're ready.")}>
        <NativeButton colors={colors} primary label={t("New goal")} onPress={() => select("new")} disabled={locked} />
      </WorkEmpty>
      {finished.length ? <CompletedHeading colors={colors} count={finished.length} open={false} onPress={() => setHistory(true)} /> : null}
    </View>;
    const visible = groups.filter(group => group.entries.length);
    return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ minWidth: 0, gap: 20 }}>
      {selectionReview ? <Metadata colors={colors}>{t("Goal saved. Select an entry to review.")}</Metadata> : null}
      {visible.length ? visible.map((group, index) => <View key={group.title} style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", minHeight: 30 }}>
          <Metadata colors={colors} style={{ flex: 1, paddingHorizontal: 4 }}>{t(group.title)}</Metadata>
          {index === 0 ? <NativeButton colors={colors} label="New goal" onPress={() => select("new")} disabled={locked} style={small} /> : null}
        </View>
        <GoalList colors={colors} entries={group.entries} onSelect={select} />
      </View>) : <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <NativeButton colors={colors} label="New goal" onPress={() => select("new")} disabled={locked} style={small} />
      </View>}
      {finished.length ? <View style={{ gap: 8 }}>
        <CompletedHeading colors={colors} count={finished.length} open={history} onPress={() => setHistory(!history)} />
        {history ? <GoalList colors={colors} entries={finished} onSelect={select} /> : null}
      </View> : null}
    </View>;
  }

  // Editing the objective replaces the page with the form.
  if (editing && !goal.assigned) return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ minWidth: 0, gap: 16 }}>
    {back}
    <GoalForm key={`${identity}/edit/${goal.id}`} draftKey={`${identity}/edit/${goal.id}`} colors={colors} goal={goal} locked={disabled} limits={limits}
      onCancel={() => setEditing(false)} onSubmit={async (objective, tokenBudget, openedRevision, continuationLimits) => {
        const ok = await action("edit", { objective, expectedEntryRevision: openedRevision, tokenBudget: tokenBudget ?? null, continuationLimits });
        if (ok) setEditing(false); return ok;
      }} />
  </View>;

  // The goal page: one plain document at full width.
  // Once a goal is finished, tasks it didn't complete are no longer in progress or blocked.
  const tasks = terminal(goal) ? goal.tasks.map(task => task.status === "completed" ? task : { ...task, status: "pending" as const }) : goal.tasks;
  const pendingQuestions = goal.story?.questions?.filter(question => question.status === "pending").length ?? 0;
  const story = [...(goal.story?.timeline ?? []), ...(goal.story?.activity ?? [])].sort((a, b) => a.at - b.at);
  const owner = isCurrentSession(goal) ? t("This chat") : goal.child ? [t("Coordinator"), goal.child.model].filter(Boolean).join(" · ") : t("Saved");
  // This chat's own goal: Pi pauses or resumes it, and asks for confirmation before resuming.
  const chatGoalAction = async (name: "pause" | "resume") => {
    if (disabled || !goal.assigned) return;
    await post({ operation: "start", action: `goal.${name}`, expectedGoalId: goal.sourceGoalId });
  };
  // Older sessions can't run these actions, so their goals stay read-only.
  const actions = goal.assigned && !terminal(goal) && !locked ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
    {goal.status === "active" ? button("Pause", () => { void chatGoalAction("pause"); })
      : button("Resume", () => { void chatGoalAction("resume"); })}
  </View> : !goal.assigned && !terminal(goal) ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
    {goal.status === "active" ? button("Pause", () => { void action("pause"); })
      : button(goal.child ? "Resume" : "Start", () => { void action(goal.child ? "resume" : "start"); }, disabled || !executionAvailable || budgetExhausted)}
    <NativeButton colors={colors} label="···" onPress={() => setMoreOpen(!moreOpen)} style={small} />
  </View> : null;
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ minWidth: 0, gap: 20 }}>
    {back}
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" selectable style={{ color: colors.foreground, fontSize: 20, lineHeight: 28, fontWeight: "600" }}>{goal.text.split("\n")[0]}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <StatusBadge colors={colors} status={goal.status} waiting={goal.waiting} observation={goal.assigned ? undefined : goal.observation} />
        <Metadata colors={colors}>{owner}{goal.assigned && goal.endedAt ? ` · ${time(goal.endedAt)}` : ""}</Metadata>
        {goal.assigned ? null : renderAgent?.(goal)}
      </View>
      {goal.text.trim() !== goal.text.split("\n")[0].trim() ? <Text selectable style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{goal.text}</Text> : null}
      {goal.waiting ? <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{goal.waiting}</Text> : null}
    </View>
    <View style={{ flexDirection: narrow ? "column" : "row", alignItems: narrow ? "stretch" : "center", gap: 12 }}>
      <View style={{ flex: narrow ? undefined : 1, minWidth: 0 }}><TaskBar colors={colors} tasks={tasks} /></View>
      {actions}
    </View>
    {moreOpen && !goal.assigned && !terminal(goal) ? <View style={{ gap: 10, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface1 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {button("Edit", () => { setSelected(goal.id); setEditing(true); }, disabled || goal.status === "active")}
        {button("Clear goal", () => { setSelected(goal.id); setClearRevision(goal.revision); setClearConfirm(true); }, disabled || goal.status === "active")}
      </View>
      {renderReview?.(goal)}
    </View> : null}
    {!goal.assigned && !executionAvailable && !terminal(goal) ? <Metadata colors={colors}>{t("Start and Resume are unavailable in this session")}</Metadata>
      : !goal.assigned && budgetExhausted && goal.status !== "active" && !terminal(goal) ? <Metadata colors={colors}>{t("Raise or remove the token budget before resuming")}</Metadata> : null}
    {clearConfirm && !goal.assigned ? <Modal title={t("Clear goal?")} open onOpenChange={setClearConfirm}><Modal.Content><View style={{ gap: 16 }}>
      <Text selectable style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>{goal.text}</Text>
      <Metadata colors={colors}>{t("Clearing does not mark the goal complete. Its checklist remains in History.")}</Metadata>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {button("Keep goal", () => setClearConfirm(false))}
        {button("Clear goal", () => { void action("clear", { expectedEntryRevision: clearRevision }).then(ok => { if (ok) select(null); }); }, disabled || goal.status === "active" || terminal(goal) || goal.revision !== clearRevision)}
      </View>
    </View></Modal.Content></Modal> : null}
    {editingLimits && !terminal(goal) ? <GoalForm key={`${identity}/limits/${goal.id}`} draftKey={`${identity}/limits/${goal.id}`} colors={colors} goal={goal} locked={disabled} limits={limits} limitsOnly
      onCancel={() => setEditingLimits(false)} onSubmit={async (_objective, tokenBudget, openedRevision, continuationLimits) => {
        const ok = goal.assigned ? !!(await post({ operation: "start", action: "goal.limits", expectedGoalId: goal.sourceGoalId,
          expectedActivationId: goal.activationId, expectedPolicyRevision: openedRevision, tokenBudget: tokenBudget ?? null, continuationLimits }))
          : await action("limits", { expectedPolicyRevision: openedRevision, tokenBudget: tokenBudget ?? null, continuationLimits });
        if (ok) setEditingLimits(false); return ok;
      }} /> : null}
    <View>
      {tasks.length ? (expanded[goal.id] ? tasks : tasks.slice(0, 8)).map((task, index) => <View key={task.id ?? index} accessible accessibilityLabel={`${task.text}: ${t(task.status.replaceAll("_", " "))}`}
        style={{ flexDirection: "row", gap: 10, alignItems: "flex-start", paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
        <View style={{ paddingTop: 3 }}><Icon name={task.status === "completed" ? "CircleCheck" : task.status === "blocked" ? "Ban" : task.status === "in_progress" ? "CircleDot" : "Circle"} size={14}
          color={task.status === "completed" ? colors.statusSuccess : task.status === "blocked" ? colors.statusDanger : task.status === "in_progress" ? goalWorkingColor : colors.foregroundMuted} /></View>
        <Text selectable style={{ flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, color: task.status === "completed" ? colors.foregroundMuted : colors.foreground,
          textDecorationLine: task.status === "completed" ? "line-through" : "none" }}>{task.text}</Text>
        {task.status === "blocked" ? <Text style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 20 }}>{t("Blocked")}</Text> : null}
      </View>) : <Metadata colors={colors}>{t(goal.status === "active" ? "No tasks reported yet" : "No tasks yet")}</Metadata>}
      {goal.tasks.length > 8 ? <PressableRow colors={colors} onPress={() => setExpanded({ ...expanded, [goal.id]: !expanded[goal.id] })}
        style={{ paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
        <Metadata colors={colors}>{expanded[goal.id] ? t("Show fewer tasks") : t("Show all {{count}} tasks", { count: goal.tasks.length })}</Metadata>
      </PressableRow> : null}
      {!goal.assigned && !terminal(goal) && goal.status !== "active" && !addingTask ? <PressableRow colors={colors} accessibilityRole="button" disabled={disabled || taskCapacity}
        onPress={() => { setSelected(goal.id); setAddingTask(true); setTaskText(""); }}
        style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
        <Icon name="Plus" size={14} color={colors.foregroundMuted} />
        <Metadata colors={colors}>{t(taskCapacity ? "50-task limit reached" : "Add task")}</Metadata>
      </PressableRow> : null}
      {!goal.assigned && goal.status === "active" ? <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
        <Icon name="Plus" size={14} color={colors.foregroundMuted} />
        <Metadata colors={colors}>{t("Pause the goal to add tasks")}</Metadata>
      </View> : null}
      {addingTask && !goal.assigned ? <View style={{ gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border }}>
        <TextInput accessibilityLabel={t("Subtask")} value={taskText} onChangeText={setTaskText} editable={!disabled && goal.status !== "active" && !terminal(goal)} maxLength={503} placeholder={t("Describe a task")} placeholderTextColor={colors.foregroundMuted}
          autoFocus style={{ minHeight: 40, paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 8, color: colors.foreground, backgroundColor: colors.surface2 }} />
        {duplicateTask ? <Metadata colors={colors} alert style={{ color: colors.statusDanger }}>{t("That task is already in this goal")}</Metadata> : null}
        <View style={{ flexDirection: "row", gap: 8 }}>
          {button("Save task", () => { void action("add_task", { text: taskDraft }).then(ok => { if (ok) { setAddingTask(false); setTaskText(""); } }); }, disabled || taskCapacity || goal.status === "active" || terminal(goal) || !taskDraft || duplicateTask)}
          {button("Cancel", () => { setAddingTask(false); setTaskText(""); }, false)}
        </View>
      </View> : null}
    </View>
    <GoalPullRequests goal={goal} colors={colors} />
    {goal.summary && goal.status !== "cleared" ? <View style={{ gap: 8 }}><Text style={{ color: colors.foreground, fontWeight: "500", fontSize: 14 }}>{t("Summary")}</Text><Text selectable style={{ color: colors.foregroundMuted, fontSize: 14, lineHeight: 20 }}>{t(readableSummary(goal.summary))}</Text></View> : null}
    <View style={{ gap: 12 }}>
      {section("activity", "Activity", story.length, <StoryLog key={`${identity}/${goal.id}/story`} identity={`${identity}/${goal.id}/story`} colors={colors} entries={story}
        truncated={goal.story?.coverage?.timelineTruncated || goal.story?.coverage?.activityTruncated} />)}
      {section("questions", "Questions", pendingQuestions, goal.assigned ? <Metadata colors={colors}>{t("No recorded questions available for this assigned goal")}</Metadata> : <>
        <GoalQuestions key={`${identity}/${goal.id}`} colors={colors} questions={goal.story?.questions ?? []} identity={`${identity}/${goal.id}`} revision={goal.revision} renderAttachments={question => renderQuestionAttachments?.(goal, question)}
          disabled={disabled || terminal(goal) || goal.status !== "active" || !goal.child || goal.observation?.state === "unavailable"} onAnswer={(question, answer, openedRevision) => action("answer", {
            expectedEntryRevision: openedRevision, questionId: question.id, questionRevision: question.revision, workerEpoch: question.workerEpoch, answer,
          })} />
        {goal.story?.coverage?.questionsTruncated ? <Metadata colors={colors}>{t("Earlier questions omitted")}</Metadata> : null}
      </>, pendingQuestions > 0)}
      {section("details", "Details", undefined, <>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Metadata colors={colors} style={{ flex: 1 }}>{limitSummary(goal, limits, t)}{!goal.assigned && goal.child?.model ? ` · ${t("Launch model")}: ${goal.child.model}` : ""}</Metadata>
          {!terminal(goal) ? button("Edit limits", () => { setSelected(goal.id); setEditingLimits(true); }, disabled || editingLimits || !limitsEditable || goal.policyRevision === undefined || (goal.assigned && !goal.activationId)) : null}
        </View>
        {goal.assigned ? <View style={{ gap: 4 }}>
          {goal.waiting ? <Metadata colors={colors}>{goal.waitDeadline === undefined ? t("Wait deadline unavailable in this runtime") : goal.waitDeadline !== null ? t("Safety wake: {{time}} (when idle)",{time:time(goal.waitDeadline)}) : t("Waiting for an external message or explicit resume; no safety deadline")}</Metadata> : null}
          {goal.lastWake ? <Metadata colors={colors}>{t("Last wake: {{reason}} · {{time}}",{reason:goal.lastWake.reason.replaceAll("_", " "),time:time(goal.lastWake.at)})}</Metadata> : null}
          {goal.lastTaskUpdateAt != null ? <Metadata colors={colors}>{t("Last checklist change: {{time}}",{time:time(goal.lastTaskUpdateAt)})}</Metadata> : null}
          {goal.lastBlocker ? <View style={{ gap: 4 }}><Metadata colors={colors}>{t("Recorded blocker: {{reason}}",{reason:goal.lastBlocker.reason})}</Metadata><Text selectable style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{goal.lastBlocker.evidence}</Text></View> : null}
        </View> : <>
          <GoalPlanning key={`${identity}/${goal.id}/planning`} embedded goal={goal} colors={colors} disabled={disabled} available={planningAvailable} post={(name, fields) => action(name, fields)} />
          <GoalRecordedDetails key={`${identity}/${goal.id}`} embedded colors={colors} goal={goal} />
        </>}
      </>)}
    </View>
  </View>;
}

/** Bordered goal rows, the same shape as the Jobs and Agents lists. */
function GoalList({ colors, entries, onSelect }: { colors: PresentationColors; entries: Ticket[]; onSelect(id: string): void }) {
  const { t } = useGoalText();
  return <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface1, overflow: "hidden" }}>
    {entries.map((goal, index) => {
      const done = goal.tasks.filter(task => task.status === "completed").length;
      const pr = goal.prs?.find(item => item.state === "open") ?? goal.prs?.[0];
      // Only a running goal can receive an answer; a stopped one keeps its question readable on the page.
      const pending = goal.status === "active" && goal.story?.questions?.some(question => question.status === "pending");
      const state = pending ? t("Waiting for your answer") : goal.status === "active" && goal.waiting ? t("Waiting")
        : isCurrentSession(goal) ? t("This chat") : goal.status === "active" && goal.child ? t("Coordinator") : t(recordedGoalStatus(goal));
      const detail = [state, goal.tasks.length ? t("{{done}} of {{total}} tasks", { done, total: goal.tasks.length }) : "",
        pr ? `PR ${pr.ref.split("#").pop() ? `#${pr.ref.split("#").pop()}` : ""} ${pr.state === "open" ? (pr.ci === "pending" ? t("CI running") : pr.ci === "failed" ? t("CI failed") : t("open")) : t(pr.state)}` : ""]
        .filter(Boolean).join(" · ");
      const leading = goal.status === "active" && !pending && !goal.waiting
        ? <WorkStatusRing attention={false} foreground={colors.foreground} platform={Platform.OS} />
        : <Icon size={14} name={pending ? "CircleHelp" : goal.status === "complete" ? "CircleCheck" : goal.status === "cleared" ? "CircleX"
          : goal.status === "active" ? "Clock" : goal.status === "paused" ? "CirclePause" : "Ban"}
          color={pending ? "#db932e" : goal.status === "complete" ? colors.statusSuccess : goal.status === "active" ? goalWorkingColor
            : goal.status === "paused" || goal.status === "cleared" ? colors.foregroundMuted : colors.statusDanger} />;
      return <View key={goal.reactKey} style={index ? { borderTopWidth: 1, borderTopColor: colors.border } : undefined}>
        <NativeRow colors={colors} title={goal.text.split("\n")[0]} detail={detail} leading={leading}
          trailing={<Icon name="ChevronRight" size={14} color={colors.foregroundMuted} />} onPress={() => onSelect(goal.id)} />
      </View>;
    })}
  </View>;
}

/** The goal's limits on one line, naming only the ones that are set. */
function limitSummary(goal: DelegatedGoal & { assigned?: boolean; effectiveLimits?: { automaticTurns?: number | null; noProgressTurns?: number | null } },
  defaults: { automaticTurns?: number | null; noProgressTurns?: number | null }, t: (text: string) => string): string {
  const configured = goal.assigned ? goal.effectiveLimits : goal.continuationLimits;
  const automatic = configured?.automaticTurns ?? defaults.automaticTurns ?? null;
  const noProgress = configured?.noProgressTurns ?? defaults.noProgressTurns ?? null;
  const parts = [
    automatic !== null ? `${goal.automaticTurns ?? 0} / ${automatic} ${t("responses")}` : "",
    goal.tokenBudget != null ? `${(goal.tokensUsed ?? 0).toLocaleString()} / ${goal.tokenBudget.toLocaleString()} ${t("tokens")}` : "",
    noProgress !== null ? `${goal.noProgressTurns ?? 0} / ${noProgress} ${t("without progress")}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : t("No limits set");
}

/** Messages the harness records about a coordinator, in words a reader understands. Anything
 * else is the coordinator's own summary and is shown as written. */
function readableSummary(summary: string): string {
  if (/child execution exited; explicit Resume is required/i.test(summary)) return "The coordinator stopped. Resume to continue.";
  return summary;
}
