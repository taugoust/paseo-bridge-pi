import assert from 'node:assert/strict';
import test from 'node:test';
import { SubagentTaskProjection, projectSubagentMessages } from '../extension/subagent-task-projection.ts';
const taskId='subagent-task-111111111111111111111111';
const args={task:'Close timing'};
const child={task:'Close timing',task_id:taskId,attempt:2,exitCode:0,task_outcome:{state:'partial',reported:true,summary:'Implementation done; route pending',next_action:'Inspect route result'},lastToolCall:{name:'task_outcome',args:{private:'do not render the report tool JSON'}},lastToolResult:'Recorded partial',messages:[{role:'assistant',content:[{type:'text',text:'Saved the candidate.'}]}]};
test('a clean response retains its partial outcome and attempt identity for Paseo cards',()=>{
 const p=new SubagentTaskProjection();p.project({type:'tool_execution_start',toolName:'subagent',toolCallId:'parent',args});
 const [end]=p.project({type:'tool_execution_end',toolCallId:'parent',toolName:'subagent',result:{details:{results:[child]}}});
 assert.equal(end.isError,false,'partial delivery must not fabricate an execution failure');
 assert.equal(end.result.details.task_outcome.state,'partial');
 assert.equal(end.result.details.task_id,taskId);assert.equal(end.result.details.attempt,2);
 assert.match(end.result.content[0].text,/Needs continuation · attempt 2/);
 assert.match(end.result.content[0].text,/Next: Inspect route/);
 assert.match(end.result.content[0].text,/Saved the candidate/);
 assert.doesNotMatch(end.result.content[0].text,/do not render|Running task_outcome/);
});
test('history projection preserves the same outcome presentation without retaining full child transcripts',()=>{
 const messages=projectSubagentMessages([{role:'assistant',content:[{type:'toolCall',name:'subagent',id:'parent',arguments:args}]},{role:'toolResult',toolCallId:'parent',toolName:'subagent',details:{results:[child]}}]) as any[];
 assert.equal(messages[1].details.task_outcome.state,'partial');
 assert.equal(messages[1].details.task_id,taskId);
 assert.equal(messages[1].details.messages,undefined);
});
test('a delivered state without a reported flag cannot acquire a delivery label',()=>{
 const p=new SubagentTaskProjection();p.project({type:'tool_execution_start',toolName:'subagent',toolCallId:'parent',args});
 const [end]=p.project({type:'tool_execution_end',toolCallId:'parent',result:{details:{results:[{...child,task_outcome:{state:'delivered',summary:'unverified'}}]}}});
 assert.equal(end.result.details.task_outcome.state,'unreported');
 assert.doesNotMatch(end.result.content[0].text,/Reported delivered/);
});
