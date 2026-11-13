import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {cp,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const compiler=process.env.PASEO_PLUGIN_COMPILER;assert.ok(compiler,'PASEO_PLUGIN_COMPILER required');
const require=createRequire(resolve(compiler));
test('Goals coordinator chat link shows only for an exactly verified child and rechecks route identity',async t=>{
 const {compilePlugin}=await import(pathToFileURL(resolve(compiler)));
 const fixture=await mkdtemp(resolve(tmpdir(),'goal-agent-ui-'));t.after(()=>rm(fixture,{recursive:true,force:true}));
 for(const directory of ['client','shared'])await cp(fileURLToPath(new URL(`../${directory}`,import.meta.url)),resolve(fixture,directory),{recursive:true});
 await writeFile(resolve(fixture,'index.client.tsx'),'export { GoalAgent } from "./client/goal-agent";');
 const {clientBundle}=await compilePlugin({client:resolve(fixture,'index.client.tsx')});
 const child={taskId:`subagent-task-${'a'.repeat(24)}`,childId:`subagent-child-${'b'.repeat(24)}`,jobId:`subagent-job-${'c'.repeat(24)}`,attempt:2};
 const item={...child,groupId:child.jobId,runtimeId:'runtime',stale:false,status:'running',paseoAgentId:'child-agent',paseoWorkspaceId:'child-workspace'};
 let bound,inventory,query,options,slots=[],cursor=0,rejectRoute=false,finish;
 const refs=[],opened=[],calls=[];let refCursor=0;
 const jsx=(type,props)=>typeof type==='function'?type(props):{type,props};
 const load=name=>{
  if(name==='@getpaseo/plugin')return {defineRpc:x=>x};
  if(name==='@getpaseo/plugin/client')return {useAgent:id=>id==='child-agent'?{id,workspaceId:'child-workspace',title:'Map Review'}:null,useRpc:contract=>async input=>{
   if(contract.name==='harness_status')return bound;
   if(contract.name==='harness_subagents_list')return inventory;
   calls.push(input);if(rejectRoute)throw Error('changed runtime');if(finish)return new Promise(resolve=>{finish.resolve=resolve;});return {agentId:'verified-child',workspaceId:'child-workspace'};
  }};
  if(name==='@tanstack/react-query')return {useQuery:value=>{options=value;return query;}};
  if(name==='react')return {useEffect(){},useRef:initial=>refs[refCursor++]??(refs[refCursor-1]={current:initial}),useState:initial=>{const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],value=>{slots[i]=value;}];}};
  if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
  if(name==='react-native')return {View:'View',Text:'Text',Pressable:'Pressable'};
  if(name==='@getpaseo/plugin/client/ui')return {Icon:'Icon'};
  if(name==='@getpaseo/plugin/client/react-native')return {Icon:'Icon'};
  return require(name);
 };
 const {GoalAgent}=(0,eval)(clientBundle)(load);
 const props={child,sessionId:'session',runtimeEpoch:'epoch',host:{id:'host'},agentId:'parent',workspaceId:'workspace',theme:{colors:{statusSuccess:'#63b887'}},onOpenAgent:id=>opened.push(id)};
 const nodes=n=>!n||typeof n!=='object'?[]:[n,...[n.props?.children].flat(Infinity).flatMap(nodes)];
 const draw=(extra={})=>{cursor=0;refCursor=0;return nodes(GoalAgent({...props,...extra}));};
 const button=all=>all.find(n=>n.type==='Pressable');const settle=()=>new Promise(resolve=>setImmediate(resolve));
 async function setup(extra={}){slots=[];refs.length=0;bound={available:true,sessionId:'session',runtimeEpoch:'epoch'};inventory={state:'available',sessionId:'session',stale:false,hierarchyPartial:false,items:[item],...extra};query={isError:false,isFetching:false};draw();query.data=await options.queryFn();}
 await setup();let all=draw();
 assert.equal(button(all).props.accessibilityLabel,'Open coordinator chat');assert.ok(all.some(n=>n.type==='Text'&&n.props.children==='Open chat'));
 assert.ok(!all.some(n=>['Running','Map Review'].includes(n.props.children)),'the owner line carries only the link, not a second agent row');
 button(all).props.onPress();await settle();
 assert.deepEqual(opened,['verified-child']);assert.deepEqual(calls[0],{agentId:'parent',workspaceId:'workspace',expectedSessionId:'session',expectedRuntimeEpoch:'epoch',taskId:child.taskId,childId:child.childId,groupId:child.jobId,runtimeId:'runtime',attempt:2});
 for(const extra of [{items:[]},{hierarchyPartial:true},{stale:true},{items:[{...item,attempt:1}]},{items:[{...item,reaped:true}]},{items:[{...item,stale:true}]},{items:[item,item]}]){
  await setup(extra);all=draw();assert.equal(button(all),undefined,JSON.stringify(extra));assert.deepEqual(all,[],'unverifiable inventory renders nothing, not a guessed link or status');
 }
 await setup({items:[{...item,paseoAgentId:undefined}]});all=draw();assert.equal(button(all),undefined,'no link without an available chat');assert.deepEqual(all,[]);
 await setup({items:[{...item,status:'completed',reaped:true,runtimeId:null,paseoAgentId:undefined,paseoWorkspaceId:undefined}]});all=draw();assert.equal(button(all),undefined,'a reaped coordinator has no chat link');
 await setup();assert.ok(button(draw({onOpenAgent:undefined}))===undefined,'no link when the host cannot navigate');
 await setup();query.isError=true;assert.equal(button(draw()),undefined);
 await setup();bound.runtimeEpoch='replacement';query.data=await options.queryFn();assert.equal(button(draw()),undefined);
 await setup();rejectRoute=true;button(draw()).props.onPress();await settle();assert.ok(draw().some(n=>n.props.accessibilityRole==='alert'));assert.deepEqual(opened,['verified-child']);
 rejectRoute=false;await setup();finish={};button(draw()).props.onPress();await settle();assert.equal(button(draw()).props.disabled,true);assert.ok(draw().some(n=>n.props.children==='Opening…'));
 draw({runtimeEpoch:'new-epoch'});finish.resolve({agentId:'stale-child'});await settle();assert.deepEqual(opened,['verified-child'],'late route response cannot navigate after source replacement');
});
