import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { cp, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compilerPath=process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compilerPath,'PASEO_PLUGIN_COMPILER is required');
const require=createRequire(resolve(compilerPath));
const {compilePlugin}=await import(pathToFileURL(resolve(compilerPath)));
const fixture=await mkdtemp(resolve(tmpdir(),'delegated-goals-ui-'));
after(()=>rm(fixture,{recursive:true,force:true}));
for(const directory of ['client','shared']) await cp(fileURLToPath(new URL(`../${directory}`,import.meta.url)),resolve(fixture,directory),{recursive:true});
await writeFile(resolve(fixture,'index.client.tsx'),'export { DelegatedGoals } from "./client/delegated-goals"; export { goalAgentRoute } from "./shared/goal-agent"; export { GoalReview } from "./client/goal-review"; export { GoalQuestionAttachments } from "./client/goal-question-attachments";');
await writeFile(resolve(fixture,'index.server.ts'),'import { goalStorySchema, workflowRequestSchema, goalReviewReferenceSchema, delegatedGoalEntrySchema } from "./shared/workflows"; export default function schemas() { return { goalStorySchema, workflowRequestSchema, goalReviewReferenceSchema, delegatedGoalEntrySchema }; }');
const {clientBundle,serverBundle}=await compilePlugin({client:resolve(fixture,'index.client.tsx'),server:resolve(fixture,'index.server.ts')});
const schemas=(0,eval)(serverBundle)(name=>name==='@getpaseo/plugin'?{defineRpc:value=>value}:require(name)).default();
const colors={foreground:'#eee',foregroundMuted:'#999',surface1:'#222',surface2:'#333',border:'#444',accent:'#eee',accentForeground:'#111',statusWarning:'#fa0',statusDanger:'#f66',statusSuccess:'#63b887'};
function harness(options={}) {
 const states=new Map();let context,locale=options.locale;
 const translationApi=locale===undefined?{}:{defineTranslations:definition=>{for(const [key,value]of Object.entries(definition.resources['zh-CN'])){assert.ok(key in definition.resources.en);assert.deepEqual([...value.matchAll(/{{([^}]+)}}/g)].map(m=>m[1]).sort(),[...definition.resources.en[key].matchAll(/{{([^}]+)}}/g)].map(m=>m[1]).sort());}return definition;},useTranslation:messages=>({locale,t:(key,values)=>{let text=messages.resources[locale]?.[key]??messages.resources.en[key];assert.equal(typeof text,'string');return text.replace(/{{([^}]+)}}/g,(_,name)=>String(values?.[name]??''));}})};
 const jsx=(type,props)=>({type,props:props??{}});
 const load=name=>{
  if(name==='react')return {
   useState(initial){const local=context;const i=local.cursor++;if(!(i in local.slots))local.slots[i]=typeof initial==='function'?initial():initial;return [local.slots[i],next=>{local.slots[i]=typeof next==='function'?next(local.slots[i]):next;}];},
   useSyncExternalStore(_subscribe,get){return get();},
   useRef(initial){const local=context;const i=local.cursor++;if(!(i in local.slots))local.slots[i]={current:initial};return local.slots[i];},
   useEffect(){},
  };
  if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
  if(name==='react-native')return {View:'View',Text:'Text',Pressable:'Pressable',Image:'Image'};
  if(name==='@getpaseo/plugin/client')return {openExternalUrl:async()=>{},...translationApi};
  if(name==='@getpaseo/plugin/client/react-native')return {TextInput:'TextInput',ScrollView:'ScrollView'};
  if(name==='@getpaseo/plugin/client/ui')return {Icon:'Icon',SettingsSection:'SettingsSection',SettingsCard:'SettingsCard',SettingsAction:'SettingsAction',Modal:Object.assign(props=>jsx('Modal',props),{Content:'ModalContent'})};
  return require(name);
 };
 const {DelegatedGoals,goalAgentRoute,GoalReview,GoalQuestionAttachments}=(0,eval)(clientBundle)(load);
 function walk(node,path='root') {
  if(Array.isArray(node))return node.flatMap((item,index)=>walk(item,`${path}/${index}`));
  if(!node||typeof node!=='object')return [];
  if(typeof node.type==='function'){
   const key=`${path}:${node.type.name}:${node.props.key??''}`;const slots=states.get(key)??[];states.set(key,slots);context={slots,cursor:0};return walk(node.type(node.props),key);
  }
  return [node,...walk(node.props.children,`${path}/children`)];
 }
 return {draw:props=>walk({type:DelegatedGoals,props}),drawReview:props=>walk({type:GoalReview,props}),drawAttachments:props=>walk({type:GoalQuestionAttachments,props}),remount:()=>states.clear(),setLocale:next=>{locale=next;},goalAgentRoute};
}
const entry=(id,status='paused')=>({id,revision:2,text:`Goal ${id}`,status,tasks:[],child:null,tokenBudget:null,tokensUsed:0,automaticTurns:0,noProgressTurns:0,summary:null,waiting:null});
const button=(nodes,label)=>nodes.find(node=>node.type==='Pressable'&&node.props.accessibilityLabel===label);
const textbox=(nodes,label)=>nodes.find(node=>node.type==='TextInput'&&node.props.accessibilityLabel===label);
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('compiled multi-goal creation is independent of parent idle and uses explicit paused registry action',async()=>{
 const h=harness();const calls=[];const props={registry:{version:1,revision:4,entries:[]},colors,identity:'creation-session',locked:false,busy:false,executionAvailable:false,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);assert.equal(button(nodes,'Create').props.disabled,true);
 textbox(nodes,'New goal').props.onChangeText('Ship independent children');
 nodes=h.draw(props);assert.equal(button(nodes,'Create').props.disabled,false);
 textbox(nodes,'Goal token budget').props.onChangeText('1.5');nodes=h.draw(props);assert.equal(button(nodes,'Create').props.disabled,true);
 textbox(nodes,'Goal token budget').props.onChangeText('');nodes=h.draw(props);
 button(nodes,'Create').props.onPress();await tick();
 assert.deepEqual(calls,[{operation:'start',action:'goals.create',expectedGoalId:null,objective:'Ship independent children',continuationLimits:{automaticTurns:null,noProgressTurns:null}}]);
 props.locked=true;nodes=h.draw(props);assert.equal(button(nodes,'Create').props.disabled,true);
 props.locked=false;props.busy=true;nodes=h.draw(props);assert.equal(button(nodes,'Create').props.disabled,true);
});

test('compiled limit fields inherit configured defaults, validate and submit explicit overrides',async()=>{
 const h=harness(),calls=[];
 const props={registry:{version:1,revision:0,entries:[]},colors,identity:'limit-fields',locked:false,busy:false,executionAvailable:true,model:'fixture',limits:{automaticTurns:null,noProgressTurns:5},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);
 assert.equal(textbox(nodes,'Goal automatic responses').props.placeholder,'Default: Unlimited');
 assert.equal(textbox(nodes,'Goal no-progress responses').props.placeholder,'Default: 5');
 textbox(nodes,'New goal').props.onChangeText('Test overrides');
 textbox(nodes,'Goal automatic responses').props.onChangeText('8');
 textbox(nodes,'Goal no-progress responses').props.onChangeText('0');
 nodes=h.draw(props);assert.equal(button(nodes,'Create').props.disabled,true);
 textbox(nodes,'Goal no-progress responses').props.onChangeText('2');nodes=h.draw(props);
 button(nodes,'Create').props.onPress();await tick();
 assert.deepEqual(calls[0].continuationLimits,{automaticTurns:8,noProgressTurns:2});
});

test('selection and draft survive compact host remount, with active-child clear guarded',async()=>{
 const h=harness();const calls=[];const first=entry('first','active'),second=entry('second');
 first.child={taskId:'task-one',childId:'child-one',jobId:'job-one',attempt:1};
 const props={registry:{version:1,revision:3,entries:[first,second]},colors,identity:'remount-session',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,'Goal first').props.onPress();nodes=h.draw(props);
 assert.equal(button(nodes,'Clear').props.disabled,true);
 assert.equal(button(nodes,'Edit').props.disabled,true);
 button(nodes,'Pause').props.onPress();await tick();assert.equal(calls[0].action,'goals.pause');assert.equal(calls[0].expectedEntryRevision,2);
 h.remount();nodes=h.draw(props);assert.ok(button(nodes,'Pause'),'selection survives frame remount');
 button(nodes,'Back to goals').props.onPress();nodes=h.draw(props);button(nodes,'New goal').props.onPress();nodes=h.draw(props);
 textbox(nodes,'New goal').props.onChangeText('Retain this draft');
 h.remount();nodes=h.draw(props);assert.equal(textbox(nodes,'New goal').props.value,'Retain this draft');
});

test('edit submits the seeded revision rather than overwriting a newer registry entry',async()=>{
 const h=harness();const calls=[];const goal=entry('edit');goal.continuationLimits={automaticTurns:8,noProgressTurns:2};
 const props={registry:{version:1,revision:1,entries:[goal]},colors,identity:'edit-session',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,'Goal edit').props.onPress();nodes=h.draw(props);button(nodes,'Edit').props.onPress();nodes=h.draw(props);
 assert.equal(textbox(nodes,'Goal automatic responses').props.value,'8');assert.equal(textbox(nodes,'Goal no-progress responses').props.value,'2');
 textbox(nodes,'Goal automatic responses').props.onChangeText('');textbox(nodes,'Goal no-progress responses').props.onChangeText('');
 textbox(nodes,'Goal objective').props.onChangeText('My draft');
 nodes=h.draw(props);button(nodes,'Save changes').props.onPress();await tick();
 goal.revision=3;h.remount();nodes=h.draw(props);
 assert.equal(button(nodes,'Save changes').props.disabled,true,'changed revision requires review, even after remount');
 button(nodes,'Save changes').props.onPress();await tick();assert.equal(calls.length,1);
 assert.equal(calls[0].expectedEntryRevision,2);assert.equal(calls[0].objective,'My draft');assert.equal(calls[0].tokenBudget,null,'empty edit budget explicitly restores unlimited');assert.deepEqual(calls[0].continuationLimits,{automaticTurns:null,noProgressTurns:null},'clearing existing overrides restores parent inheritance');
});

test('successful create selects its own new entry even when objectives are equal',async()=>{
 const h=harness();const calls=[];const existing=entry('existing');existing.text='Same outcome';
 const props={registry:{version:1,revision:1,entries:[existing]},colors,identity:'successful-create',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{
  calls.push(fields);if(fields.action!=='goals.create')return false;
  const created=entry('created');created.text=fields.objective;
  props.registry={...props.registry,revision:2,entries:[existing,created]};return {snapshot:{delegatedGoals:props.registry}};
 }};
 let nodes=h.draw(props);button(nodes,'New goal').props.onPress();nodes=h.draw(props);textbox(nodes,'New goal').props.onChangeText('Same outcome');
 nodes=h.draw(props);button(nodes,'Create').props.onPress();await tick();nodes=h.draw(props);button(nodes,'Start').props.onPress();await tick();
 assert.equal(calls[1].expectedGoalId,'created');assert.equal(calls[1].action,'goals.start');
});

test('ambiguous concurrent creations require selection instead of guessing a goal identity',async()=>{
 const h=harness();const existing=entry('known');const props={registry:{version:1,revision:1,entries:[existing]},colors,identity:'concurrent-create',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{
  const own=entry('own'),other=entry('other');own.text=other.text=fields.objective;
  props.registry={version:1,revision:3,entries:[existing,own,other]};return {snapshot:{delegatedGoals:props.registry}};
 }};
 let nodes=h.draw(props);nodes.find(node=>node.props.onLayout).props.onLayout({nativeEvent:{layout:{width:1100}}});nodes=h.draw(props);
 button(nodes,'New goal').props.onPress();nodes=h.draw(props);textbox(nodes,'New goal').props.onChangeText('Shared objective');nodes=h.draw(props);
 button(nodes,'Create').props.onPress();await tick();nodes=h.draw(props);
 assert.equal(button(nodes,'Start'),undefined);assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='Goal saved. Select an entry to review.'));
});

test('clear opens a native confirmation and invalidates it when the entry changes',()=>{
 const h=harness();const calls=[];const goal=entry('clear');
 const props={registry:{version:1,revision:1,entries:[goal]},colors,identity:'clear-session',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,'Goal clear').props.onPress();nodes=h.draw(props);button(nodes,'Clear').props.onPress();nodes=h.draw(props);
 assert.equal(calls.length,0);assert.ok(nodes.some(node=>node.type==='Modal'));
 assert.equal(button(nodes,'Clear goal').props.disabled,false);
 goal.revision=3;nodes=h.draw(props);assert.equal(button(nodes,'Clear goal').props.disabled,true);assert.equal(calls.length,0);
});

test('desktop default-selection confirmation never retargets when that goal completes',()=>{
 const h=harness();const first=entry('first-default'),second=entry('second-default');const calls=[];
 const props={registry:{version:1,revision:1,entries:[first,second]},colors,identity:'default-selection-guard',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);nodes.find(node=>node.props.onLayout).props.onLayout({nativeEvent:{layout:{width:1100}}});nodes=h.draw(props);
 button(nodes,'Clear').props.onPress();first.status='complete';first.revision++;nodes=h.draw(props);
 assert.equal(button(nodes,'Clear goal').props.disabled,true);assert.equal(calls.length,0);
 assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='Goal first-default'),'confirmation remains pinned to the intended entry');
});

test('empty completed view does not accidentally display a creation form on desktop',()=>{
 const h=harness();const props={registry:{version:1,revision:0,entries:[]},colors,identity:'empty-history',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async()=>false};
 let nodes=h.draw(props);nodes.find(node=>node.props.onLayout).props.onLayout({nativeEvent:{layout:{width:1100}}});nodes=h.draw(props);
 button(nodes,'History').props.onPress();nodes=h.draw(props);
 assert.equal(button(nodes,'Create'),undefined);assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='No goal history yet'));
});

test('unavailable child capability disables execution without disabling metadata creation',()=>{
 const h=harness();const props={registry:{version:1,revision:1,entries:[entry('offline')]},colors,identity:'offline-session',locked:false,busy:false,executionAvailable:false,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async()=>false};
 let nodes=h.draw(props);button(nodes,'Goal offline').props.onPress();nodes=h.draw(props);
 assert.equal(button(nodes,'Start').props.disabled,true);
 assert.equal(button(nodes,'Edit').props.disabled,false,'unstarted metadata remains editable');
 assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='Start and Resume are unavailable in this session'));
 props.registry.entries[0].child={taskId:'owned',childId:'attempt',jobId:'group',attempt:1};
 nodes=h.draw(props);assert.equal(button(nodes,'Edit').props.disabled,false,'linked paused edits are metadata-only');assert.equal(button(nodes,'Add task').props.disabled,false);
 props.registry.entries[0].status='active';nodes=h.draw(props);
 assert.equal(button(nodes,'Pause').props.disabled,false,'revoking launch capability must not remove the safe stop control');
});

test('duplicate trimmed task descriptions are rejected locally before a mutation',async()=>{
 const h=harness();const calls=[];const goal=entry('duplicate');goal.tasks=[{id:'task-1',text:' Verify permissions ',status:'pending'}];
 const props={registry:{version:1,revision:1,entries:[goal]},colors,identity:'duplicate-task',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,'Goal duplicate').props.onPress();nodes=h.draw(props);button(nodes,'Add task').props.onPress();nodes=h.draw(props);
 textbox(nodes,'Subtask').props.onChangeText('  Verify permissions  ');nodes=h.draw(props);
 assert.equal(button(nodes,'Save task').props.disabled,true);assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='That task is already in this goal'));
 button(nodes,'Save task').props.onPress();await tick();assert.equal(calls.length,0);
 textbox(nodes,'Subtask').props.onChangeText('  Verify identities  ');nodes=h.draw(props);assert.equal(button(nodes,'Save task').props.disabled,false);
 button(nodes,'Save task').props.onPress();await tick();assert.equal(calls[0].action,'goals.add_task');assert.equal(calls[0].text,'Verify identities');
});

test('exhausted budgets gate Resume in every stopped state without removing Pause',async()=>{
 for(const status of ['paused','blocked','usage_limited','budget_limited']) {
  const h=harness();const calls=[];const goal=entry('limited',status);goal.child={taskId:'owned',childId:'attempt',jobId:'group',attempt:1};goal.tokenBudget=100;goal.tokensUsed=100;
  const props={registry:{version:1,revision:1,entries:[goal]},colors,identity:`budget-${status}`,locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
  let nodes=h.draw(props);button(nodes,'Goal limited').props.onPress();nodes=h.draw(props);
  assert.equal(button(nodes,'Resume').props.disabled,true,status);assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='Raise or remove the token budget before resuming'));
  button(nodes,'Resume').props.onPress();await tick();assert.equal(calls.length,0);
  goal.tokenBudget=null;goal.revision++;nodes=h.draw(props);assert.equal(button(nodes,'Resume').props.disabled,false,status);
  button(nodes,'Resume').props.onPress();await tick();assert.equal(calls[0].action,'goals.resume');
  goal.status='active';goal.tokenBudget=100;goal.tokensUsed=101;nodes=h.draw(props);assert.equal(button(nodes,'Pause').props.disabled,false);
 }
});

for (const width of [390, 1100]) test(`assignment lists are independent of status at ${width}px`,()=>{
 const h=harness();const paused=entry('linked-paused');paused.child={taskId:'real-child',childId:'child',jobId:'job',attempt:1};
 const active=entry('unlinked-active','active');const saved=entry('saved');
 const done=entry('done','complete');done.child=paused.child;
 const cleared=entry('cleared','cleared');
 const props={registry:{version:1,revision:1,entries:[paused,active,saved,done,cleared]},colors,identity:`assignment-${width}`,locked:false,busy:false,executionAvailable:true,model:null,limits:{},post:async()=>{throw Error('fixture must not mutate');}};
 let nodes=h.draw(props);nodes.find(n=>n.props.onLayout).props.onLayout({nativeEvent:{layout:{width}}});nodes=h.draw(props);
 const labels=nodes.filter(n=>n.type==='Pressable').map(n=>n.props.accessibilityLabel);
 for(const id of ['linked-paused','unlinked-active','saved'])assert.equal(labels.filter(x=>x===`Goal ${id}`).length,1);
 assert.ok(!labels.includes('Goal done'));assert.ok(!labels.includes('Goal cleared'));
 const delegated=nodes.find(n=>n.type==='View'&&Array.isArray(n.props.children)&&n.props.children[0]?.props?.children==='Delegated');
 assert.ok(delegated);assert.equal(delegated.props.children[1].length,1);assert.equal(delegated.props.children[1][0].props.title,'Goal linked-paused');
 assert.ok(nodes.some(n=>n.type==='Text'&&n.props.children==='Unassigned'));assert.ok(!nodes.some(n=>n.type==='Text'&&['Goals','Legacy parent goals'].includes(n.props.children)));
 button(nodes,'History').props.onPress();nodes=h.draw(props);
 for(const id of ['done','cleared'])assert.ok(button(nodes,`Goal ${id}`));
 assert.ok(!button(nodes,'Goal linked-paused'));assert.ok(nodes.some(n=>n.type==='Text'&&n.props.children==='Delegated'));
 button(nodes,'Current goals').props.onPress();props.registry.entries=[saved];nodes=h.draw(props);
 assert.ok(!nodes.some(n=>n.type==='Text'&&n.props.children==='Delegated'));
 props.registry.entries=[];nodes=h.draw(props);assert.ok(nodes.some(n=>n.type==='Text'&&n.props.children==='No goals yet'));
});

test('copied ticket UI renders exactly four real tabs and equal ordered task segments without time guesses',()=>{
 const h=harness(),g=entry('story','active');
 g.tasks=['completed','in_progress','blocked','pending'].map((status,i)=>({id:`t${i}`,text:`Task ${i}`,status}));
 g.story={version:1,timeline:[{id:'created',at:1700000000000,kind:'created',text:'Created from a durable record'},{id:'task-done',at:1700000001000,kind:'task',taskId:'t0',taskStatus:'completed',text:'Task completed'}],activity:[{id:'note',at:1700000060000,text:'Explicit progress report'}],questions:[]};
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:'story-counts',locked:false,busy:false,executionAvailable:true,model:null,limits:{},post:async()=>false};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);
 const tabs=nodes.filter(n=>n.props.accessibilityRole==='tab');assert.deepEqual(tabs.map(n=>n.props.accessibilityLabel),['Write-up','Timeline','Activity','Questions']);
 const bar=nodes.find(n=>n.props.accessibilityRole==='progressbar');assert.deepEqual(bar.props.accessibilityValue,{min:0,max:4,now:1,text:'1 of 4 tasks complete · 1 blocked'});
 assert.deepEqual(bar.props.children.map(n=>n.props.style),['#63b887','#779cde','#c98279','#30333f'].map(backgroundColor=>({flex:1,backgroundColor})));
 assert.ok(nodes.some(n=>n.type==='Icon'&&n.props.name==='Check'&&n.props.color===colors.statusSuccess),'completed checklist checks are green');
 assert.ok(nodes.some(n=>n.type==='Icon'&&n.props.name==='Ban'&&n.props.color===colors.statusDanger),'blocked checklist uses danger rather than warning');
 assert.ok(nodes.some(n=>n.props.children==='Task 0'&&n.props.style.color===colors.foreground),'completed titles remain readable');
 tabs[1].props.onPress();nodes=h.draw(props);assert.ok(nodes.some(n=>n.props.children==='Created from a durable record'));
 assert.ok(nodes.some(n=>n.type==='Icon'&&n.props.name==='CircleCheck'&&n.props.color===colors.statusSuccess),'recorded task completion is green without parsing prose');
 h.remount();nodes=h.draw(props);assert.equal(nodes.find(n=>n.props.accessibilityRole==='tab'&&n.props.accessibilityLabel==='Timeline').props.accessibilityState.selected,true);
 nodes.find(n=>n.props.accessibilityRole==='tab'&&n.props.accessibilityLabel==='Activity').props.onPress();nodes=h.draw(props);assert.ok(nodes.some(n=>n.props.children==='Explicit progress report'));
 g.story=undefined;nodes=h.draw(props);assert.ok(nodes.some(n=>n.props.children==='No progress updates yet'));
 nodes.find(n=>n.props.accessibilityRole==='tab'&&n.props.accessibilityLabel==='Questions').props.onPress();nodes=h.draw(props);assert.ok(nodes.some(n=>n.props.children==='No recorded questions'));
 g.tasks=[];nodes=h.draw(props);assert.equal(nodes.find(n=>n.props.accessibilityRole==='progressbar'),undefined);
});

test('goal-bound questionnaire answers preserve exact identity and stale draft protection without permission approval',async()=>{
 const h=harness(),calls=[],g=entry('questions','active');
 g.child={taskId:'task',childId:'child',jobId:'job',attempt:1};
 const question={id:'q1',revision:3,at:1700000000000,workerEpoch:'worker-epoch',status:'pending',request:{kind:'questionnaire',questions:[{id:'map',prompt:'Choose a map',options:[{value:'mapbox',label:'Mapbox'}],allowOther:true}]}};
 g.story={version:1,timeline:[],activity:[],questions:[question]};
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:'question-draft',locked:false,busy:false,executionAvailable:true,model:null,limits:{},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);nodes.find(n=>n.props.accessibilityRole==='tab'&&n.props.accessibilityLabel==='Questions').props.onPress();nodes=h.draw(props);
 assert.equal(button(nodes,'Submit answers').props.disabled,true);
 nodes.find(n=>n.props.accessibilityRole==='radio'&&n.props.accessibilityLabel==='Mapbox').props.onPress();nodes=h.draw(props);
 button(nodes,'Submit answers').props.onPress();await tick();assert.deepEqual(calls[0],{operation:'start',action:'goals.answer',expectedGoalId:'questions',expectedEntryRevision:2,questionId:'q1',questionRevision:3,workerEpoch:'worker-epoch',answer:{kind:'questionnaire',cancelled:false,answers:[{id:'map',value:'mapbox',wasCustom:false}]}});
 g.revision++;h.remount();nodes=h.draw(props);assert.equal(button(nodes,'Submit answers').props.disabled,true);button(nodes,'Submit answers').props.onPress();await tick();assert.equal(calls.length,1);
 button(nodes,'Review latest question').props.onPress();nodes=h.draw(props);assert.equal(button(nodes,'Submit answers').props.disabled,true);
 textbox(nodes,'Custom answer for Choose a map').props.onChangeText('Use city text');nodes=h.draw(props);button(nodes,'Submit answers').props.onPress();await tick();assert.equal(calls[1].expectedEntryRevision,3);assert.equal(calls[1].answer.answers[0].wasCustom,true);
 question.status='answered';question.answer=calls[1].answer;question.answeredAt=1700000060000;nodes=h.draw(props);assert.equal(button(nodes,'Submit answers'),undefined);assert.ok(nodes.some(n=>n.props.children==='Use city text'));
});

test('story schema and answer RPC reject permission requests and incomplete routing identity',()=>{
 const {goalStorySchema,workflowRequestSchema}=schemas;
 const base={operation:'start',action:'goals.answer',sessionId:'session',serviceEpoch:'11111111-1111-4111-8111-111111111111',requestId:'22222222-2222-4222-8222-222222222222',expectedGoalId:'goal',expectedEntryRevision:2,questionId:'q1',questionRevision:1,workerEpoch:'worker',answer:{kind:'questionnaire',cancelled:true,answers:[]}};
 assert.equal(workflowRequestSchema.safeParse(base).success,true);
 for(const field of ['questionId','questionRevision','workerEpoch','answer','expectedEntryRevision']){const invalid={...base};delete invalid[field];assert.equal(workflowRequestSchema.safeParse(invalid).success,false,field);}
 assert.equal(workflowRequestSchema.safeParse({...base,action:'goals.pause'}).success,false);
 assert.equal(workflowRequestSchema.safeParse({...base,answer:{kind:'permission',cancelled:false,value:'Allow'}}).success,false);
 assert.equal(goalStorySchema.safeParse({version:1,timeline:[],activity:[],questions:[]}).success,true);
 assert.equal(goalStorySchema.safeParse({version:1,timeline:[],activity:[],questions:[{id:'q',revision:1,at:1,workerEpoch:'epoch',status:'pending',request:{kind:'permission',title:'Approve',options:['Allow']}}]}).success,false);
});

test('assigned agent route requires complete inventory and exact dedicated child, job and attempt',()=>{
 const {goalAgentRoute}=harness();
 const root={agentId:'parent',workspaceId:'workspace',sessionId:'session',runtimeEpoch:'epoch'};
 const child={taskId:`subagent-task-${'a'.repeat(24)}`,childId:`subagent-child-${'b'.repeat(24)}`,jobId:`subagent-job-${'c'.repeat(24)}`,attempt:2};
 const item={...child,groupId:child.jobId,runtimeId:'runtime',stale:false,paseoAgentId:'native-child',paseoWorkspaceId:'native-workspace'};
 assert.ok(goalAgentRoute(child,root,[item],true));
 for(const altered of [{...item,attempt:1},{...item,groupId:`subagent-job-${'d'.repeat(24)}`},{...item,childId:`subagent-child-${'d'.repeat(24)}`},{...item,stale:true},{...item,reaped:true},{...item,runtimeId:null},{...item,source:{...root,sessionId:'other'}}])assert.equal(goalAgentRoute(child,root,[altered],true),null);
 assert.equal(goalAgentRoute(child,root,[item,item],true),null);assert.equal(goalAgentRoute(child,root,[item],false),null);
});

test('all three assignment groups share ticket UI; assigned goals and history stay read-only',()=>{
 const h=harness(),calls=[];
 const child={...entry('child'),child:{taskId:'task',childId:'child',jobId:'job',attempt:1}};
 const props={registry:{version:1,revision:1,entries:[entry('draft'),child]},assignedGoal:{...entry('parent'),tasks:[{text:'Recorded task',status:'completed'}]},completedAssigned:[{id:'old',text:'Old assigned goal',status:'completed',summary:'Recorded summary',tasks:[]}],colors,identity:'all-assignment-groups',locked:false,busy:false,executionAvailable:true,model:null,limits:{automaticTurns:null,noProgressTurns:null},post:async f=>{calls.push(f);return false;}};
 let nodes=h.draw(props);
 for(const label of ['Unassigned','Assigned','Delegated'])assert.ok(nodes.some(n=>n.props.children===label));
 button(nodes,'Goal parent').props.onPress();nodes=h.draw(props);
 for(const label of ['Start','Resume','Edit','Pause','Clear','Add task'])assert.equal(button(nodes,label),undefined);
 for(const label of ['Write-up','Timeline','Activity','Questions'])assert.ok(nodes.some(n=>n.props.accessibilityRole==='tab'&&n.props.accessibilityLabel===label));
 assert.ok(nodes.some(n=>n.props.accessibilityRole==='progressbar'&&n.props.accessibilityValue.now===1));
 button(nodes,'Back to goals').props.onPress();nodes=h.draw(props);button(nodes,'History').props.onPress();nodes=h.draw(props);
 button(nodes,'Old assigned goal').props.onPress();nodes=h.draw(props);
 assert.ok(nodes.some(n=>n.props.children==='Recorded summary'));assert.equal(button(nodes,'Edit'),undefined);assert.deepEqual(calls,[]);
});

for (const assigned of [false,true]) for (const status of ['active','paused']) test(`dedicated limits editor preserves scope for ${assigned?'assigned':'delegated'} ${status} goals`,async()=>{
 const h=harness(),calls=[],g=entry(`limits-${assigned}-${status}`,status);
 Object.assign(g,{activationId:'activation-1',tokenBudget:500,tokensUsed:100,automaticTurns:8,noProgressTurns:3,continuationLimits:{automaticTurns:10,noProgressTurns:5},policyRevision:7,tasks:[{id:'keep',text:'Keep checklist',status:'in_progress'}]});
 const props={registry:{version:1,revision:1,entries:assigned?[]:[g]},assignedGoal:assigned?g:null,colors,identity:`live-limits-${assigned}-${status}`,locked:false,busy:false,executionAvailable:true,limitsEditable:true,model:null,limits:{automaticTurns:null,noProgressTurns:null},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);if(button(nodes,g.text))button(nodes,g.text).props.onPress();else button(nodes,'Back to goals')?.props.onPress();nodes=h.draw(props);
 if(!button(nodes,'Edit limits')){button(nodes,g.text).props.onPress();nodes=h.draw(props);}
 assert.equal(button(nodes,'Edit limits').props.disabled,false);
 assert.equal(nodes.filter(n=>n.type==='Text'&&n.props.children===g.text).length,1,'single-line objective is not repeated in Write-up');
 assert.ok(nodes.some(n=>n.props.children==='Keep checklist'));
 button(nodes,'Edit limits').props.onPress();nodes=h.draw(props);
 assert.equal(textbox(nodes,'Goal objective'),undefined,'limits-only editor cannot submit scope changes');
 textbox(nodes,'Goal token budget').props.onChangeText('50');textbox(nodes,'Goal automatic responses').props.onChangeText('2');textbox(nodes,'Goal no-progress responses').props.onChangeText('');
 nodes=h.draw(props);button(nodes,'Save changes').props.onPress();await tick();
 assert.deepEqual(calls[0],{operation:'start',action:assigned?'goal.limits':'goals.limits',expectedGoalId:g.id,
  expectedPolicyRevision:7,...(assigned?{expectedActivationId:'activation-1'}:{}),tokenBudget:50,continuationLimits:{automaticTurns:2,noProgressTurns:null}});
 assert.equal(g.tokensUsed,100);assert.equal(g.automaticTurns,8);assert.equal(g.noProgressTurns,3);assert.equal(g.tasks.length,1);
 g.revision++;g.tokensUsed++;
 nodes=h.draw(props);assert.equal(button(nodes,'Save changes').props.disabled,false,'accounting must not stale limit editor');
 g.policyRevision++;
 nodes=h.draw(props);assert.equal(button(nodes,'Save changes').props.disabled,true);button(nodes,'Save changes').props.onPress();await tick();assert.equal(calls.length,1);
});

test('recorded waiting is distinct from working; no assignment explanation is rendered',()=>{
 const h=harness(),g=entry('waiting','active');g.waiting='Waiting for an external answer';
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:'recorded-waiting',locked:false,busy:false,executionAvailable:true,limitsEditable:true,model:null,limits:{},post:async()=>false};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);
 assert.ok(nodes.some(n=>n.type==='Text'&&n.props.children==='Waiting'));
 assert.ok(!nodes.some(n=>n.type==='Text'&&n.props.children==='Working'));
 assert.ok(!nodes.some(n=>typeof n.props.children==='string'&&/independent dedicated|assignment|Assign this goal/i.test(n.props.children)));
 g.waiting=null;nodes=h.draw(props);assert.ok(nodes.some(n=>n.type==='Text'&&n.props.children==='Working'));
 props.limitsEditable=false;nodes=h.draw(props);assert.equal(button(nodes,'Edit limits').props.disabled,true);
});

test('assigned wait diagnostics show recorded deadlines and evidence without inventing missing data',()=>{
 const h=harness(),g={...entry('observable','active'),waiting:'Waiting for an external completion',waitDeadline:1700000000000,lastTaskUpdateAt:1699999999000,lastWake:{at:1699999998000,reason:'user_input'},lastBlocker:{at:1699999997000,reason:'External dependency',evidence:'Recorded failure evidence',repeatedTurns:3}};
 const props={registry:{version:1,revision:1,entries:[]},assignedGoal:g,colors,identity:'wait-diagnostics',locked:false,busy:false,executionAvailable:true,limitsEditable:false,model:null,limits:{},post:async()=>false};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);
 for(const text of ['Safety wake:','Last wake:','Last checklist change:','Recorded failure evidence'])assert.ok(JSON.stringify(nodes).includes(text),text);
 delete g.waitDeadline;nodes=h.draw(props);assert.ok(JSON.stringify(nodes).includes('Wait deadline unavailable in this runtime'));
});
test('stopped questionnaires stay readable but cannot submit or cancel a dead waiter',async()=>{
 for(const status of ['paused','blocked','usage_limited','budget_limited','complete','cleared']){
  const h=harness(),g=entry(`stopped-${status}`,status),calls=[];
  g.child={taskId:'task',childId:'child',jobId:'job',attempt:1};
  g.story={version:1,timeline:[],activity:[],questions:[{id:'q',revision:1,at:1,workerEpoch:'old',status:'pending',request:{kind:'questionnaire',questions:[{id:'x',prompt:'Pick?',options:[{value:'yes',label:'Yes'}],allowOther:false}]}}]};
  const props={registry:{version:1,revision:1,entries:[g]},colors,identity:g.id,locked:false,busy:false,executionAvailable:true,limits:{},post:async f=>{calls.push(f);return false;}};
  let nodes=h.draw(props);if(['complete','cleared'].includes(status)){button(nodes,'History').props.onPress();nodes=h.draw(props);}button(nodes,g.text).props.onPress();nodes=h.draw(props);nodes.find(n=>n.props.accessibilityLabel==='Questions').props.onPress();nodes=h.draw(props);
  assert.ok(nodes.some(n=>n.props.children==='Pick?'));
  for(const label of ['Submit answers','Cancel questions']){const b=button(nodes,label);assert.ok(!b||b.props.disabled);b?.props.onPress();}
  assert.ok(!JSON.stringify(nodes).includes('Waiting for you'));await tick();assert.deepEqual(calls,[]);
 }
});

test('task capacity disables Add and preserves an open draft when the final slot fills',()=>{
 const h=harness(),g=entry('capacity');g.tasks=Array.from({length:49},(_,i)=>({id:`t${i}`,text:`Task ${i}`,status:'pending'}));
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:g.id,locked:false,busy:false,executionAvailable:true,limits:{},post:async()=>false};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);button(nodes,'Add task').props.onPress();nodes=h.draw(props);textbox(nodes,'Subtask').props.onChangeText('Keep this draft');nodes=h.draw(props);assert.equal(button(nodes,'Save task').props.disabled,false);
 g.tasks.push({id:'last',text:'Concurrent task',status:'pending'});g.revision++;nodes=h.draw(props);assert.equal(button(nodes,'Save task').props.disabled,true);assert.equal(textbox(nodes,'Subtask').props.value,'Keep this draft');
 button(nodes,'Cancel task').props.onPress();nodes=h.draw(props);assert.equal(button(nodes,'Add task').props.disabled,true);
});

test('history renders calendar day and model is only an authenticated child launch value',()=>{
 const h=harness(),g=entry('truthful');g.child={taskId:'task',childId:'child',jobId:'job',attempt:1,model:'provider/actual-role-model'};
 g.story={version:1,timeline:[{id:'old',at:new Date(2020,0,2,9).getTime(),kind:'created',text:'Old event'}],activity:[]};
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:g.id,locked:false,busy:false,executionAvailable:true,model:'false-default',limits:{},post:async()=>false};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);assert.ok(JSON.stringify(nodes).includes('provider/actual-role-model'));assert.ok(!JSON.stringify(nodes).includes('false-default'));
 nodes.find(n=>n.props.accessibilityLabel==='Timeline').props.onPress();nodes=h.draw(props);assert.ok(nodes.some(n=>n.type==='Text'&&typeof n.props.children==='string'&&n.props.children.includes('2020')));
});

test('history is bounded, pending questions remain discoverable and context never preselects a recommendation',()=>{
 const h=harness(),g=entry('bounded','active');g.child={taskId:'task',childId:'child',jobId:'job',attempt:1};
 g.story={version:1,timeline:[],activity:Array.from({length:21},(_,i)=>({id:`a${i}`,at:100+i,text:`Update ${i}`})),coverage:{activityTruncated:true},questions:[{id:'q',revision:1,at:1,workerEpoch:'epoch',status:'pending',request:{kind:'questionnaire',questions:[{id:'x',prompt:'Pick?',background:'Authored background',recommendation:'yes',options:[{value:'yes',label:'Yes'}],allowOther:false}]}}]};
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:g.id,locked:false,busy:false,executionAvailable:true,limits:{},post:async()=>false};
 let nodes=h.draw(props);assert.ok(JSON.stringify(nodes).includes('Questions pending'));button(nodes,g.text).props.onPress();nodes=h.draw(props);button(nodes,'View pending questions').props.onPress();nodes=h.draw(props);
 assert.ok(nodes.some(n=>n.props.children==='Authored background'));assert.ok(JSON.stringify(nodes).includes('Recommended'));assert.equal(button(nodes,'Submit answers').props.disabled,true);assert.equal(nodes.find(n=>n.props.accessibilityRole==='radio').props['aria-checked'],false);
 nodes.find(n=>n.props.accessibilityLabel==='Activity').props.onPress();nodes=h.draw(props);assert.equal(nodes.filter(n=>typeof n.props.children==='string'&&/^Update \d+$/.test(n.props.children)).length,10);assert.ok(nodes.some(n=>n.props.children==='Update 20'));assert.ok(!nodes.some(n=>n.props.children==='Update 0'));button(nodes,'Show older updates').props.onPress();nodes=h.draw(props);assert.equal(nodes.filter(n=>typeof n.props.children==='string'&&/^Update \d+$/.test(n.props.children)).length,20);assert.ok(JSON.stringify(nodes).includes('Earlier records omitted'));
 g.observation={state:'unavailable',at:1};nodes=h.draw(props);assert.ok(JSON.stringify(nodes).includes('Recorded working'));nodes.find(n=>n.props.accessibilityLabel==='Questions').props.onPress();nodes=h.draw(props);assert.equal(button(nodes,'Cancel questions').props.disabled,true);
});

test('review registration preserves the opened revision, previews registered IDs and exports only on request',async()=>{
 const h=harness(),goal=entry('review');goal.child={taskId:'task',childId:'child',jobId:'job',attempt:1};goal.review=[{id:'ref',goalId:goal.id,taskId:'task',childId:'child',attempt:1,title:'Spec',role:'source',kind:'text',at:1,target:'spec.md'}];
 const calls=[];let resolvePreview;const props={goal,colors,disabled:false,available:true,register:async fields=>{calls.push(fields);return false;},preview:async(id,revision)=>{calls.push({id,revision});return new Promise(resolve=>resolvePreview=resolve);}};
 let nodes=h.drawReview(props);assert.ok(!JSON.stringify(nodes).includes('spec.md'));button(nodes,'Review references (1)').props.onPress();nodes=h.drawReview(props);button(nodes,'Review Spec').props.onPress();await tick();assert.deepEqual(calls[0],{id:'ref',revision:2});
 goal.revision++;nodes=h.drawReview(props);resolvePreview({kind:'text',text:'Late private content'});await tick();nodes=h.drawReview(props);assert.ok(!JSON.stringify(nodes).includes('Late private content'));
 button(nodes,'Register reference').props.onPress();nodes=h.drawReview(props);textbox(nodes,'Reference title').props.onChangeText('Result');nodes=h.drawReview(props);textbox(nodes,'Reference path or HTTPS URL').props.onChangeText('result.txt');nodes=h.drawReview(props);goal.revision++;nodes=h.drawReview(props);assert.equal(button(nodes,'Save reference').props.disabled,true);
 button(nodes,'Export snapshot').props.onPress();nodes=h.drawReview(props);assert.ok(JSON.stringify(nodes).includes('exportedAt'));assert.equal(calls.length,1,'export never reads files or mutates sessions');
});

test('delegated engine blocker evidence is disclosed without changing goal or task status',()=>{
 const h=harness(),g=entry('diagnostics','paused');g.diagnostics={lastBlocker:{at:1,reason:'External dependency',evidence:'Exact engine failure',repeatedTurns:2},lastWake:{at:2,reason:'explicit_resume'}};
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:g.id,locked:false,busy:false,executionAvailable:true,limits:{},post:async()=>false};let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);assert.ok(!nodes.some(n=>n.type==='Text'&&n.props.children==='Exact engine failure'));button(nodes,'Recorded details').props.onPress();nodes=h.draw(props);assert.ok(nodes.some(n=>n.type==='Text'&&n.props.children==='Exact engine failure'));assert.equal(g.status,'paused');assert.deepEqual(g.tasks,[]);
});

test('review contracts reject arbitrary preview paths, unsafe links and mismatched file metadata',()=>{
 const ref={id:'11111111-1111-4111-8111-111111111111',goalId:'22222222-2222-4222-8222-222222222222',taskId:'task',childId:'child',attempt:1,title:'Spec',role:'source',kind:'link',at:1,target:'https://example.test/spec'};
 assert.equal(schemas.goalReviewReferenceSchema.safeParse(ref).success,true);
 for(const changed of [{...ref,target:'http://example.test'},{...ref,target:'https://user:pass@example.test'},{...ref,kind:'image'},{...ref,kind:'text',bytes:40000,mime:'text/plain',sha256:'a'.repeat(64)},{...ref,path:'/etc/passwd'}])assert.equal(schemas.goalReviewReferenceSchema.safeParse(changed).success,false);
 const request={operation:'start',action:'goals.reference',sessionId:'s',serviceEpoch:ref.id,requestId:ref.id,expectedGoalId:ref.goalId,expectedEntryRevision:1,reviewTitle:'Spec',reviewTarget:'spec.md',reviewRole:'source'};
 assert.equal(schemas.workflowRequestSchema.safeParse(request).success,true);
 assert.equal(schemas.workflowRequestSchema.safeParse({...request,action:'goals.start'}).success,false);
});

test('optional public host localization preserves drafts/authored content and old clients stay English',async()=>{
 const h=harness({locale:'en'}),calls=[],props={registry:{version:1,revision:0,entries:[]},colors,identity:'localized-draft',locked:false,busy:false,executionAvailable:true,limits:{},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);textbox(nodes,'New goal').props.onChangeText('Authored outcome is not translated');nodes=h.draw(props);h.setLocale('zh-CN');nodes=h.draw(props);assert.equal(textbox(nodes,'新建目标').props.value,'Authored outcome is not translated');assert.ok(button(nodes,'创建'));button(nodes,'创建').props.onPress();await tick();assert.equal(calls[0].objective,'Authored outcome is not translated');
 const old=harness(),oldNodes=old.draw({...props,identity:'old-native'});assert.ok(button(oldNodes,'Create'));assert.equal(button(oldNodes,'创建'),undefined);
 const authored=entry('11111111-1111-4111-8111-111111111111');authored.text='New goal';props.registry.entries=[authored];props.identity='localized-authored';const n=harness({locale:'zh-CN'});let ns=n.draw(props);button(ns,'New goal').props.onPress();ns=n.draw(props);assert.ok(ns.some(node=>node.type==='Text'&&node.props.children==='New goal'),'authored objective is never passed through translation');
});

test('planning controls submit exact identities, retain evidence and reject stale open drafts',async()=>{
 const h=harness(),calls=[],g=entry('planning');g.tasks=[{id:'a',text:'First task',status:'pending'},{id:'b',text:'Second task',status:'pending'}];g.planning={dependencies:[],blockers:[{id:'recorded',at:1,reason:'External service',evidence:'Actual evidence'}]};
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:g.id,planningAvailable:true,locked:false,busy:false,executionAvailable:true,limits:{},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);button(nodes,'Planning · 1 recorded blocker').props.onPress();nodes=h.draw(props);button(nodes,'Edit dependencies').props.onPress();nodes=h.draw(props);nodes.find(n=>n.props.accessibilityRole==='checkbox').props.onPress();nodes=h.draw(props);button(nodes,'Save planning').props.onPress();await tick();assert.equal(calls[0].action,'goals.dependencies');assert.equal(calls[0].expectedGoalId,g.id);assert.equal(calls[0].expectedEntryRevision,2);assert.deepEqual(calls[0].waitsFor,['b']);
 g.revision++;nodes=h.draw(props);assert.equal(button(nodes,'Save planning').props.disabled,true);assert.ok(nodes.some(n=>n.type==='Text'&&n.props.children==='Actual evidence'));button(nodes,'Clear blocker: External service').props.onPress();await tick();assert.equal(calls[1].action,'goals.blocker.clear');assert.equal(calls[1].blockerId,'recorded');assert.equal(calls[1].expectedEntryRevision,3);
});

test('planning wire contracts reject cross-goal cycles and mixed-action payloads',()=>{
 const base={...entry('11111111-1111-4111-8111-111111111111'),tasks:[{id:'a',text:'A',status:'pending'},{id:'b',text:'B',status:'pending'}],planning:{dependencies:[{taskId:'a',waitsFor:['b']}],blockers:[]}};
 assert.equal(schemas.delegatedGoalEntrySchema.safeParse(base).success,true);
 for(const dependencies of [[{taskId:'a',waitsFor:['foreign']}],[{taskId:'a',waitsFor:['a']}],[{taskId:'a',waitsFor:['b']},{taskId:'b',waitsFor:['a']}]])assert.equal(schemas.delegatedGoalEntrySchema.safeParse({...base,planning:{dependencies,blockers:[]}}).success,false);
 const request={operation:'start',action:'goals.dependencies',sessionId:'s',serviceEpoch:base.id,requestId:base.id,expectedGoalId:base.id,expectedEntryRevision:2,taskId:'a',waitsFor:['b']};assert.equal(schemas.workflowRequestSchema.safeParse(request).success,true);assert.equal(schemas.workflowRequestSchema.safeParse({...request,action:'goals.start'}).success,false);assert.equal(schemas.workflowRequestSchema.safeParse({...request,blockerReason:'wrong action'}).success,false);
});

test('question attachment controls use exact registered scope and discard late preview content',async()=>{
 const h=harness(),g=entry('attachments');g.child={taskId:'task',childId:'child',jobId:'job',attempt:1};g.review=[{id:'ref',goalId:g.id,taskId:'task',childId:'child',attempt:1,workerEpoch:'epoch',questionId:'q',title:'Evidence',role:'source',kind:'text',at:1,target:'spec.md'}];
 const question={id:'q',revision:2,workerEpoch:'epoch',attachmentIds:['ref']},calls=[];let resolve;
 const props={goal:g,question,colors,disabled:false,available:true,preview:async(id,target)=>{calls.push({id,target});return new Promise(done=>resolve=done);}};
 let nodes=h.drawAttachments(props);button(nodes,'Review Evidence').props.onPress();await tick();assert.deepEqual(calls[0],{id:'ref',target:{questionId:'q',questionRevision:2,workerEpoch:'epoch'}});
 question.revision++;nodes=h.drawAttachments(props);resolve({kind:'text',text:'Late attachment bytes'});await tick();nodes=h.drawAttachments(props);assert.ok(!nodes.some(n=>n.type==='Text'&&n.props.children==='Late attachment bytes'));
 g.review[0].questionId='other';nodes=h.drawAttachments(props);assert.equal(button(nodes,'Review Evidence').props.disabled,true);button(nodes,'Review Evidence').props.onPress();await tick();assert.equal(calls.length,1);
});

test('limit RPC schemas require exact policy routing and explicit nullable limits',()=>{
 const base={operation:'start',action:'goal.limits',sessionId:'session',serviceEpoch:'11111111-1111-4111-8111-111111111111',requestId:'22222222-2222-4222-8222-222222222222',expectedGoalId:'assigned',expectedActivationId:'activation-1',expectedPolicyRevision:1,tokenBudget:null,continuationLimits:{automaticTurns:null,noProgressTurns:null}};
 assert.equal(schemas.workflowRequestSchema.safeParse(base).success,true);
 for(const field of ['expectedActivationId','expectedPolicyRevision','tokenBudget','continuationLimits']){const invalid={...base};delete invalid[field];assert.equal(schemas.workflowRequestSchema.safeParse(invalid).success,false,field);}
 assert.equal(schemas.workflowRequestSchema.safeParse({...base,objective:'forbidden'}).success,false);
 assert.equal(schemas.workflowRequestSchema.safeParse({...base,action:'goals.limits'}).success,false);
 const {expectedActivationId,...delegated}=base;
 assert.equal(schemas.workflowRequestSchema.safeParse({...delegated,action:'goals.limits'}).success,true);
 assert.equal(schemas.workflowRequestSchema.safeParse({...delegated,action:'goals.limits',expectedEntryRevision:2}).success,false);
});
