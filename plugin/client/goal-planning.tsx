import { useState } from "react";
import { Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { SettingsSelect } from "@getpaseo/plugin/client/ui";
import type { DelegatedGoal } from "./delegated-goals";
import { Metadata, type PresentationColors } from "./presentation";
import { GoalButton as NativeButton, useGoalText } from "./goal-language";
import { PressableRow } from "./goal-ticket-ui";

export function GoalPlanning({ goal, colors, disabled, available, post }: {
  goal: DelegatedGoal; colors: PresentationColors; disabled: boolean; available: boolean;
  post(action: string, fields: Record<string, unknown>): Promise<boolean>;
}) {
  const { t, time } = useGoalText();
  const [expanded, setExpanded] = useState(false), [mode, setMode] = useState<"dependencies" | "blocker">();
  const [revision, setRevision] = useState(goal.revision), [taskId, setTaskId] = useState(""), [waitsFor, setWaitsFor] = useState<string[]>([]);
  const [reason, setReason] = useState(""), [evidence, setEvidence] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const [history, setHistory] = useState(false);
  const planning = goal.planning, blockers = planning?.blockers ?? [], dependencies = planning?.dependencies ?? [];
  const activeBlockers = blockers.filter(blocker => blocker.clearedAt === undefined), terminal = goal.status === "complete" || goal.status === "cleared";
  const locked = disabled || busy || !available, stale = revision !== goal.revision;
  function edit(next: "dependencies" | "blocker") { setMode(next);setRevision(goal.revision);setError(undefined);setTaskId(next === "dependencies" ? goal.tasks[0]?.id ?? "" : "");setWaitsFor(next === "dependencies" ? dependencies.find(edge => edge.taskId === goal.tasks[0]?.id)?.waitsFor ?? [] : []);setReason("");setEvidence(""); }
  async function send(action: string, fields: Record<string, unknown>) {
    if (locked) return;setBusy(true);setError(undefined);
    try { if (await post(action,fields)) setMode(undefined);else setError("Planning changed or was not saved. Review and retry."); }
    catch { setError("Planning changed or was not saved. Review and retry."); }
    finally { setBusy(false); }
  }
  if (!available && !planning) return null;
  const input = { minHeight: 44, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, color: colors.foreground, backgroundColor: colors.surface2 } as const;
  return <View style={{ gap: 10 }}>
    <NativeButton colors={colors} label={expanded ? "Hide planning" : activeBlockers.length ? t(activeBlockers.length===1 ? "Planning · {{count}} recorded blocker" : "Planning · {{count}} recorded blockers", {count:activeBlockers.length}) : "Planning"} onPress={() => setExpanded(!expanded)} />
    {expanded ? <View style={{ gap: 12 }}>
      <Metadata colors={colors}>{t("Advisory dependencies and recorded blockers do not start, pause or complete work.")}</Metadata>
      {dependencies.map(edge => <View key={edge.taskId} style={{ gap: 4 }}><Text style={{ color: colors.foreground, fontSize: 13 }}>{goal.tasks.find(task => task.id === edge.taskId)?.text}</Text><Metadata colors={colors}>{t("Waits for: {{tasks}}", {tasks:edge.waitsFor.map(id => goal.tasks.find(task => task.id === id)?.text ?? id).join(" · ")})}</Metadata></View>)}
      {activeBlockers.map(blocker => <View key={blocker.id} style={{ gap: 6, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border }}>
        <Text selectable style={{ color: colors.foreground, fontSize: 13 }}>{blocker.reason}</Text><Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{blocker.evidence}</Text>
        <Metadata colors={colors}>{time(blocker.at)}{blocker.taskId ? ` · ${goal.tasks.find(task => task.id === blocker.taskId)?.text ?? t("Historical task")}` : ""}</Metadata>
        <NativeButton colors={colors} label={t("Clear blocker: {{reason}}", {reason:blocker.reason})} disabled={locked} onPress={() => void send("blocker.clear", { blockerId: blocker.id, expectedEntryRevision: goal.revision })} />
      </View>)}
      {!terminal && available ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <NativeButton colors={colors} label="Edit dependencies" disabled={locked || goal.tasks.length < 2} onPress={() => edit("dependencies")} />
        <NativeButton colors={colors} label="Record blocker" disabled={locked || blockers.length >= 32} onPress={() => edit("blocker")} />
      </View> : null}
      {blockers.length>=32 ? <Metadata colors={colors}>{t("Blocker history limit reached")}</Metadata> : null}
      {mode ? <View style={{ gap: 10 }}>
        <SettingsSelect label={t(mode === "dependencies" ? "Task" : "Blocker scope")} value={taskId} options={[...(mode === "blocker" ? [{ value: "", label: t("Whole goal") }] : []), ...goal.tasks.map(task => ({ value: task.id, label: task.text }))]} disabled={locked || stale} onValueChange={id => { setTaskId(id);setWaitsFor(dependencies.find(edge => edge.taskId === id)?.waitsFor ?? []); }} />
        {mode === "dependencies" ? goal.tasks.filter(task => task.id !== taskId).map(task => <PressableRow key={task.id} colors={colors} accessibilityRole="checkbox" accessibilityLabel={t("Waits for {{task}}",{task:task.text})} accessibilityState={{ checked: waitsFor.includes(task.id), disabled: locked || stale }} aria-checked={waitsFor.includes(task.id)} disabled={locked || stale} onPress={() => { if (!locked && !stale) setWaitsFor(waitsFor.includes(task.id) ? waitsFor.filter(id => id !== task.id) : [...waitsFor,task.id]); }} style={{ minHeight: 44, flexDirection: "row", gap: 8, alignItems: "center" }}><Text style={{ color: colors.foreground }}>{waitsFor.includes(task.id) ? "☑" : "☐"} {task.text}</Text></PressableRow>) : <>
          <TextInput accessibilityLabel={t("Blocker reason")} value={reason} maxLength={500} editable={!locked} onChangeText={setReason} placeholder={t("What is blocked?")} placeholderTextColor={colors.foregroundMuted} style={input} />
          <TextInput accessibilityLabel={t("Blocker evidence")} value={evidence} maxLength={2000} editable={!locked} onChangeText={setEvidence} placeholder={t("Recorded evidence")} placeholderTextColor={colors.foregroundMuted} multiline style={input} />
        </>}
        {stale ? <Metadata colors={colors}>{t("Goal changed. Reopen planning to review current tasks.")}</Metadata> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}><NativeButton colors={colors} label="Save planning" disabled={locked || stale || (mode === "dependencies" ? !taskId : !reason.trim() || !evidence.trim())} onPress={() => { if (stale) return;void send(mode === "dependencies" ? "dependencies" : "blocker.add", { expectedEntryRevision: revision, ...(mode === "dependencies" ? { taskId, waitsFor } : { blockerReason: reason.trim(), blockerEvidence: evidence.trim(), ...(taskId ? { blockerTaskId: taskId } : {}) }) }); }} /><NativeButton colors={colors} label="Cancel planning" disabled={busy} onPress={() => setMode(undefined)} /></View>
      </View> : null}
      {blockers.some(blocker => blocker.clearedAt !== undefined) ? <NativeButton colors={colors} label={history ? "Hide cleared blockers" : "Cleared blockers"} onPress={() => setHistory(!history)} /> : null}
      {history ? blockers.filter(blocker => blocker.clearedAt !== undefined).map(blocker => <View key={blocker.id} style={{ gap: 4 }}><Text selectable style={{ color: colors.foregroundMuted }}>{blocker.reason}</Text><Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{blocker.evidence}</Text><Metadata colors={colors}>{t("Cleared {{time}}",{time:time(blocker.clearedAt!)})}</Metadata></View>) : null}
    </View> : null}
    {error ? <Metadata colors={colors} alert>{t(error)}</Metadata> : null}
  </View>;
}
