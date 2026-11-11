import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import net from 'node:net';
import {BridgeTransport} from '../../extension/bridge-transport.ts';
import {writeAccountControlsDescriptor,accountControlsSocketPath} from '../../extension/account-controls-operator.js';
const require=createRequire(import.meta.url);
const compiler=process.env.PASEO_PLUGIN_COMPILER;
const source=process.env.PI_AGENT_EXTENSIONS_SOURCE;
const enabled=process.env.PAE_ACCOUNTS_RUNTIME_TEST==='1';

test('actual Pi Codex account service switches via compiled Paseo private transport '
 +'without model calls or context changes',{skip:!enabled,timeout:20000},async()=>{
 assert.ok(compiler&&source,'explicit compiler and extension source are required');
 const accountsModule=join(source,'openai-accounts/accounts.ts');
 const sdkDir=dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
 const {createJiti}=await import(pathToFileURL(join(sdkDir,'../node_modules/jiti/lib/jiti.mjs')));
 const jiti=createJiti(import.meta.url);
 const accounts=await jiti.import(accountsModule);
 const {createAgentSession,AgentSessionRuntime,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager}=await import('@earendil-works/pi-coding-agent');
 const {compilePlugin}=await import(pathToFileURL(resolve(compiler)));
 const {serverBundle}=await compilePlugin({server:fileURLToPath(new URL('../index.server.ts',import.meta.url))});
 const root=await mkdtemp(join(tmpdir(),'account-live-runtime-'));
 const originalFetch=globalThis.fetch;let network=0;globalThis.fetch=async()=>{network++;throw Error('NETWORK FORBIDDEN');};
 let session,owner,client,transport,cleanup;
 const sends=[];
 try {
  const store=new accounts.AccountStore(new accounts.InMemoryAccountStorageBackend());
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const codexToken=`${encode({alg:'none'})}.${encode({sub:'fixture-codex-subject','https://api.openai.com/auth':{chatgpt_account_id:'fixture-codex-account'}})}.fixture-signature`;
  const codexAccount=access=>({type:'oauth',access,refresh:'fixture-codex-refresh',
   expires:Date.now()+86400000,accountId:'fixture-codex-account'});
  const codexAccounts={alpha:codexAccount(codexToken),beta:codexAccount(`${codexToken}-beta`)};
  await store.updateProvider('openai-codex',state=>({...state,accounts:codexAccounts}));
  const runtime=await ModelRuntime.create({authPath:join(root,'auth.json'),modelsPath:null,modelsStorePath:join(root,'models'),allowModelNetwork:false,refreshOnCreate:false});
  const settings=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
  const factory=pi=>{
   pi.registerProvider('openai-codex',{api:'openai-codex-responses',
    baseUrl:'https://chatgpt.com/backend-api',
    streamSimple(){sends.push('codex');throw Error('No model calls allowed');}});
   accounts.default(pi,{store});
  };
  const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[factory]});await loader.reload();
  const result=await createAgentSession({cwd:root,agentDir:root,modelRuntime:runtime,settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.create(root,join(root,'sessions')),noTools:'builtin'});session=result.session;
  owner=new AgentSessionRuntime(session,{cwd:root,agentDir:root,modelRuntime:runtime,settingsManager:settings,resourceLoader:loader,diagnostics:[]},async()=>{throw Error('Unexpected replacement');});
  const errors=[];await session.bindExtensions({onError:error=>errors.push(error)});
  assert.deepEqual(errors,[]);
  const service=globalThis.__paeAccountControlsV1;assert.ok(service);
  const sessionId=session.sessionManager.getSessionId();
  transport=new BridgeTransport(join(root,'session.jsonl'),join(root,'bridge.sock'));
  const identity=()=>({agentId:'agent',sessionId,runtimeEpoch:transport.operatorEpoch,serviceEpoch:service.serviceEpoch,capability:transport.accountControlsCapability});
  transport.bind({command:async()=>{throw Error('No prompt commands allowed');},attached(){},detached(){},error:error=>errors.push(error),accountControlsIdentity:identity,
   accountControls:request=>request.operation==='snapshot'
    ?service.getSnapshot({sessionId,providerId:request.providerId})
    :service.switchAccount(request.request)});
  transport.start();client=net.connect(transport.pipePath);await once(client,'connect');
  writeAccountControlsDescriptor(join(root,'.pi/paseo-bridge'),{version:1,socketPath:accountControlsSocketPath(transport.pipePath),...identity()});
  const handlers=new Map();const load=name=>name==='@getpaseo/plugin'?{defineRpc:contract=>contract,defineSettings:contract=>contract}:name==='node:os'?{...require(name),homedir:()=>root}:require(name);
  cleanup=(0,eval)(serverBundle)(load).default({registerSettings(){},handle:(contract,handler)=>handlers.set(contract.name,{contract,handler}),registerUsageSource:()=>()=>{},before:()=>()=>{}});
  const context={paseo:{agents:{ref:id=>({refresh:async()=>({agent:{id,workspaceId:'workspace',provider:'pi'}})})}}};
  const invoke=async(name,input)=>{const {contract,handler}=handlers.get(name);return contract.output.parse(await handler(contract.input.parse(input),context));};
  const target={agentId:'agent',workspaceId:'workspace'};
  const status=await invoke('account_controls_status',{...target,providerId:'openai-codex'});
  assert.equal(status.available,true);assert.equal(status.snapshot.providerId,'openai-codex');
  assert.equal(status.snapshot.canSwitch,true);assert.equal(status.snapshot.defaultSelected,true);
  const messagesBefore=JSON.stringify(session.messages);
  const request={protocol:1,requestId:randomUUID(),expectedSessionId:sessionId,
   expectedServiceEpoch:service.serviceEpoch,
   expectedSelectionRevision:status.snapshot.selectionRevision,
   providerId:'openai-codex',accountId:'alpha'};
  const input={...target,expectedSessionId:sessionId,
   expectedRuntimeEpoch:transport.operatorEpoch,request};
  const switched=await invoke('account_controls_switch',input);
  assert.equal(switched.ok,true,JSON.stringify(switched));
  assert.equal(switched.snapshot.currentAccountId,'alpha');
  assert.equal(switched.snapshot.providerId,'openai-codex');
  assert.equal(JSON.stringify(switched).includes(codexToken),false);
  assert.equal(JSON.stringify(session.messages),messagesBefore);
  assert.deepEqual(await invoke('account_controls_switch',input),switched);
  const conflict=await invoke('account_controls_switch',
   {...input,request:{...request,accountId:'beta'}});
  assert.equal(conflict.ok,false);assert.equal(conflict.reason,'request-id-conflict');
  const restored=await invoke('account_controls_switch',{...input,request:{...request,
   requestId:randomUUID(),expectedSelectionRevision:switched.snapshot.selectionRevision,
   accountId:null}});
  assert.equal(restored.ok,true);assert.equal(restored.snapshot.defaultSelected,true);
  assert.equal(JSON.stringify(session.sessionManager.getEntries()).includes(codexToken),false);
  assert.deepEqual(sends,[]);assert.equal(network,0);assert.deepEqual(errors,[]);
 }finally{cleanup?.();client?.destroy();transport?.close();await session?.abort();await owner?.dispose();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
});
