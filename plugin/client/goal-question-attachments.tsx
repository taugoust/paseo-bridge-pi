import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { DelegatedGoal } from "./delegated-goals";
import type { GoalQuestion } from "./goal-questions";
import { Metadata, type PresentationColors } from "./presentation";
import { GoalButton, useGoalText } from "./goal-language";
import { GoalReviewDocument, type GoalPreview } from "./goal-review";
export type QuestionAttachmentTarget = {questionId:string;questionRevision:number;workerEpoch:string};
export function GoalQuestionAttachments({goal,question,colors,disabled,available,preview}:{
  goal:DelegatedGoal;question:GoalQuestion;colors:PresentationColors;disabled:boolean;available:boolean;
  preview(referenceId:string,question:QuestionAttachmentTarget):Promise<GoalPreview>;
}){
  const {t}=useGoalText(),[document,setDocument]=useState<{title:string;data:GoalPreview;scope:string}>(),[error,setError]=useState<string>(),[busy,setBusy]=useState(false);
  const current=useRef("");const scope=JSON.stringify([goal.id,goal.revision,goal.child,question.id,question.revision,question.workerEpoch]);current.current=scope;
  useEffect(()=>()=>{current.current="";},[]);
  const ids=question.attachmentIds??[];if(!ids.length)return null;
  async function open(id:string,title:string){if(disabled||busy||!available)return;const opened=scope;setBusy(true);setError(undefined);try{const data=await preview(id,{questionId:question.id,questionRevision:question.revision,workerEpoch:question.workerEpoch});if(current.current===opened)setDocument({title,data,scope:opened});}catch{if(current.current===opened)setError("Preview unavailable. Refresh or register the file again.");}finally{if(current.current)setBusy(false);}}
  return <View style={{gap:8}}>
    <Metadata colors={colors}>{t("Question attachments")}</Metadata>
    {ids.map(id=>{const ref=goal.review?.find(ref=>ref.id===id);const exact=ref&&ref.goalId===goal.id&&ref.taskId===goal.child?.taskId&&ref.childId===goal.child?.childId&&ref.attempt===goal.child?.attempt&&ref.questionId===question.id&&ref.workerEpoch===question.workerEpoch;return <GoalButton key={id} colors={colors} label={ref?t("Review {{title}}",{title:ref.title}):t("Attachment unavailable")} disabled={disabled||busy||!available||!exact} onPress={()=>{if(exact)void open(id,ref.title);}} />;})}
    {error?<Metadata colors={colors} alert>{t(error)}</Metadata>:null}
    <GoalReviewDocument document={document?.scope===scope?document:undefined} colors={colors} onClose={()=>setDocument(undefined)} onError={setError} />
  </View>;
}
