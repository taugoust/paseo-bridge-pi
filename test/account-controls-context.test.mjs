import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('account controls tolerate fresh wrappers but reject changed authenticated identity',()=>{
 const source=readFileSync(new URL('../extension/index.ts',import.meta.url),'utf8');
 const section=source.slice(source.indexOf('async accountControls(request: any)'));
 const body=section.match(/const assertCurrent = \(\) => \{([\s\S]*?)\n        \};/)[1];
 const check=new Function('transport','t','latestCtx','service','activeAccountControlsService','currentAgentId','identity','currentSessionFile',body.replaceAll('(globalThis as any)', 'globalThis'));
 const service={};globalThis.__paeAccountControlsV1=service;
 const t={connected:true,sessionFile:'file',operatorEpoch:'runtime'};
 const identity={agentId:'agent',sessionId:'session',runtimeEpoch:'runtime'};
 const run=(ctx,transport=t,active=service,id=identity)=>check(transport,t,ctx,service,()=>active,'agent',id,'file');
 try {
  run({sessionManager:{getSessionId:()=> 'session'}});
  run({sessionManager:{getSessionId:()=> 'session'}});
  assert.throws(()=>run({sessionManager:{getSessionId:()=> 'other'}}),/identity changed/);
  assert.throws(()=>run(null),/identity changed/);
  assert.throws(()=>run({},{}),/identity changed/);
  assert.throws(()=>run({},t,{}),/identity changed/);
  assert.throws(()=>run({},t,service,{...identity,agentId:'other'}),/identity changed/);
 }finally{delete globalThis.__paeAccountControlsV1;}
});
