import { useEffect, useRef, useState } from "react";
import { Image, Text, View } from "react-native";
import { TextInput } from "@getpaseo/plugin/client/react-native";
import { Modal } from "@getpaseo/plugin/client/ui";
import { openExternalUrl } from "@getpaseo/plugin/client";
import type { z } from "zod";
import type { goalReviewPreviewSchema } from "../shared/workflows";
import type { DelegatedGoal } from "./delegated-goals";
import { Metadata, OutputWell, type PresentationColors } from "./presentation";
import { GoalButton as NativeButton, useGoalText } from "./goal-language";

export type GoalPreview = z.infer<typeof goalReviewPreviewSchema>;
type Preview = GoalPreview;
/** Registered references only. Neither preview nor navigation takes a raw path.
 * The caller rechecks the current session/runtime and the producer checks the
 * exact goal revision + registered task/attempt before returning any bytes.
 */
export function GoalReview({ goal, colors, disabled, available, register, preview }: {
  goal: DelegatedGoal; colors: PresentationColors; disabled: boolean; available: boolean;
  register(fields: { reviewTitle: string; reviewTarget: string; reviewRole: "source" | "deliverable"; expectedEntryRevision: number }): Promise<boolean>;
  preview(referenceId: string, revision: number): Promise<Preview>;
}) {
  const { t, time } = useGoalText();
  const [expanded, setExpanded] = useState(false), [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ title: "", target: "", role: "source" as "source" | "deliverable", revision: goal.revision });
  const [document, setDocument] = useState<{ title: string; data: Preview; scope: string }>(), [exportText, setExportText] = useState<string>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>();
  const current = useRef("");
  const identity = JSON.stringify([goal.id, goal.revision, goal.child]);current.current = identity;
  useEffect(() => () => { current.current = ""; }, []);
  const refs = (goal.review ?? []).filter(ref=>ref.questionId===undefined), stale = draft.revision !== goal.revision;
  async function open(id: string, title: string) {
    if (busy || disabled || !available) return;
    const opened = identity;setBusy(true);setError(undefined);
    try { const data = await preview(id,goal.revision);if (current.current === opened) setDocument({ title, data, scope: opened }); }
    catch { if (current.current === opened) setError("Preview unavailable. Refresh or register the file again."); }
    finally { if (current.current) setBusy(false); }
  }
  const input = { minHeight: 44, padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8, color: colors.foreground, backgroundColor: colors.surface2 } as const;
  return <View style={{ gap: 10 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <NativeButton colors={colors} label={expanded ? "Hide references" : refs.length ? t("Review references ({{count}})",{count:refs.length}) : "Review references"} onPress={() => setExpanded(!expanded)} />
      <NativeButton colors={colors} label="Export snapshot" onPress={() => {
        const text = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), entry: goal },null,2);
        if (text.length > 600 * 1024) { setError("Snapshot is too large to copy.");return; }
        setExportText(text);
      }} />
    </View>
    {expanded ? <View style={{ gap: 10 }}>
      {refs.map(ref => <View key={ref.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ flex: 1, minWidth: 0 }}><Text selectable style={{ color: colors.foreground, fontSize: 13 }}>{ref.title}</Text><Metadata colors={colors}>{t(ref.role === "source" ? "Source" : "Deliverable")} · {time(ref.at)}</Metadata></View>
        <NativeButton colors={colors} label={t("Review {{title}}",{title:ref.title})} disabled={disabled || busy || !available || ref.childId !== goal.child?.childId || ref.attempt !== goal.child?.attempt} onPress={() => void open(ref.id,ref.title)} />
      </View>)}
      {!refs.length ? <Metadata colors={colors}>{t("No registered references")}</Metadata> : null}
      {goal.reviewTruncated ? <Metadata colors={colors}>{t("Earlier references omitted")}</Metadata> : null}
      {available && goal.child && (goal.review?.length??0) < 16 ? <NativeButton colors={colors} label={adding ? "Cancel reference" : "Register reference"} disabled={disabled || busy} onPress={() => { setAdding(!adding);setDraft({ title: "", target: "", role: "source", revision: goal.revision });setError(undefined); }} /> : null}
      {adding ? <View style={{ gap: 8 }}>
        <TextInput accessibilityLabel={t("Reference title")} value={draft.title} maxLength={160} editable={!disabled && !busy} onChangeText={title => setDraft({ ...draft, title })} placeholder={t("Title")} placeholderTextColor={colors.foregroundMuted} style={input} />
        <TextInput accessibilityLabel={t("Reference path or HTTPS URL")} value={draft.target} maxLength={4096} editable={!disabled && !busy} onChangeText={target => setDraft({ ...draft, target })} placeholder={t("Workspace file or HTTPS URL")} placeholderTextColor={colors.foregroundMuted} style={input} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{(["source","deliverable"] as const).map(role => <NativeButton key={role} colors={colors} label={role === "source" ? "Source" : "Deliverable"} primary={draft.role === role} onPress={() => setDraft({ ...draft, role })} disabled={disabled || busy} />)}</View>
        {stale ? <Metadata colors={colors}>{t("Goal changed. Reopen registration to review.")}</Metadata> : null}
        <NativeButton colors={colors} label="Save reference" disabled={disabled || busy || stale || !draft.title.trim() || !draft.target.trim()} onPress={() => {
          if (disabled || busy || stale) return;
          const opened = identity;setBusy(true);setError(undefined);
          void register({ reviewTitle: draft.title.trim(), reviewTarget: draft.target.trim(), reviewRole: draft.role, expectedEntryRevision: draft.revision }).then(ok => { if (current.current !== opened) return;if (ok) setAdding(false);else setError("Reference not saved. Review the current goal and retry."); }).finally(() => { if (current.current) setBusy(false); });
        }} />
      </View> : null}
    </View> : null}
    {error ? <Metadata colors={colors} alert>{t(error)}</Metadata> : null}
    <GoalReviewDocument document={document?.scope===identity?document:undefined} colors={colors} onClose={()=>setDocument(undefined)} onError={setError} />
    <Modal title={t("Goal snapshot")} open={exportText !== undefined} onOpenChange={open => { if (!open) setExportText(undefined); }}><Modal.Content>{exportText !== undefined ? <OutputWell colors={colors} text={exportText} monospace copyLabel={t("Copy")} copyErrorLabel={t("Could not copy. Select the text to copy it.")} /> : null}</Modal.Content></Modal>
  </View>;
}
export function GoalReviewDocument({document,colors,onClose,onError}:{document?:{title:string;data:GoalPreview};colors:PresentationColors;onClose():void;onError(error:string):void}){
  const {t}=useGoalText();
  const [actionError,setActionError]=useState<string>();
  useEffect(()=>setActionError(undefined),[document?.data]);
  return <Modal title={document?.title??t("Review")} open={!!document} onOpenChange={open=>{if(!open)onClose();}}><Modal.Content>
    {document?.data.kind==="text"?<OutputWell colors={colors} text={document.data.text} monospace copyLabel={t("Copy")} copyErrorLabel={t("Could not copy. Select the text to copy it.")} />:document?.data.kind==="image"?<Image accessibilityLabel={document.title} source={{uri:document.data.dataUri}} onError={()=>{setActionError("Image could not be displayed.");onError("Image could not be displayed.");}} resizeMode="contain" style={{width:"100%",height:420}} />:document?.data.kind==="link"?<View style={{gap:12}}><Text selectable style={{color:colors.foreground}}>{document.data.url}</Text><NativeButton colors={colors} label="Open HTTPS link" onPress={()=>{if(document?.data.kind==="link")void openExternalUrl(document.data.url).catch(()=>{setActionError("Link could not open. Copy its address instead.");onError("Link could not open. Copy its address instead.");});}} /></View>:null}
    {actionError?<Metadata colors={colors} alert>{t(actionError)}</Metadata>:null}
  </Modal.Content></Modal>;
}
