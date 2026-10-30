// Adapted from Progress client/questions.tsx QuestionView/QuestionDetail (MIT).
// Copyright (c) 2026 Steve Castaneda. See ../licenses/progress-MIT.txt.
// Unlike Progress's Copy controls, these submit the existing questionnaire DTO
// to the goal-bound workflow service. Permission requests are not accepted here.
import { useState } from "react";
import { Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import type { z } from "zod";
import type { goalQuestionSchema } from "../shared/workflows";
import type { questionnaireAnswerSchema } from "../shared/foreground-tasks";
import { Metadata, NativeButton, type PresentationColors } from "./presentation";
import { PressableRow, goalWorkingColor } from "./goal-ticket-ui";
export type GoalQuestion = z.infer<typeof goalQuestionSchema>;
export type GoalAnswer = z.infer<typeof questionnaireAnswerSchema>;
type Draft = { revision: number; values: Record<string, string> };
const drafts = new Map<string, Draft>();
export function GoalQuestions({ colors, questions, identity, revision, disabled, onAnswer }: {
  colors: PresentationColors; questions: GoalQuestion[]; identity: string; revision: number; disabled: boolean;
  onAnswer(question: GoalQuestion, answer: GoalAnswer, openedRevision: number): Promise<boolean>;
}) {
  if (!questions.length) return <Metadata colors={colors}>No recorded questions</Metadata>;
  const pending = questions.filter(question => question.status === "pending");
  const settled = questions.filter(question => question.status !== "pending");
  return <View style={{ gap: 16 }}>
    {pending.map(question => <QuestionCard key={`${identity}/${question.id}/${question.workerEpoch}/${question.revision}`} {...{ colors, question, identity, revision, disabled, onAnswer }} />)}
    {settled.length ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>Question history</Text> : null}
    {settled.map(question => <QuestionCard key={`${identity}/${question.id}/${question.workerEpoch}/${question.revision}`} {...{ colors, question, identity, revision, disabled, onAnswer }} />)}
  </View>;
}
function QuestionCard({ colors, question, identity, revision, disabled, onAnswer }: {
  colors: PresentationColors; question: GoalQuestion; identity: string; revision: number; disabled: boolean;
  onAnswer(question: GoalQuestion, answer: GoalAnswer, openedRevision: number): Promise<boolean>;
}) {
  const key = `${identity}/${question.id}/${question.workerEpoch}/${question.revision}`;
  const [draft, update] = useState<Draft>(() => drafts.get(key) ?? { revision, values: {} });
  const [sending, setSending] = useState(false);
  function save(next: Draft) { drafts.set(key, next); update(next); }
  const pending = question.status === "pending";
  const stale = pending && draft.revision !== revision;
  const locked = disabled || sending || stale;
  const answers = question.request.questions.map(item => {
    const value = draft.values[item.id] ?? "";
    return { id: item.id, value, wasCustom: !item.options.some(option => option.value === value) };
  });
  const valid = answers.length > 0 && answers.every((answer, index) => !!answer.value.trim() && (!answer.wasCustom || question.request.questions[index].allowOther));
  async function submit(cancelled: boolean) {
    if (locked || !pending || (!cancelled && !valid)) return;
    setSending(true);
    try { if (await onAnswer(question, { kind: "questionnaire", cancelled, answers: cancelled ? [] : answers }, draft.revision)) drafts.delete(key); }
    finally { setSending(false); }
  }
  return <View style={{ gap: 10 }}>
    {question.request.questions.map(item => {
      const answer = question.answer?.answers.find(answer => answer.id === item.id);
      return <View key={item.id} style={{ gap: 8 }}>
        {item.label ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{item.label}</Text> : null}
        <Text selectable style={{ color: colors.foreground, fontSize: 14, lineHeight: 20 }}>{item.prompt}</Text>
        {pending ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>Pending questionnaire response</Text> : null}
        {item.options.map(option => {
          const chosen = pending ? draft.values[item.id] === option.value : answer?.value === option.value;
          return <PressableRow key={option.value} colors={colors} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked: chosen, disabled: !pending || locked }} aria-checked={chosen} disabled={!pending || locked}
            onPress={() => save({ ...draft, values: { ...draft.values, [item.id]: option.value } })}
            style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: chosen ? pending ? goalWorkingColor : colors.statusSuccess : colors.border }}>
            <Text style={{ color: chosen ? pending ? goalWorkingColor : colors.statusSuccess : colors.foregroundMuted, fontSize: 13 }}>{chosen ? "●" : "○"}</Text>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={{ color: colors.foreground, fontSize: 13, lineHeight: 18 }}>{option.label}{!pending && chosen ? " · Your answer" : ""}</Text>
              {option.description ? <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{option.description}</Text> : null}
            </View>
          </PressableRow>;
        })}
        {pending && item.allowOther ? <TextInput accessibilityLabel={`Custom answer for ${item.label ?? item.prompt}`} placeholder="Other answer" maxLength={2000}
          value={item.options.some(option => option.value === draft.values[item.id]) ? "" : draft.values[item.id] ?? ""} editable={!locked}
          onChangeText={value => save({ ...draft, values: { ...draft.values, [item.id]: value } })}
          placeholderTextColor={colors.foregroundMuted} style={{ color: colors.foreground, borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 12, minHeight: 44 }} /> : null}
        {!pending && answer?.wasCustom ? <Text selectable style={{ color: colors.foreground, fontSize: 13, lineHeight: 19 }}>{answer.value}</Text> : null}
      </View>;
    })}
    {stale ? <View style={{ gap: 8 }}><Metadata colors={colors} alert>This goal changed. Review the latest question before answering.</Metadata>
      <NativeButton colors={colors} label="Review latest question" onPress={() => save({ revision, values: {} })} disabled={disabled || sending} /></View> : null}
    {pending ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <NativeButton colors={{ ...colors, accent: goalWorkingColor, accentForeground: "#ffffff" }} primary label="Submit answers" disabled={locked || !valid} onPress={() => void submit(false)} style={{ minHeight: 44 }} />
      <NativeButton colors={colors} label="Cancel questions" disabled={locked} onPress={() => void submit(true)} style={{ minHeight: 44 }} />
    </View> : <Text style={{ color: colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{question.status === "cancelled" ? "Cancelled" : "Answered"}{question.answeredAt !== undefined ? ` · ${new Date(question.answeredAt).toLocaleString()}` : ""}</Text>}
  </View>;
}
