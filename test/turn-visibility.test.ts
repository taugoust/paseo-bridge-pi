import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TurnVisibilityProjection } from '../extension/turn-visibility.ts';

const assistant=(text='',stopReason='stop')=>({role:'assistant',stopReason,content:text?[{type:'text',text}]:[]});
const hidden={role:'custom',customType:'harness-state',display:false,content:'Internal update'};
function run(p:TurnVisibilityProjection,input:any,last:any){
 return [{type:'agent_start'},{type:'turn_start'},{type:'message_start',message:input},{type:'message_end',message:input},
  {type:'message_start',message:last},{type:'message_end',message:last},{type:'agent_end',messages:[last]},{type:'agent_settled'}]
  .flatMap(e=>p.project(e));
}
test('repeated silent supervision does not advertise foreground completion',()=>{
 const p=new TurnVisibilityProjection();
 for(let i=0;i<8;i++)assert(!run(p,hidden,assistant()).some(e=>['agent_start','turn_start','agent_end','agent_settled'].includes(e.type)));
});
test('user turns and fresh internal final answers each complete once',()=>{
 const p=new TurnVisibilityProjection();
 for(const input of [{role:'user',content:'question'},hidden]){
  const events=run(p,input,assistant('A fresh answer'));
  assert.equal(events.filter(e=>e.type==='agent_start').length,1);
  assert.equal(events.filter(e=>e.type==='agent_end').length,1);
  assert(!events.some(e=>e.type==='agent_settled'));
 }
});
test('commentary and tool activity pass through without finished framing',()=>{
 const p=new TurnVisibilityProjection();p.project({type:'agent_start'});p.project({type:'turn_start'});p.project({type:'message_start',message:hidden});
 const delta={type:'message_update',message:assistant('Working','toolUse'),assistantMessageEvent:{type:'text_delta',delta:'Working'}};
 assert.deepEqual(p.project(delta),[delta]);
 assert.equal(p.project({type:'message_end',message:assistant('Working','toolUse')}).length,1);
 for(const type of ['tool_execution_start','tool_execution_update','tool_execution_end','extension_ui_request']){
  const e={type,id:'permission',method:'select'};assert.deepEqual(p.project(e),[e]);
 }
 p.project({type:'agent_end',messages:[assistant()]});assert.deepEqual(p.project({type:'agent_settled'}),[]);
});
test('a user message promotes an internal cycle',()=>{
 const p=new TurnVisibilityProjection();p.project({type:'agent_start'});p.project({type:'turn_start'});p.project({type:'message_start',message:hidden});
 assert.deepEqual(p.project({type:'message_start',message:{role:'user',content:'Question'}}).map(e=>e.type),['agent_start','turn_start','message_start']);
 p.project({type:'agent_end',messages:[assistant()]});assert.equal(p.project({type:'agent_settled'}).filter(e=>e.type==='agent_end').length,1);
});
test('errors remain visible and retries do not finish prematurely',()=>{
 const p=new TurnVisibilityProjection();p.project({type:'agent_start'});p.project({type:'turn_start'});p.project({type:'message_start',message:hidden});
 const error=assistant('','error');assert.deepEqual(p.project({type:'agent_end',messages:[error]}),[]);
 const events=p.project({type:'agent_settled'});assert.deepEqual(events.map(e=>e.type),['agent_start','turn_start','agent_end']);
 const q=new TurnVisibilityProjection();q.project({type:'agent_start'});q.project({type:'turn_start'});q.project({type:'message_start',message:hidden});
 q.project({type:'agent_end',messages:[error]});q.project({type:'agent_start'});q.project({type:'turn_start'});
 q.project({type:'agent_end',messages:[error,assistant()]});assert.deepEqual(q.project({type:'agent_settled'}),[]);
});
