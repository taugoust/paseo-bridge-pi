import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const walk = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
const text = node => typeof node === 'string' ? node : !node || typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join(' ');

test('compiled Work replaces legacy task pills, lazily scopes foreground/background queries and opens the workspace destination', { skip: !compilerPath }, async () => {
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { clientBundle } = await compilePlugin({ client: resolve(root, 'index.client.tsx') });
  const observers = [], pills = [], panels = [], calls = [], queries = [], effects = [], opened = [];
  const slots = new Map(); let owner, cursor;
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  function visit(node, path = 'root') {
    if (Array.isArray(node)) return node.map((child, i) => visit(child, `${path}/${child?.key ?? i}`));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      path += `/${node.type.name}:${node.key ?? ''}`;
      if (!slots.has(path)) slots.set(path, []);
      owner = slots.get(path); cursor = 0;
      return visit(node.type(node.props), path);
    }
    return { ...node, props: { ...node.props, children: visit(node.props.children, `${path}/children`) } };
  }
  const useState = initial => { const local = owner, i = cursor++; if (!(i in local)) local[i] = typeof initial === 'function' ? initial() : initial; return [local[i], value => { local[i] = typeof value === 'function' ? value(local[i]) : value; }]; };
  const task = { taskId:'t1',childId:'c1',workerEpoch:'worker1',groupId:'g1',attempt:1,title:'Helper',model:'test/model',status:'waiting-permission',createdAt:'now',updatedAt:'now',pendingInteractions:1,canPrompt:true,canStop:true };
  const status = { available:true,sessionId:'session',runtimeEpoch:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',tasks:[task] };
  let backgroundJobs = [{jobId:'j1',name:'Build',status:'running',createdAt:new Date().toISOString()}];
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: c => c, defineSettings: c => c };
    if (name === '@getpaseo/plugin/client') return { useSettings: () => ({ status: 'loading' }), useRpc: contract => async input => { contract.input.parse(input); calls.push({name:contract.name,input}); return contract.name === 'harness_jobs_list' ? { protocol:1,state:'available',sessionId:'session',items:[],lastUpdated:null,stale:false } : {}; } };
    if (name === '@getpaseo/plugin/client/ui') return { SettingsAction:'SettingsAction', SettingsSection:'SettingsSection' };
    if (name === '@getpaseo/plugin/client/react-native') return { ScrollView:'ScrollView',TextInput:'TextInput',Icon:'Icon' };
    if (name === 'react-native') return { Text:'Text',View:'View',Pressable:'Pressable', Animated:{ Value:class { interpolate() { return 'rotation'; } }, View:'AnimatedView' }, Easing:{linear:x=>x}, AccessibilityInfo:{isReduceMotionEnabled:async()=>true,addEventListener:()=>({remove(){}})} };
    if (name === 'react/jsx-runtime') return { jsx,jsxs:jsx,Fragment:'Fragment' };
    if (name === 'react') return { Fragment:'Fragment', createElement:(type, props, ...children)=>jsx(type,{...props,...(children.length?{children}:{})},props?.key), useState, useRef:initial=>useState(()=>({current:initial}))[0], useEffect:fn=>{ const cleanup=fn(); if(cleanup) effects.push(cleanup); }, useLayoutEffect(){}, useMemo:fn=>fn(), useCallback:fn=>fn };
    if (name === '@tanstack/react-query') return { useQuery: options => {
      queries.push(options); const key=options.queryKey[0];
      const data=key==='harness-status'||key==='foreground-tasks'?status:key==='harness-list'?{state:'available',items:options.queryKey[1]==='jobs'?backgroundJobs:[{taskId:'t1',childId:'c1',title:'Helper',status:'running',attempt:1}]}:undefined;
      return {data,isPending:false,isError:false,isFetching:false,isStale:false,refetch:async()=>{}};
    }, useMutation:()=>({isPending:false,mutate(){throw Error('No mutation expected');}}) };
    return require(name);
  };
  const contribute=(0,eval)(clientBundle)(load).default;
  const cleanup=contribute({
    paseo:{config:{get:async()=>({config:{plugins:{'paseo-accounts':{enabled:true}}}})},agents:{list:async()=>({subscription:{subscribe:observer=>observers.push(observer)}})}},
    addScreen:()=>()=>{},openScreen(){},addWorkspacePanel:panel=>{panels.push(panel);return ()=>{};},addHeaderButton:()=>({update(){},remove(){}}), openPanel:(id,target)=>opened.push({id,target}),
    addComposerPill:pill=>{const registration={...pill,updates:[],removed:false,update(value){assert.equal(this.removed,false);this.updates.push(value);},remove(){this.removed=true;}};pills.push(registration);return registration;},
    rpc:async(contract,input)=>{calls.push({name:contract.name,input});return {available:false};},
  });
  const props={context:'agent',agentId:'a',workspaceId:'w',host:{id:'host',label:'Host'},layout:{platform:'web',compact:false},theme:{colors:{foreground:'#fff',foregroundMuted:'#aaa',statusDanger:'#f00',border:'#555',surface1:'#222'}}};
  try {
    await new Promise(resolve=>setImmediate(resolve));
    observers.forEach(observer=>observer.snapshot({entries:[{agent:{id:'a',workspaceId:'w',provider:'pi'}}]}));
    const control=pills.find(pill=>pill.id==='work'); assert.ok(control);
    assert.ok(!pills.some(pill=>['tasks','harness-jobs','harness-subagents','foreground-tasks'].includes(pill.id)));
    assert.equal(calls.filter(call=>/harness|foreground/.test(call.name)).length,0,'registration alone performs no task RPC');
    assert.equal(queries.length,0,'hidden controls mount no queries');
    const indicator = visit(jsx(control.button.icon,{...props,size:14,color:'#aaa'}));
    assert.ok(walk(indicator).some(n=>n.props.style?.backgroundColor==='#db932e'), 'waiting foreground permission produces the native attention ring');
    assert.equal(control.updates.at(-1).label,'1 job','foreground duplicate is excluded from worker counts');
    const savedJobs = backgroundJobs;
    backgroundJobs = []; task.status = 'waiting';
    const idleIndicator = visit(jsx(control.button.icon,{...props,size:14,color:'#aaa'}));
    assert.ok(walk(idleIndicator).some(n=>n.type === 'Icon' && n.props.name === 'Briefcase'), 'idle waiting-only work has no fake active spinner');
    assert.equal(control.updates.at(-1).label, '1 job', 'waiting remains retained nonterminal work');
    backgroundJobs = savedJobs; task.status = 'waiting-permission';
    assert.equal(control.button.behavior.kind,'action');
    control.button.behavior.onPress();
    assert.deepEqual(opened,[{id:'work',target:{workspaceId:'w',location:'workspace'}}]);
    const panel=panels.find(panel=>panel.id==='work');
    assert.equal(panel.context,'workspace');
    const render=()=>{queries.length=0;return visit(jsx(panel.Component,{...props,context:'workspace'}));};
    let tree=render();
    assert.match(text(tree),/Helper/);
    assert.match(text(tree),/Build/);
    assert.ok(walk(tree).some(n=>n.type==='ScrollView'),'workspace Work owns bounded scrolling');
    assert.deepEqual(walk(tree).filter(n=>n.props.accessibilityRole==='tab').map(n=>text(n)),['Jobs','Agents','Worktrees','Goals']);
    const bound=queries.find(q=>q.queryKey[0]==='harness-list'&&q.queryKey[1]==='jobs');
    await bound.queryFn();
    assert.deepEqual(calls.at(-1).input,{agentId:'a',workspaceId:'w',expectedSessionId:'session',expectedRuntimeEpoch:status.runtimeEpoch,limit:50});
    assert.ok(bound.queryKey.includes('host'));
    assert.ok(queries.find(q=>q.queryKey[0]==='foreground-tasks').queryKey.includes('a'));
    const agentsTab=walk(tree).find(n=>n.props.accessibilityRole==='tab'&&text(n)==='Agents');
    agentsTab.props.onPress(); tree=render();
    assert.ok(walk(tree).find(n=>n.props.accessibilityRole==='tab'&&text(n)==='Agents').props.accessibilityState.selected);
    assert.doesNotMatch(text(tree),/Helper/,'foreground task is not duplicated in Agents');
    assert.equal(opened.length,1,'section changes do not open legacy panels');
    const prior=control.updates.length;
    observers.forEach(observer=>observer.update({type:'agent_update',payload:{kind:'remove',agentId:'a'}}));
    visit(jsx(control.button.icon,{...props,size:14,color:'#aaa'}));
    assert.equal(control.removed,true); assert.equal(control.updates.length,prior,'removed controls ignore late summaries');
    assert.match(text(render()),/Select Work/);
    assert.equal(queries.length,0,'removed source cannot keep querying');
  } finally {effects.forEach(fn=>fn());cleanup();}
});
