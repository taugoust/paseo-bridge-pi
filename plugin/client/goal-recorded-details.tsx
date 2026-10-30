import { useState } from "react";
import { Text, View } from "react-native";
import type { DelegatedGoal } from "./delegated-goals";
import { Metadata, type PresentationColors } from "./presentation";
import { GoalButton as NativeButton, useGoalText } from "./goal-language";
/** Evidence only: a recorded blocker or deadline never changes execution status. */
export function GoalRecordedDetails({ goal, colors }: { goal: DelegatedGoal; colors: PresentationColors }) {
  const { t, time } = useGoalText();
  const [expanded, setExpanded] = useState(false);
  const diagnostic = goal.diagnostics;
  const times = [...(goal.story?.timeline ?? []), ...(goal.story?.activity ?? [])].map(event => event.at);
  const latest = times.length ? Math.max(...times) : undefined;
  if (!diagnostic && !goal.observation && latest === undefined) return null;
  return <View style={{ gap: 8 }}>
    <NativeButton colors={colors} label={expanded ? "Hide recorded details" : "Recorded details"} onPress={() => setExpanded(!expanded)} />
    {expanded ? <View style={{ gap: 8 }}>
      {latest !== undefined ? <Metadata colors={colors}>{t("Last recorded update: {{time}}",{time:time(latest)})}</Metadata> : null}
      {goal.observation?.state === "unavailable" ? <Metadata colors={colors}>{t("Live observation unavailable")}{goal.observation.at ? ` · ${t("Last observed {{time}}",{time:time(goal.observation.at)})}` : ""}</Metadata> : null}
      {diagnostic?.waitDeadline != null ? <Metadata colors={colors}>{t("Safety wake: {{time}} (when idle)",{time:time(diagnostic.waitDeadline)})}</Metadata> : null}
      {diagnostic?.lastWake ? <Metadata colors={colors}>{t("Last wake: {{reason}} · {{time}}",{reason:diagnostic.lastWake.reason.replaceAll("_", " "),time:time(diagnostic.lastWake.at)})}</Metadata> : null}
      {diagnostic?.lastTaskUpdateAt != null ? <Metadata colors={colors}>{t("Last checklist change: {{time}}",{time:time(diagnostic.lastTaskUpdateAt)})}</Metadata> : null}
      {diagnostic?.lastBlocker ? <View style={{ gap: 4 }}><Metadata colors={colors}>{t("Recorded blocker: {{reason}}",{reason:diagnostic.lastBlocker.reason})}</Metadata><Text selectable style={{ color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{diagnostic.lastBlocker.evidence}</Text></View> : null}
    </View> : null}
  </View>;
}
