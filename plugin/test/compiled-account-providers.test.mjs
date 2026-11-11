import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { cp, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiler = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compiler, 'PASEO_PLUGIN_COMPILER is required');
const require = createRequire(resolve(compiler));
const root = await mkdtemp(resolve(tmpdir(), 'account-providers-'));
after(() => rm(root,{recursive:true,force:true}));
const source = fileURLToPath(new URL('../',import.meta.url));
for (const directory of ['server','shared']) await cp(resolve(source,directory),resolve(root,directory),{recursive:true});
await writeFile(resolve(root,'index.server.ts'),[
 'export { createAccountControlsHandlers } from "./server/account-controls";',
 'import { accountControlsStatusRpc, accountControlsSwitchRpc } from "./shared/account-controls";',
 // Function exports survive the compiled bundle; plain const exports do not.
 'export function rpcs() {',
 '  return { status: accountControlsStatusRpc, switch: accountControlsSwitchRpc };',
 '}',
].join('\n'));
const {compilePlugin} = await import(pathToFileURL(resolve(compiler)));
const {serverBundle} = await compilePlugin({server:resolve(root,'index.server.ts')});
const load=name=>name==='@getpaseo/plugin'?{defineRpc:value=>value}:require(name);
const {createAccountControlsHandlers,rpcs}=(0,eval)(serverBundle)(load);
const {status:accountControlsStatusRpc,switch:accountControlsSwitchRpc}=rpcs();
const runtimeEpoch = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const context = {paseo:{agents:{ref:()=>({refresh:async()=>({agent:{id:'agent',workspaceId:'workspace',provider:'pi'}})})}}};
const target = {agentId:'agent',workspaceId:'workspace'};
const descriptor = {version:1,socketPath:'/tmp/synthetic-account-controls.sock',capability:'a'.repeat(64),agentId:'agent',sessionId:'session',runtimeEpoch,serviceEpoch:'service'};
function snapshot(overrides={}) {
 return {protocol:1,serviceEpoch:'service',selectionRevision:2,sessionId:'session',
  providerId:'openai-codex',accounts:[{id:'same-name',label:'Work',authKind:'oauth'}],
  currentAccountId:null,defaultSelected:true,activationStatus:'inactive',busy:false,canSwitch:true,
  usage:{effectiveCredential:'chatgpt-grant-configured',status:'local-binding-confirmed',
   remoteEntitlement:'not-queried',settingsUrl:'https://chatgpt.com/settings/usage'},
  ...overrides};
}
function switchInput(providerId='openai-codex') {
 return {...target,expectedSessionId:'session',expectedRuntimeEpoch:runtimeEpoch,
  request:{protocol:1,requestId:'11111111-1111-4111-a111-111111111111',expectedSessionId:'session',
   expectedServiceEpoch:'service',expectedSelectionRevision:2,accountId:'same-name',
   ...(providerId?{providerId}:{})}};
}
test('server rejects substituted chat or workspace before any account transport call',async()=>{
 let calls=0;
 const handlers=createAccountControlsHandlers(async()=>{calls++;return {...descriptor};},
  async()=>{calls++;throw new Error('must not call');});
 for(const input of [{...switchInput(),agentId:'sibling'},{...switchInput(),workspaceId:'other'}])
  await assert.rejects(handlers.switch(input,context),/does not match/);
 assert.equal(calls,0);
});
test('clear inheritance intent is forwarded distinctly from explicit default login',async()=>{
 const calls=[];
 const value=snapshot({inheritance:'explicit'});
 const handlers=createAccountControlsHandlers(async()=>({...descriptor}),async(_d,request)=>{
  calls.push(request);
  if(request.operation==='snapshot') return value;
  return {ok:true,requestId:request.request.requestId,snapshot:value};
 });
 const input=switchInput(); input.request.accountId=null; input.request.inherit=true;
 assert.equal((await handlers.switch(input,context)).snapshot.inheritance,'explicit');
 assert.equal(calls.at(-1).request.inherit,true);assert.equal(calls.at(-1).request.accountId,null);
});
test('status and switch requests always carry providerId openai-codex',async()=>{
 const calls=[];
 const handlers=createAccountControlsHandlers(async()=>({...descriptor}),async(_d,request)=>{
  calls.push(request);
  if(request.operation==='snapshot') return snapshot();
  return {ok:true,requestId:request.request.requestId,snapshot:snapshot()};
 });
 const status=await handlers.status({...target,providerId:'openai-codex'},context);
 assert.equal(status.available,true);assert.equal(status.snapshot.providerId,'openai-codex');
 assert.deepEqual(calls[0],{operation:'snapshot',sessionId:'session',providerId:'openai-codex'});
 const result=await handlers.switch(switchInput(),context);
 assert.equal(result.ok,true);assert.equal(result.snapshot.providerId,'openai-codex');
 assert.deepEqual(calls.map(call=>call.operation),['snapshot','switch']);
 assert.equal(calls[1].request.providerId,'openai-codex');
 assert.equal(calls[1].request.accountId,'same-name');
});
test('requests for openai or without a provider are rejected before any transport call',async()=>{
 let calls=0;
 const handlers=createAccountControlsHandlers(async()=>{calls++;return {...descriptor};},
  async()=>{calls++;return snapshot();});
 for(const providerId of [undefined,'openai']) {
  const status={...target,...(providerId?{providerId}:{})};
  await assert.rejects(handlers.status(status,context),/Unsupported account provider/);
  await assert.rejects(handlers.switch(switchInput(providerId??null),context),
   /Unsupported account provider/);
 }
 assert.equal(calls,0);
});
test('RPC schemas require openai-codex and reject unknown snapshot fields',()=>{
 const status=accountControlsStatusRpc.input;
 assert.equal(status.safeParse({...target,providerId:'openai-codex'}).success,true);
 for(const input of [target,{...target,providerId:'openai'}])
  assert.equal(status.safeParse(input).success,false);
 const request=accountControlsSwitchRpc.input;
 assert.equal(request.safeParse(switchInput()).success,true);
 for(const providerId of [null,'openai'])
  assert.equal(request.safeParse(switchInput(providerId)).success,false);
 const output=accountControlsStatusRpc.output;
 const ok=value=>output.safeParse(
  {available:true,sessionId:'session',runtimeEpoch,snapshot:value,reason:null}).success;
 assert.equal(ok(snapshot()),true);
 const {providerId:_omitted,...withoutProvider}=snapshot();
 for(const value of [withoutProvider,snapshot({providerId:'openai'}),
  snapshot({providers:['openai-codex']}),snapshot({routing:{version:1}}),
  snapshot({usage:{...snapshot().usage,registrationVersion:1}})])
  assert.equal(ok(value),false,JSON.stringify(value));
});
test('a non-Codex snapshot from the service is rejected',async()=>{
 const other=snapshot({providerId:'openai'});
 const handlers=createAccountControlsHandlers(async()=>({...descriptor}),async(_d,request)=>
  request.operation==='snapshot'?other
   :{ok:true,requestId:request.request.requestId,snapshot:other});
 const status=await handlers.status({...target,providerId:'openai-codex'},context);
 assert.equal(status.available,false);
 await assert.rejects(handlers.switch(switchInput(),context));
});
