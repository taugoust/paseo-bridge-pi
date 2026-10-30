import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { once } from 'node:events';
import { createBtwEndpoint } from '../../extension/btw-operator.js';
import { writeWorkflowsDescriptor } from '../../extension/workflows-operator.js';

const compilerPath=process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compilerPath,'PASEO_PLUGIN_COMPILER is required');
const require=createRequire(resolve(compilerPath));
const {compilePlugin}=await import(pathToFileURL(resolve(compilerPath)));
const {serverBundle}=await compilePlugin({server:fileURLToPath(new URL('../index.server.ts',import.meta.url))});

test('compiled delegated controls cross the real private bridge with session/runtime/workspace fences',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'delegated-bridge-'));
 const identity={agentId:'isolated-agent',sessionId:'isolated-session',serviceEpoch:randomUUID(),runtimeEpoch:randomUUID(),capability:'d'.repeat(64)};
 const snapshot={protocol:1,sessionId:identity.sessionId,serviceEpoch:identity.serviceEpoch,cwd:dir,model:'fixture/gpt-6.1-sol',idle:false,busy:false,notice:null,operationId:null,operationAction:null,protectedPaths:[],dialog:null,worktrees:[],worktreeError:null,worktreeLoading:false,goal:null,lastCompletion:null,completedGoals:[],limits:{automaticTurns:3,noProgressTurns:2},capabilities:{createPausedGoal:false,delegatedGoals:true,delegatedGoalExecution:true,goalLimitEditing:true},delegatedGoals:{version:1,revision:0,entries:[]}};
 const received=[];
 const endpoint=createBtwEndpoint(join(dir,'bridge'),()=>({btwIdentity:()=>identity,btw:async request=>{
  received.push(request);
  if(request.sessionId!==identity.sessionId||request.serviceEpoch!==identity.serviceEpoch)throw Error('Stale fixture service identity');
  if(request.operation==='snapshot')return snapshot;
  if(request.operation==='review')return {sessionId:identity.sessionId,serviceEpoch:identity.serviceEpoch,preview:{kind:'text',text:'Explicitly registered file'}};
  if(request.action==='goals.edit')throw Error('Metadata edit rejected by the core service');
  if(['goals.limits','goal.limits'].includes(request.action))return snapshot;
  assert.equal(request.action,'goals.create');assert.equal(request.expectedGoalId,null);
  snapshot.delegatedGoals.entries.push({id:randomUUID(),revision:1,text:request.objective,status:'paused',tasks:[],child:null,tokenBudget:null,tokensUsed:0,automaticTurns:0,noProgressTurns:0,summary:null,waiting:null});
  snapshot.delegatedGoals.revision++;
  return snapshot;
 }}),'workflows','.workflows');
 try {
  const probe=connect(join(dir,'bridge.workflows'));await once(probe,'connect');probe.destroy();
  writeWorkflowsDescriptor(join(dir,'.pi','paseo-bridge'),{version:1,socketPath:join(dir,'bridge.workflows'),...identity});
  const handlers=new Map();
  (0,eval)(serverBundle)(name=>name==='@getpaseo/plugin'?{defineRpc:value=>value,defineSettings:value=>value}:name==='node:os'?{...require(name),homedir:()=>dir}:require(name)).default({handle:(contract,handler)=>handlers.set(contract.name,{contract,handler}),registerSettings(){},registerUsageSource:()=>()=>{},before:()=>()=>{}});
  let wrongWorkspace=false;
  const context={paseo:{agents:{ref:()=>({refresh:async()=>({agent:{id:identity.agentId,workspaceId:wrongWorkspace?'foreign':'isolated-workspace',provider:'pi'}})})}}};
  async function invoke(name,input){const {contract,handler}=handlers.get(name);return contract.output.parse(await handler(contract.input.parse(input),context));}
  const target={agentId:identity.agentId,workspaceId:'isolated-workspace'};
  const before=await invoke('workflows_status',target);assert.equal(before.snapshot.idle,false);
  const input={...target,expectedRuntimeEpoch:identity.runtimeEpoch,request:{sessionId:identity.sessionId,serviceEpoch:identity.serviceEpoch,requestId:randomUUID(),operation:'start',action:'goals.create',expectedGoalId:null,objective:'Save paused metadata without interrupting the parent'}};
  const result=await invoke('workflows_control',input);
  assert.equal(result.snapshot.delegatedGoals.entries.length,1);
  assert.equal(result.snapshot.delegatedGoals.entries[0].status,'paused');assert.equal(result.snapshot.delegatedGoals.entries[0].child,null);
  assert.equal(result.snapshot.goal,null);assert.equal(result.snapshot.idle,false);
  await assert.rejects(invoke('workflows_control',{...input,request:{...input.request,requestId:randomUUID(),action:'goals.edit',expectedGoalId:result.snapshot.delegatedGoals.entries[0].id,expectedEntryRevision:1,objective:'Do not apply this rejected edit'}}),/request failed/);
  assert.equal(snapshot.delegatedGoals.entries[0].text,input.request.objective,'core metadata rejection must not be presented as an applied mutation');
  const limits={...input.request,requestId:randomUUID(),action:'goals.limits',objective:undefined,expectedGoalId:result.snapshot.delegatedGoals.entries[0].id,expectedPolicyRevision:1,tokenBudget:null,continuationLimits:{automaticTurns:2,noProgressTurns:null}};
  const updated=await invoke('workflows_control',{...input,request:limits});assert.equal(updated.snapshot.capabilities.goalLimitEditing,true);
  assert.equal(received.at(-1).action,'goals.limits');assert.equal(received.at(-1).expectedPolicyRevision,1);assert.equal(received.at(-1).tokenBudget,null);
  snapshot.goal={id:'assigned-contract',text:'Keep assigned objective',status:'active',tasks:[],waiting:null,iteration:1,tokensUsed:100,tokenBudget:null,automaticTurns:8,noProgressTurns:3,safetyPauseCause:null,summary:null,policyRevision:7,continuationLimits:{automaticTurns:10},effectiveLimits:{automaticTurns:10,noProgressTurns:2}};
  const assigned=await invoke('workflows_control',{...input,request:{...limits,requestId:randomUUID(),action:'goal.limits',expectedGoalId:'assigned-contract',expectedActivationId:'activation-1',expectedPolicyRevision:7}});
  assert.equal(assigned.snapshot.goal.policyRevision,7);assert.equal(received.at(-1).action,'goal.limits');assert.equal(received.at(-1).expectedPolicyRevision,7);
  const reviewInput={...target,expectedRuntimeEpoch:identity.runtimeEpoch,sessionId:identity.sessionId,serviceEpoch:identity.serviceEpoch,expectedGoalId:result.snapshot.delegatedGoals.entries[0].id,expectedEntryRevision:1,referenceId:randomUUID()};
  assert.deepEqual(await invoke('workflows_review',reviewInput),{kind:'text',text:'Explicitly registered file'});
  assert.equal(received.at(-1).referenceId,reviewInput.referenceId);
  await assert.rejects(invoke('workflows_review',{...reviewInput,path:'/etc/passwd'}));
  await assert.rejects(invoke('workflows_review',{...reviewInput,expectedRuntimeEpoch:randomUUID()}));
  await assert.rejects(invoke('workflows_review',{...reviewInput,serviceEpoch:randomUUID()}));
  const count=received.length;
  await assert.rejects(invoke('workflows_control',{...input,expectedRuntimeEpoch:randomUUID()}));
  await assert.rejects(invoke('workflows_control',{...input,request:{...input.request,serviceEpoch:randomUUID()}}));
  await assert.rejects(invoke('workflows_control',{...input,request:{...input.request,sessionId:'foreign'}}));
  wrongWorkspace=true;await assert.rejects(invoke('workflows_control',input));
  assert.equal(received.length,count,'stale targets must not reach the core service');
 } finally {endpoint.close();await rm(dir,{recursive:true,force:true});}
});
