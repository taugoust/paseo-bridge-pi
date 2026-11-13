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
await writeFile(resolve(fixture,'index.client.tsx'),'export { DelegatedGoals, savedPresentation } from "./client/delegated-goals"; export { assignedTickets } from "./client/assigned-goals"; export { goalAgentRoute } from "./shared/goal-agent"; export { GoalReview } from "./client/goal-review"; export { GoalQuestionAttachments } from "./client/goal-question-attachments";');
await writeFile(resolve(fixture,'index.server.ts'),'import { goalStorySchema, workflowRequestSchema, goalReviewReferenceSchema, delegatedGoalEntrySchema } from "./shared/workflows"; export default function schemas() { return { goalStorySchema, workflowRequestSchema, goalReviewReferenceSchema, delegatedGoalEntrySchema }; }');
const {clientBundle,serverBundle}=await compilePlugin({client:resolve(fixture,'index.client.tsx'),server:resolve(fixture,'index.server.ts')});
const schemas=(0,eval)(serverBundle)(name=>name==='@getpaseo/plugin'?{defineRpc:value=>value}:require(name)).default();
const copied=[],openedUrls=[];
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
   useLayoutEffect(){},
  };
  if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
  if(name==='react-native')return {View:'View',Text:'Text',Pressable:'Pressable',Image:'Image',Platform:{OS:'web'},Animated:{Value:class{interpolate(){return 0;}},View:'AnimatedView'},Easing:{linear:value=>value},AccessibilityInfo:{isReduceMotionEnabled:async()=>true,addEventListener:()=>({remove(){}})}};
  if(name==='@getpaseo/plugin/client')return {openExternalUrl:async url=>{openedUrls.push(url);},...translationApi};
  if(name==='@getpaseo/plugin/client/react-native')return {TextInput:'TextInput',ScrollView:'ScrollView',Icon:'Icon',copyText:async text=>{copied.push(text);}};
  if(name==='@getpaseo/plugin/client/ui')return {Icon:'Icon',SettingsSection:'SettingsSection',SettingsCard:'SettingsCard',SettingsAction:'SettingsAction',Modal:Object.assign(props=>jsx('Modal',props),{Content:'ModalContent'})};
  return require(name);
 };
 const {DelegatedGoals,savedPresentation,assignedTickets,goalAgentRoute,GoalReview,GoalQuestionAttachments}=(0,eval)(clientBundle)(load);
 function walk(node,path='root') {
  if(Array.isArray(node))return node.flatMap((item,index)=>walk(item,`${path}/${index}`));
  if(!node||typeof node!=='object')return [];
  if(typeof node.type==='function'){
   const key=`${path}:${node.type.name}:${node.props.key??''}`;const slots=states.get(key)??[];states.set(key,slots);context={slots,cursor:0};return walk(node.type(node.props),key);
  }
  return [node,...walk(node.props.children,`${path}/children`)];
 }
 return {draw:props=>walk({type:DelegatedGoals,props}),drawReview:props=>walk({type:GoalReview,props}),drawAttachments:props=>walk({type:GoalQuestionAttachments,props}),remount:()=>states.clear(),setLocale:next=>{locale=next;},goalAgentRoute,savedPresentation,assignedTickets};
}
const entry=(id,status='paused')=>({id,revision:2,text:`Goal ${id}`,status,tasks:[],child:null,tokenBudget:null,tokensUsed:0,automaticTurns:0,noProgressTurns:0,summary:null,waiting:null});
const button=(nodes,label)=>nodes.find(node=>node.type==='Pressable'&&node.props.accessibilityLabel===label);
const textbox=(nodes,label)=>nodes.find(node=>node.type==='TextInput'&&node.props.accessibilityLabel===label);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
// Unlabelled pressable rows (Add task, the collapsible goal sections) are named by their visible text.
const row=(nodes,label)=>nodes.find(node=>node.type==='Pressable'&&!node.props.accessibilityLabel&&JSON.stringify(node.props.children??null).includes(JSON.stringify(label)));
const section=(nodes,title)=>row(nodes,title);
const openSection=(h,props,title)=>{let nodes=h.draw(props);const header=section(nodes,title);assert.ok(header,title);if(!header.props.accessibilityState.expanded){header.props.onPress();nodes=h.draw(props);}return nodes;};
// The goal page keeps Edit, Clear goal and review behind its "···" button.
const more=(h,props)=>{let nodes=h.draw(props);if(!button(nodes,'Clear goal')){button(nodes,'···').props.onPress();nodes=h.draw(props);}return nodes;};
const completedHeading=nodes=>nodes.find(node=>node.type==='Pressable'&&/^Completed, \d+$/.test(node.props.accessibilityLabel??''));
// Ids in a list group (Running, Waiting, Not started), read from the group's GoalList element.
const group=(nodes,title)=>{const view=nodes.find(node=>node.type==='View'&&Array.isArray(node.props.children)&&node.props.children[0]?.props?.children?.[0]?.props?.children===title);return view?.props.children[1].props.entries.map(goal=>goal.id);};
const joined=node=>[node.props.children].flat().filter(value=>typeof value==='string').join('');
const modal=nodes=>nodes.slice(nodes.findIndex(node=>node.type==='Modal'));

test('compiled multi-goal creation is independent of parent idle and uses explicit paused registry action',async()=>{
 const h=harness();const calls=[];const props={registry:{version:1,revision:4,entries:[]},colors,identity:'creation-session',locked:false,busy:false,executionAvailable:false,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='No goals yet'));assert.equal(button(nodes,'Create'),undefined,'the empty state does not open a form by itself');
 assert.equal(button(nodes,'New goal').props.disabled,false,'creating a paused goal does not need execution');
 button(nodes,'New goal').props.onPress();nodes=h.draw(props);assert.equal(button(nodes,'Create').props.disabled,true);
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
 let nodes=h.draw(props);button(nodes,'New goal').props.onPress();nodes=h.draw(props);
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
 let nodes=h.draw(props);button(nodes,'Goal first').props.onPress();nodes=more(h,props);
 assert.equal(button(nodes,'Clear goal').props.disabled,true);
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
 let nodes=h.draw(props);button(nodes,'Goal edit').props.onPress();nodes=more(h,props);button(nodes,'Edit').props.onPress();nodes=h.draw(props);
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

test('tasks typed into the new-goal form are added in order to the created entry at its exact revisions',async()=>{
 const h=harness();const calls=[];const existing=entry('existing');let failAt=null;
 const props={registry:{version:1,revision:1,entries:[existing]},colors,identity:'create-with-tasks',locked:false,busy:false,executionAvailable:true,model:null,limits:{automaticTurns:null,noProgressTurns:null},post:async fields=>{
  calls.push(fields);
  if(fields.action==='goals.create'){const created={...entry('created'),revision:5,text:fields.objective};props.registry={...props.registry,entries:[existing,created]};return {snapshot:{delegatedGoals:props.registry}};}
  if(fields.action==='goals.add_task'){
   if(fields.text===failAt)return false;
   props.registry={...props.registry,entries:props.registry.entries.map(goal=>goal.id===fields.expectedGoalId?{...goal,revision:goal.revision+1,tasks:[...goal.tasks,{id:`t${goal.tasks.length}`,text:fields.text,status:'pending'}]}:goal)};
   return {snapshot:{delegatedGoals:props.registry}};
  }
  return false;
 }};
 let nodes=h.draw(props);button(nodes,'New goal').props.onPress();nodes=h.draw(props);
 textbox(nodes,'New goal').props.onChangeText('Goal with a checklist');
 for(const text of ['Write the plan','Ship it']){textbox(nodes,'New task').props.onChangeText(text);nodes=h.draw(props);button(nodes,'Add').props.onPress();nodes=h.draw(props);}
 textbox(nodes,'New task').props.onChangeText('Write the plan');nodes=h.draw(props);assert.equal(button(nodes,'Add').props.disabled,true,'a duplicate task is not added twice');
 textbox(nodes,'New task').props.onChangeText('');nodes=h.draw(props);
 assert.deepEqual(nodes.filter(node=>node.type==='Text'&&['Write the plan','Ship it'].includes(node.props.children)).map(node=>node.props.children),['Write the plan','Ship it']);
 assert.equal(calls.length,0,'drafting tasks never mutates');
 button(nodes,'Create').props.onPress();await tick();
 assert.deepEqual(calls.map(call=>call.action),['goals.create','goals.add_task','goals.add_task']);
 assert.equal(calls[0].tasks,undefined,'tasks are not smuggled into the create payload');
 assert.deepEqual(calls.slice(1).map(({expectedGoalId,expectedEntryRevision,text})=>({expectedGoalId,expectedEntryRevision,text})),[
  {expectedGoalId:'created',expectedEntryRevision:5,text:'Write the plan'},{expectedGoalId:'created',expectedEntryRevision:6,text:'Ship it'},
 ],'each task uses the revision returned by the previous step');
 nodes=h.draw(props);assert.ok(button(nodes,'Start'),'the created goal is selected');

 // A failed add stops the sequence instead of guessing a later revision.
 calls.length=0;failAt='Second';button(nodes,'Back to goals').props.onPress();h.remount();
 props.registry={...props.registry,entries:props.registry.entries.filter(goal=>goal.id!=='created')};nodes=h.draw(props);button(nodes,'New goal').props.onPress();nodes=h.draw(props);
 textbox(nodes,'New goal').props.onChangeText('Another goal');
 for(const text of ['Second','Third']){textbox(nodes,'New task').props.onChangeText(text);nodes=h.draw(props);button(nodes,'Add').props.onPress();nodes=h.draw(props);}
 button(nodes,'Create').props.onPress();await tick();
 assert.deepEqual(calls.map(call=>[call.action,call.text]),[['goals.create',undefined],['goals.add_task','Second']]);
});

test('ambiguous creations never add drafted tasks to a guessed goal',async()=>{
 const h=harness(),calls=[];const props={registry:{version:1,revision:1,entries:[]},colors,identity:'ambiguous-tasks',locked:false,busy:false,executionAvailable:true,model:null,limits:{},post:async fields=>{
  calls.push(fields);const own=entry('own'),other=entry('other');own.text=other.text=fields.objective;
  props.registry={version:1,revision:3,entries:[own,other]};return {snapshot:{delegatedGoals:props.registry}};
 }};
 let nodes=h.draw(props);button(nodes,'New goal').props.onPress();nodes=h.draw(props);textbox(nodes,'New goal').props.onChangeText('Shared');
 textbox(nodes,'New task').props.onChangeText('Only for my goal');nodes=h.draw(props);button(nodes,'Add').props.onPress();nodes=h.draw(props);
 button(nodes,'Create').props.onPress();await tick();
 assert.deepEqual(calls.map(call=>call.action),['goals.create']);
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
 let nodes=h.draw(props);button(nodes,'Goal clear').props.onPress();nodes=h.draw(props);
 assert.ok(!nodes.some(node=>node.type==='Pressable'&&['Clear','Clear goal'].includes(node.props.accessibilityLabel)),'clearing sits behind the ··· menu');
 nodes=more(h,props);button(nodes,'Clear goal').props.onPress();nodes=h.draw(props);
 assert.equal(calls.length,0);assert.ok(nodes.some(node=>node.type==='Modal'));
 assert.equal(button(modal(nodes),'Clear goal').props.disabled,false);
 goal.revision=3;nodes=h.draw(props);assert.equal(button(modal(nodes),'Clear goal').props.disabled,true);assert.equal(calls.length,0);
});

test('confirmed clear submits the revision the confirmation was opened at',async()=>{
 const h=harness();const calls=[];const goal=entry('confirmed');
 const props={registry:{version:1,revision:1,entries:[goal]},colors,identity:'confirmed-clear',locked:false,busy:false,executionAvailable:true,model:null,limits:{},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,'Goal confirmed').props.onPress();nodes=more(h,props);button(nodes,'Clear goal').props.onPress();nodes=h.draw(props);
 button(modal(nodes),'Clear goal').props.onPress();await tick();
 assert.deepEqual(calls,[{operation:'start',action:'goals.clear',expectedGoalId:'confirmed',expectedEntryRevision:2}]);
});

test('desktop list selects nothing by default and a clear confirmation never retargets when that goal completes',()=>{
 const h=harness();const first=entry('first-default'),second=entry('second-default');const calls=[];
 const props={registry:{version:1,revision:1,entries:[first,second]},colors,identity:'default-selection-guard',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);nodes.find(node=>node.props.onLayout).props.onLayout({nativeEvent:{layout:{width:1100}}});nodes=h.draw(props);
 for(const label of ['Back to goals','Start','···','Clear goal'])assert.equal(button(nodes,label),undefined,`${label}: a wide list does not open a goal on its own`);
 button(nodes,'Goal first-default').props.onPress();nodes=more(h,props);
 button(nodes,'Clear goal').props.onPress();first.status='complete';first.revision++;nodes=h.draw(props);
 assert.equal(button(modal(nodes),'Clear goal').props.disabled,true);assert.equal(calls.length,0);
 assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='Goal first-default'),'confirmation remains pinned to the intended entry');
});

test('completed goals alone show the empty state, and opening them does not display a creation form on desktop',()=>{
 const h=harness();const props={registry:{version:1,revision:0,entries:[entry('finished','complete')]},colors,identity:'empty-history',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async()=>false};
 let nodes=h.draw(props);nodes.find(node=>node.props.onLayout).props.onLayout({nativeEvent:{layout:{width:1100}}});nodes=h.draw(props);
 assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='No goals yet'));assert.equal(button(nodes,'Goal finished'),undefined,'finished goals start collapsed');
 assert.equal(completedHeading(nodes).props.accessibilityLabel,'Completed, 1');assert.equal(completedHeading(nodes).props.accessibilityState.expanded,false);
 completedHeading(nodes).props.onPress();nodes=h.draw(props);
 assert.equal(button(nodes,'Create'),undefined);assert.equal(textbox(nodes,'New goal'),undefined);assert.ok(button(nodes,'Goal finished'));
 assert.equal(completedHeading(nodes).props.accessibilityState.expanded,true);
});

test('unavailable child capability disables execution without disabling metadata creation',()=>{
 const h=harness();const props={registry:{version:1,revision:1,entries:[entry('offline')]},colors,identity:'offline-session',locked:false,busy:false,executionAvailable:false,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async()=>false};
 let nodes=h.draw(props);button(nodes,'Goal offline').props.onPress();nodes=h.draw(props);
 assert.equal(button(nodes,'Start').props.disabled,true);
 nodes=more(h,props);assert.equal(button(nodes,'Edit').props.disabled,false,'unstarted metadata remains editable');
 assert.ok(nodes.some(node=>node.type==='Text'&&node.props.children==='Start and Resume are unavailable in this session'));
 props.registry.entries[0].child={taskId:'owned',childId:'attempt',jobId:'group',attempt:1};
 nodes=more(h,props);assert.equal(button(nodes,'Resume').props.disabled,true);assert.equal(button(nodes,'Edit').props.disabled,false,'linked paused edits are metadata-only');assert.equal(row(nodes,'Add task').props.disabled,false);
 props.registry.entries[0].status='active';nodes=h.draw(props);
 assert.equal(button(nodes,'Pause').props.disabled,false,'revoking launch capability must not remove the safe stop control');
});

test('duplicate trimmed task descriptions are rejected locally before a mutation',async()=>{
 const h=harness();const calls=[];const goal=entry('duplicate');goal.tasks=[{id:'task-1',text:' Verify permissions ',status:'pending'}];
 const props={registry:{version:1,revision:1,entries:[goal]},colors,identity:'duplicate-task',locked:false,busy:false,executionAvailable:true,model:'gpt-6.1-sol',limits:{automaticTurns:3,noProgressTurns:2},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,'Goal duplicate').props.onPress();nodes=h.draw(props);row(nodes,'Add task').props.onPress();nodes=h.draw(props);
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

for (const width of [390, 1100]) test(`goal list groups by what goals are doing, not by assignment, at ${width}px`,()=>{
 const h=harness();const paused=entry('linked-paused');paused.child={taskId:'real-child',childId:'child',jobId:'job',attempt:1};
 const active=entry('unlinked-active','active');const saved=entry('saved');
 const done=entry('done','complete');done.child=paused.child;
 const cleared=entry('cleared','cleared');
 const props={registry:{version:1,revision:1,entries:[paused,active,saved,done,cleared]},colors,identity:`assignment-${width}`,locked:false,busy:false,executionAvailable:true,model:null,limits:{},post:async()=>{throw Error('fixture must not mutate');}};
 let nodes=h.draw(props);nodes.find(n=>n.props.onLayout).props.onLayout({nativeEvent:{layout:{width}}});nodes=h.draw(props);
 const labels=nodes.filter(n=>n.type==='Pressable').map(n=>n.props.accessibilityLabel);
 for(const id of ['linked-paused','unlinked-active','saved'])assert.equal(labels.filter(x=>x===`Goal ${id}`).length,1);
 assert.ok(!labels.includes('Goal done'));assert.ok(!labels.includes('Goal cleared'));
 assert.deepEqual(group(nodes,'Running'),['unlinked-active']);
 assert.deepEqual(group(nodes,'Not started'),['linked-paused','saved'],'a linked paused goal and a saved one share a group');
 assert.equal(group(nodes,'Waiting'),undefined,'empty groups are not rendered');
 for(const old of ['Unassigned','Assigned','Delegated','Goals','Legacy parent goals'])assert.ok(!nodes.some(n=>n.type==='Text'&&n.props.children===old),old);
 const first=nodes.find(n=>n.type==='View'&&Array.isArray(n.props.children)&&n.props.children[0]?.props?.children?.[0]?.props?.children==='Running');
 assert.equal(first.props.children[0].props.children[1].props.label,'New goal','New goal sits next to the first group heading');
 assert.equal(labels.filter(x=>x==='New goal').length,1);
 assert.equal(completedHeading(nodes).props.accessibilityLabel,'Completed, 2');
 completedHeading(nodes).props.onPress();nodes=h.draw(props);
 for(const id of ['done','cleared'])assert.ok(button(nodes,`Goal ${id}`));
 assert.ok(button(nodes,'Goal linked-paused'),'current goals stay listed above the opened Completed list');
 completedHeading(nodes).props.onPress();props.registry.entries=[saved];nodes=h.draw(props);
 assert.equal(completedHeading(nodes),undefined);assert.deepEqual(group(nodes,'Not started'),['saved']);
 props.registry.entries=[];nodes=h.draw(props);assert.ok(nodes.some(n=>n.type==='Text'&&n.props.children==='No goals yet'));
});

test('goal page has no tab strip, keeps equal ordered task segments and merges timeline and activity without time guesses',()=>{
 const h=harness(),g=entry('story','active');
 g.tasks=['completed','in_progress','blocked','pending'].map((status,i)=>({id:`t${i}`,text:`Task ${i}`,status}));
 g.story={version:1,timeline:[{id:'created',at:1700000000000,kind:'created',text:'Created from a durable record'},{id:'task-done',at:1700000001000,kind:'task',taskId:'t0',taskStatus:'completed',text:'Task completed'}],activity:[{id:'note',at:1700000060000,text:'Explicit progress report'}],questions:[]};
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:'story-counts',locked:false,busy:false,executionAvailable:true,model:null,limits:{},post:async()=>false};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);
 assert.equal(nodes.filter(n=>['tab','tablist'].includes(n.props.accessibilityRole)).length,0,'the goal page is one document, not a tab strip');
 assert.equal(nodes.find(n=>n.props.accessibilityRole==='header').props.children,g.text);
 const bar=nodes.find(n=>n.props.accessibilityRole==='progressbar');assert.deepEqual(bar.props.accessibilityValue,{min:0,max:4,now:1,text:'1 of 4 tasks complete · 1 blocked'});
 assert.deepEqual(bar.props.children.map(n=>n.props.style),['#63b887','#779cde','#c98279','#30333f'].map(backgroundColor=>({flex:1,backgroundColor})));
 assert.deepEqual(nodes.filter(n=>n.props.accessible&&/^Task \d: /.test(n.props.accessibilityLabel)).map(n=>n.props.accessibilityLabel),['Task 0: completed','Task 1: in progress','Task 2: blocked','Task 3: pending'],'checklist rows keep task order and name their status');
 assert.ok(nodes.some(n=>n.type==='Icon'&&n.props.name==='CircleCheck'&&n.props.color===colors.statusSuccess),'completed checklist checks are green');
 assert.ok(nodes.some(n=>n.type==='Icon'&&n.props.name==='Ban'&&n.props.color===colors.statusDanger),'blocked checklist uses danger rather than warning');
 const done=nodes.find(n=>n.type==='Text'&&n.props.children==='Task 0');assert.equal(done.props.selectable,true);assert.equal(done.props.style.textDecorationLine,'line-through','completed titles stay selectable and are struck through, not hidden');
 assert.ok(!nodes.some(n=>n.props.children==='Created from a durable record'),'Activity starts collapsed');
 assert.ok(section(nodes,'Activity')&&section(nodes,'Questions')&&section(nodes,'Details'));
 nodes=openSection(h,props,'Activity');
 const story=nodes.filter(n=>n.type==='Text'&&['Created from a durable record','Task completed','Explicit progress report'].includes(n.props.children)).map(n=>n.props.children);
 assert.deepEqual(story,['Explicit progress report','Task completed','Created from a durable record'],'timeline and activity are merged, newest first');
 h.remount();nodes=h.draw(props);assert.ok(nodes.some(n=>n.props.children==='Created from a durable record'),'the open section survives a host remount');
 g.story=undefined;nodes=h.draw(props);assert.ok(nodes.some(n=>n.props.children==='No progress updates yet'));
 nodes=openSection(h,props,'Questions');assert.ok(nodes.some(n=>n.props.children==='No recorded questions'));
 g.tasks=[];nodes=h.draw(props);assert.equal(nodes.find(n=>n.props.accessibilityRole==='progressbar'),undefined);
});

test('goal-bound questionnaire answers preserve exact identity and stale draft protection without permission approval',async()=>{
 const h=harness(),calls=[],g=entry('questions','active');
 g.child={taskId:'task',childId:'child',jobId:'job',attempt:1};
 const question={id:'q1',revision:3,at:1700000000000,workerEpoch:'worker-epoch',status:'pending',request:{kind:'questionnaire',questions:[{id:'map',prompt:'Choose a map',options:[{value:'mapbox',label:'Mapbox'}],allowOther:true}]}};
 g.story={version:1,timeline:[],activity:[],questions:[question]};
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:'question-draft',locked:false,busy:false,executionAvailable:true,model:null,limits:{},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);assert.deepEqual(group(nodes,'Waiting'),['questions'],'a pending question puts a running goal under Waiting');
 button(nodes,g.text).props.onPress();nodes=h.draw(props);
 assert.equal(section(nodes,'Questions').props.accessibilityState.expanded,true,'Questions opens by default while a question is pending');
 assert.equal(button(nodes,'Submit answers').props.disabled,true);
 nodes.find(n=>n.props.accessibilityRole==='radio'&&n.props.accessibilityLabel==='Mapbox').props.onPress();nodes=h.draw(props);
 button(nodes,'Submit answers').props.onPress();await tick();assert.deepEqual(calls[0],{operation:'start',action:'goals.answer',expectedGoalId:'questions',expectedEntryRevision:2,questionId:'q1',questionRevision:3,workerEpoch:'worker-epoch',answer:{kind:'questionnaire',cancelled:false,answers:[{id:'map',value:'mapbox',wasCustom:false}]}});
 g.revision++;h.remount();nodes=h.draw(props);assert.equal(button(nodes,'Submit answers').props.disabled,true);button(nodes,'Submit answers').props.onPress();await tick();assert.equal(calls.length,1);
 button(nodes,'Review latest question').props.onPress();nodes=h.draw(props);assert.equal(button(nodes,'Submit answers').props.disabled,true);
 textbox(nodes,'Custom answer for Choose a map').props.onChangeText('Use city text');nodes=h.draw(props);button(nodes,'Submit answers').props.onPress();await tick();assert.equal(calls[1].expectedEntryRevision,3);assert.equal(calls[1].answer.answers[0].wasCustom,true);
 question.status='answered';question.answer=calls[1].answer;question.answeredAt=1700000060000;nodes=openSection(h,props,'Questions');assert.equal(button(nodes,'Submit answers'),undefined);assert.ok(nodes.some(n=>n.props.children==='Use city text'));
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

test('saved, delegated and current-session goals share one list and goal page; assigned goals and history stay read-only',()=>{
 const h=harness(),calls=[];
 const child={...entry('child'),child:{taskId:'task',childId:'child',jobId:'job',attempt:1}};
 const props={registry:{version:1,revision:1,entries:[entry('draft'),child]},assignedGoal:{...entry('parent'),tasks:[{text:'Recorded task',status:'completed'}]},completedAssigned:[{id:'old',text:'Old assigned goal',status:'completed',summary:'Recorded summary',tasks:[]}],colors,identity:'all-assignment-groups',locked:false,busy:false,executionAvailable:true,model:null,limits:{automaticTurns:null,noProgressTurns:null},post:async f=>{calls.push(f);return false;}};
 let nodes=h.draw(props);
 assert.deepEqual(group(nodes,'Not started'),['draft','child','assigned:parent'],'every goal source shares the same list rows');
 const current=h.assignedTickets(props.assignedGoal)[0],draft=h.savedPresentation(props.registry.entries[0]),running=h.savedPresentation(child);
 assert.equal(current.sourceId,'parent');assert.equal(current.reactKey,'current-session:parent');assert.equal(current.binding,'current-session');
 assert.equal(draft.sourceId,'draft');assert.equal(draft.reactKey,'catalog:draft');assert.equal(draft.binding,'unassigned');assert.equal(running.binding,'subagent');
 assert.notEqual(h.savedPresentation(entry('parent')).reactKey,current.reactKey,'Source identity must not collide with a React selection key');
 button(nodes,'Goal parent').props.onPress();nodes=h.draw(props);
 // This chat's own goal can only be paused or resumed. Nothing else on it is editable.
 const readOnly=(nodes,allowed=[])=>{
  for(const label of ['Start','Resume','Edit','Pause','Clear','Clear goal','···','Save task'].filter(label=>!allowed.includes(label)))assert.equal(button(nodes,label),undefined,label);
  for(const text of ['Add task','Pause the goal to add tasks','50-task limit reached'])assert.equal(JSON.stringify(nodes).includes(JSON.stringify(text)),false,text);
  assert.equal(textbox(nodes,'Subtask'),undefined);
 };
 readOnly(nodes,['Resume']);
 assert.ok(button(nodes,'Resume'),'a paused goal of this chat can be resumed from its page');
 assert.ok(nodes.some(n=>n.type==='Text'&&joined(n)==='This chat'),'the owner line names the current chat');
 for(const title of ['Activity','Questions','Details'])assert.ok(section(nodes,title),title);
 assert.ok(nodes.some(n=>n.props.accessibilityRole==='progressbar'&&n.props.accessibilityValue.now===1));
 nodes=openSection(h,props,'Questions');readOnly(nodes,['Resume']);assert.equal(button(nodes,'Submit answers'),undefined);
 assert.ok(nodes.some(n=>n.props.children==='No recorded questions available for this assigned goal'));
 button(nodes,'Back to goals').props.onPress();nodes=h.draw(props);completedHeading(nodes).props.onPress();nodes=h.draw(props);
 button(nodes,'Old assigned goal').props.onPress();nodes=openSection(h,props,'Details');
 assert.ok(nodes.some(n=>n.props.children==='Recorded summary'));readOnly(nodes);assert.equal(button(nodes,'Edit limits'),undefined,'finished goals have no limit editor');assert.deepEqual(calls,[]);
});

for (const assigned of [false,true]) for (const status of ['active','paused']) test(`dedicated limits editor preserves scope for ${assigned?'assigned':'delegated'} ${status} goals`,async()=>{
 const h=harness(),calls=[],g=entry(`limits-${assigned}-${status}`,status);
 Object.assign(g,{activationId:'activation-1',tokenBudget:500,tokensUsed:100,automaticTurns:8,noProgressTurns:3,continuationLimits:{automaticTurns:10,noProgressTurns:5},effectiveLimits:{automaticTurns:10,noProgressTurns:5},policyRevision:7,tasks:[{id:'keep',text:'Keep checklist',status:'in_progress'}]});
 const props={registry:{version:1,revision:1,entries:assigned?[]:[g]},assignedGoal:assigned?g:null,colors,identity:`live-limits-${assigned}-${status}`,locked:false,busy:false,executionAvailable:true,limitsEditable:true,model:null,limits:{automaticTurns:null,noProgressTurns:null},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);
 assert.equal(button(nodes,'Edit limits'),undefined,'limits live in the collapsed Details section');
 nodes=openSection(h,props,'Details');
 assert.equal(button(nodes,'Edit limits').props.disabled,false);
 assert.ok(nodes.some(n=>n.type==='Text'&&joined(n)==='8 / 10 responses · 100 / 500 tokens · 3 / 5 without progress'),'limits read on one line against their configured values');
 assert.equal(nodes.filter(n=>n.type==='Text'&&n.props.children===g.text).length,1,'single-line objective is not repeated below the title');
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
 props.limitsEditable=false;nodes=openSection(h,props,'Details');assert.equal(button(nodes,'Edit limits').props.disabled,true);
});

test('assigned wait diagnostics show recorded deadlines and evidence without inventing missing data',()=>{
 const h=harness(),g={...entry('observable','active'),waiting:'Waiting for an external completion',waitDeadline:1700000000000,lastTaskUpdateAt:1699999999000,lastWake:{at:1699999998000,reason:'user_input'},lastBlocker:{at:1699999997000,reason:'External dependency',evidence:'Recorded failure evidence',repeatedTurns:3}};
 const props={registry:{version:1,revision:1,entries:[]},assignedGoal:g,colors,identity:'wait-diagnostics',locked:false,busy:false,executionAvailable:true,limitsEditable:false,model:null,limits:{},post:async()=>false};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=openSection(h,props,'Details');
 for(const text of ['Safety wake:','Last wake:','Last checklist change:','Recorded failure evidence'])assert.ok(JSON.stringify(nodes).includes(text),text);
 delete g.waitDeadline;nodes=h.draw(props);assert.ok(JSON.stringify(nodes).includes('Wait deadline unavailable in this runtime'));
});
test('stopped questionnaires stay readable but cannot submit or cancel a dead waiter',async()=>{
 for(const status of ['paused','blocked','usage_limited','budget_limited','complete','cleared']){
  const h=harness(),g=entry(`stopped-${status}`,status),calls=[];
  g.child={taskId:'task',childId:'child',jobId:'job',attempt:1};
  g.story={version:1,timeline:[],activity:[],questions:[{id:'q',revision:1,at:1,workerEpoch:'old',status:'pending',request:{kind:'questionnaire',questions:[{id:'x',prompt:'Pick?',options:[{value:'yes',label:'Yes'}],allowOther:false}]}}]};
  const props={registry:{version:1,revision:1,entries:[g]},colors,identity:g.id,locked:false,busy:false,executionAvailable:true,limits:{},post:async f=>{calls.push(f);return false;}};
  let nodes=h.draw(props);if(['complete','cleared'].includes(status)){completedHeading(nodes).props.onPress();nodes=h.draw(props);}
  assert.ok(!JSON.stringify(nodes).includes('Waiting for you'),'the list does not ask for an answer nobody can receive');
  if(status!=='paused'&&!['complete','cleared'].includes(status))assert.deepEqual(group(nodes,'Waiting'),[g.id]);
  button(nodes,g.text).props.onPress();nodes=h.draw(props);
  assert.equal(section(nodes,'Questions').props.accessibilityState.expanded,true,'a recorded pending question stays visible');
  assert.ok(nodes.some(n=>n.props.children==='Pick?'));
  for(const label of ['Submit answers','Cancel questions']){const b=button(nodes,label);assert.ok(!b||b.props.disabled);b?.props.onPress();}
  assert.ok(!JSON.stringify(nodes).includes('Waiting for you'));await tick();assert.deepEqual(calls,[]);
 }
});

test('task capacity disables Add and preserves an open draft when the final slot fills',()=>{
 const h=harness(),g=entry('capacity');g.tasks=Array.from({length:49},(_,i)=>({id:`t${i}`,text:`Task ${i}`,status:'pending'}));
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:g.id,locked:false,busy:false,executionAvailable:true,limits:{},post:async()=>false};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);row(nodes,'Add task').props.onPress();nodes=h.draw(props);textbox(nodes,'Subtask').props.onChangeText('Keep this draft');nodes=h.draw(props);assert.equal(button(nodes,'Save task').props.disabled,false);
 g.tasks.push({id:'last',text:'Concurrent task',status:'pending'});g.revision++;nodes=h.draw(props);assert.equal(button(nodes,'Save task').props.disabled,true);assert.equal(textbox(nodes,'Subtask').props.value,'Keep this draft');
 button(nodes,'Cancel').props.onPress();nodes=h.draw(props);assert.equal(row(nodes,'Add task'),undefined);assert.equal(row(nodes,'50-task limit reached').props.disabled,true);
});

test('history renders calendar day and model is only an authenticated child launch value',()=>{
 const h=harness(),g=entry('truthful');g.child={taskId:'task',childId:'child',jobId:'job',attempt:1,model:'provider/actual-role-model'};
 g.story={version:1,timeline:[{id:'old',at:new Date(2020,0,2,9).getTime(),kind:'created',text:'Old event'}],activity:[]};
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:g.id,locked:false,busy:false,executionAvailable:true,model:'false-default',limits:{},post:async()=>false};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);assert.ok(nodes.some(n=>n.type==='Text'&&joined(n)==='Coordinator · provider/actual-role-model'),'owner line names the launched model');assert.ok(!JSON.stringify(nodes).includes('false-default'));
 nodes=openSection(h,props,'Details');assert.ok(JSON.stringify(nodes).includes('Launch model: provider/actual-role-model'));assert.ok(!JSON.stringify(nodes).includes('false-default'));
 nodes=openSection(h,props,'Activity');assert.ok(nodes.some(n=>n.type==='Text'&&typeof n.props.children==='string'&&n.props.children.includes('2020')));
});

test('history is bounded, pending questions remain discoverable and context never preselects a recommendation',()=>{
 const h=harness(),g=entry('bounded','active');g.child={taskId:'task',childId:'child',jobId:'job',attempt:1};
 g.story={version:1,timeline:[],activity:Array.from({length:21},(_,i)=>({id:`a${i}`,at:100+i,text:`Update ${i}`})),coverage:{activityTruncated:true},questions:[{id:'q',revision:1,at:1,workerEpoch:'epoch',status:'pending',request:{kind:'questionnaire',questions:[{id:'x',prompt:'Pick?',background:'Authored background',recommendation:'yes',options:[{value:'yes',label:'Yes'}],allowOther:false}]}}]};
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:g.id,locked:false,busy:false,executionAvailable:true,limits:{},post:async()=>false};
 let nodes=h.draw(props);assert.ok(JSON.stringify(nodes).includes('Waiting for your answer'));assert.deepEqual(group(nodes,'Waiting'),[g.id]);
 button(nodes,g.text).props.onPress();nodes=h.draw(props);assert.equal(section(nodes,'Questions').props.accessibilityState.expanded,true);
 assert.ok(nodes.some(n=>n.props.children==='Authored background'));assert.ok(JSON.stringify(nodes).includes('Recommended'));assert.equal(button(nodes,'Submit answers').props.disabled,true);assert.equal(nodes.find(n=>n.props.accessibilityRole==='radio').props['aria-checked'],false);
 nodes=openSection(h,props,'Activity');assert.equal(nodes.filter(n=>typeof n.props.children==='string'&&/^Update \d+$/.test(n.props.children)).length,10);assert.ok(nodes.some(n=>n.props.children==='Update 20'));assert.ok(!nodes.some(n=>n.props.children==='Update 0'));button(nodes,'Show older updates').props.onPress();nodes=h.draw(props);assert.equal(nodes.filter(n=>typeof n.props.children==='string'&&/^Update \d+$/.test(n.props.children)).length,20);assert.ok(JSON.stringify(nodes).includes('Earlier records omitted'));
 g.observation={state:'unavailable',at:1};nodes=h.draw(props);assert.ok(JSON.stringify(nodes).includes('Recorded working'));nodes=openSection(h,props,'Questions');assert.equal(button(nodes,'Cancel questions').props.disabled,true);
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
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:g.id,locked:false,busy:false,executionAvailable:true,limits:{},post:async()=>false};let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);assert.ok(!nodes.some(n=>n.type==='Text'&&n.props.children==='Exact engine failure'));nodes=openSection(h,props,'Details');assert.ok(nodes.some(n=>n.type==='Text'&&n.props.children==='Exact engine failure'));assert.equal(g.status,'paused');assert.deepEqual(g.tasks,[]);
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
 let nodes=h.draw(props);button(nodes,'New goal').props.onPress();nodes=h.draw(props);textbox(nodes,'New goal').props.onChangeText('Authored outcome is not translated');nodes=h.draw(props);h.setLocale('zh-CN');nodes=h.draw(props);assert.equal(textbox(nodes,'新建目标').props.value,'Authored outcome is not translated');assert.ok(button(nodes,'创建'));button(nodes,'创建').props.onPress();await tick();assert.equal(calls[0].objective,'Authored outcome is not translated');
 const old=harness();let oldNodes=old.draw({...props,identity:'old-native'});assert.ok(oldNodes.some(node=>node.type==='Text'&&node.props.children==='No goals yet'));button(oldNodes,'New goal').props.onPress();oldNodes=old.draw({...props,identity:'old-native'});assert.ok(button(oldNodes,'Create'));assert.equal(button(oldNodes,'创建'),undefined);
 const authored=entry('11111111-1111-4111-8111-111111111111');authored.text='New goal';props.registry.entries=[authored];props.identity='localized-authored';const n=harness({locale:'zh-CN'});let ns=n.draw(props);button(ns,'New goal').props.onPress();ns=n.draw(props);assert.ok(ns.some(node=>node.type==='Text'&&node.props.children==='New goal'),'authored objective is never passed through translation');
});

test('planning controls submit exact identities, retain evidence and reject stale open drafts',async()=>{
 const h=harness(),calls=[],g=entry('planning');g.tasks=[{id:'a',text:'First task',status:'pending'},{id:'b',text:'Second task',status:'pending'}];g.planning={dependencies:[],blockers:[{id:'recorded',at:1,reason:'External service',evidence:'Actual evidence'}]};
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:g.id,planningAvailable:true,locked:false,busy:false,executionAvailable:true,limits:{},post:async fields=>{calls.push(fields);return false;}};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=openSection(h,props,'Details');assert.ok(nodes.some(n=>n.type==='Text'&&n.props.children==='Dependencies and blockers'));button(nodes,'Edit dependencies').props.onPress();nodes=h.draw(props);nodes.find(n=>n.props.accessibilityRole==='checkbox').props.onPress();nodes=h.draw(props);button(nodes,'Save planning').props.onPress();await tick();assert.equal(calls[0].action,'goals.dependencies');assert.equal(calls[0].expectedGoalId,g.id);assert.equal(calls[0].expectedEntryRevision,2);assert.deepEqual(calls[0].waitsFor,['b']);
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

test('a goal shows the pull requests its coordinator reported',async()=>{
 const h=harness(),g=entry('prs','active');
 g.prs=[
  {ref:'github.com/o/r#5',url:'https://github.com/o/r/pull/5',title:'Add the widget',branch:'b5',state:'merged',ci:'green',checkedAt:1},
  {ref:'gitlab.com/g/r#7',url:'https://gitlab.com/g/r/-/merge_requests/7',title:'Fix the docs',state:'open',ci:'failed',checkedAt:2},
 ];
 const props={registry:{version:1,revision:1,entries:[g]},colors,identity:g.id,locked:false,busy:false,executionAvailable:true,limits:{},post:async()=>false};
 let nodes=h.draw(props);button(nodes,g.text).props.onPress();nodes=h.draw(props);
 const texts=JSON.stringify(nodes);
 assert.ok(texts.includes('Pull requests'));
 const prRow=(nodes,title)=>nodes.find(node=>node.type==='Pressable'&&node.props.accessibilityLabel?.startsWith(`${title}, `));
 const icon=row=>JSON.stringify(row.props.children).match(/"name":"(Circle\w*|Clock)"/)?.[1];
 assert.equal(prRow(nodes,'Add the widget').props.accessibilityLabel,'Add the widget, Merged');
 assert.equal(prRow(nodes,'Fix the docs').props.accessibilityLabel,'Fix the docs, Open · CI failed','an open PR says what it waits on in plain words');
 assert.match(texts,/r#5 · Merged · /);assert.match(texts,/r#7 · Open · CI failed · /);
 assert.equal(icon(prRow(nodes,'Add the widget')),'CircleCheck');assert.equal(icon(prRow(nodes,'Fix the docs')),'Circle','no condition yet: no verdict is invented');
 prRow(nodes,'Fix the docs').props.onPress();assert.deepEqual(openedUrls.splice(0),['https://gitlab.com/g/r/-/merge_requests/7'],'a PR row opens exactly its own URL');
 assert.ok(!texts.includes('Completion conditions'),'no gate section before the gate has run');
 assert.ok(!texts.includes('Copy command'),'no command to copy before the gate has run');
 g.checks=[{command:'forge-pr -R github.com/o/r check 5 --ci-green',verdict:'ok',at:1},{command:'forge-pr -R gitlab.com/g/r check 7 --ci-green',verdict:'failed',detail:'CI failed',at:2}];
 nodes=h.draw(props);let gate=JSON.stringify(nodes);
 assert.ok(!gate.includes('Completion conditions'),'conditions that belong to a PR sit on its row');
 assert.equal(icon(prRow(nodes,'Add the widget')),'CircleCheck');assert.equal(icon(prRow(nodes,'Fix the docs')),'CircleX','the failed condition marks its PR');
 const copy=nodes.filter(n=>n.type==='Pressable'&&n.props.accessibilityLabel?.startsWith('Copy command: '));
 assert.deepEqual(copy.map(n=>n.props.accessibilityLabel.slice('Copy command: '.length)),g.checks.map(check=>check.command),'each PR copies the exact command that checks it');
 copy[1].props.onPress();await tick();assert.deepEqual(copied.splice(0),[g.checks[1].command]);
 g.checks.push({command:'make release-check',verdict:'pending',at:3});
 nodes=h.draw(props);gate=JSON.stringify(nodes);
 assert.ok(gate.includes('Completion conditions'),'a condition without a PR keeps its own list');
 assert.ok(nodes.some(n=>n.type==='Text'&&n.props.children==='release-check')||gate.includes('make release-check'));
 assert.ok(gate.includes('"accessibilityLabel":"running"'),'its verdict is shown');
 g.checks.pop();
 const valid={...entry('22222222-2222-4222-8222-222222222222'),prs:g.prs,checks:g.checks};
 assert.equal(schemas.delegatedGoalEntrySchema.safeParse(valid).success,true);
 assert.equal(schemas.delegatedGoalEntrySchema.safeParse({...valid,prs:[{...g.prs[0],state:'draft'}]}).success,false);
});

test('the current-session goal shows its pull requests and their completion conditions too',()=>{
 const h=harness();
 const assigned={id:'33333333-3333-4333-8333-333333333333',text:'Current test goal',status:'paused',tasks:[],waiting:null,iteration:0,tokensUsed:0,tokenBudget:null,automaticTurns:0,noProgressTurns:0,safetyPauseCause:null,summary:null,
  prs:[{ref:'github.com/o/r#9',url:'https://github.com/o/r/pull/9',title:'Current PR',state:'open',ci:'pending',checkedAt:1}],
  checks:[{command:'forge-pr -R github.com/o/r check 9 --ci-green',verdict:'pending',detail:'CI running',at:1}]};
 const props={registry:{version:1,revision:1,entries:[]},assignedGoal:assigned,colors,identity:'current',locked:false,busy:false,executionAvailable:true,limits:{},post:async()=>false};
 let nodes=h.draw(props);button(nodes,assigned.text).props.onPress();nodes=h.draw(props);
 const texts=JSON.stringify(nodes);
 for(const expected of ['Pull requests','Current PR, Open · CI running','Copy command: forge-pr -R github.com/o/r check 9 --ci-green'])assert.ok(texts.includes(expected),expected);
 assert.ok(texts.includes('"name":"Clock"'),'the pending condition shows as running on its PR');
});
