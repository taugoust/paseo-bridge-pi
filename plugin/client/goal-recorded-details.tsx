import { useState } from "react";
import { Text, View } from "react-native";
import type { DelegatedGoal } from "./delegated-goals";
import { Metadata, NativeButton, type PresentationColors } from "./presentation";
import { goalRecordTime } from "./goal-history";
/** Evidence only: a recorded blocker or deadline never changes execution status. */
export function GoalRecordedDetails({ goal, colors }: { goal: DelegatedGoal; colors: PresentationColors }) {
  const [expanded, setExpanded] = useState(false);
  const diagnostic = goal.diagnostics;
  const times = [...(goal.story?.timeline ?? []), ...(goal.story?.activity ?? [])].map(event => event.at);
  const latest = times.length ? Math.max(...times) : undefined;
  if (!diagnostic && !goal.observation && latest === undefined) return null;
  return <View style={{ gap: 8 }}>
    <NativeButton colors={colors} label={expanded ? "Hide recorded details" : "Recorded details"} onPress={() => setExpanded(!expanded)} />
    {expanded ? <View style={{ gap: 8 }}>
      {latest !== undefined ? <Metadata colors={colors}>Last recorded update: {goalRecordTime(latest)}</Metadata> : null}
      {goal.observation?.state === "unavailable" ? <Metadata colors={colors}>Live observation unavailable{goal.observation.at ? ` · Last observed ${goalRecordTime(goal.observation.at)}` : ""}</Metadata> : null}
      {diagnostic?.waitDeadline != null ? <Metadata colors={colors}>Safety wake: {goalRecordTime(diagnostic.waitDeadline)} (when idle)</Metadata> : null}
      {diagnostic?.lastWake ? <Metadata colors={colors}>Last wake: {diagnostic.lastWake.reason.replaceAll("_", " ")} · {goalRecordTime(diagnostic.lastWake.at)}</Metadata> : null}
      {diagnostic?.lastTaskUpdateAt != null ? <Metadata colors={colors}>Last checklist change: {goalRecordTime(diagnostic.lastTaskUpdateAt)}</Metadata> : null}
      {diagnostic?.lastBlocker ? <View style={{ gap: 4 }}><Metadata colors={colors}>Recorded blocker: {diagnostic.lastBlocker.reason}</Metadata><Text selectable style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{diagnostic.lastBlocker.evidence}</Text></View> : null}
    </View> : null}
  </View>;
}
