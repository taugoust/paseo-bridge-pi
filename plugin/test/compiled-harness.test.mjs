import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const flush = () => new Promise(resolve => setImmediate(resolve));
const nodes = element => !element || typeof element !== 'object' ? [] : [element, ...[element.props?.children].flat(Infinity).flatMap(nodes)];
const text = element => !element ? '' : typeof element === 'string' ? element : typeof element !== 'object' ? '' : [element.props?.children].flat(Infinity).map(text).join(' ');

test('compiled read-only panels render lists/details, bind generations and only navigate verified child links', { skip: !compilerPath }, async () => {
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { clientBundle } = await compilePlugin({ client: resolve(root, 'index.client.tsx') });
  const observers = [], pills = [], panels = new Map(), calls = [], queries = [], opened = [];
  const states = [];
  let hookIndex = 0, stoppedPanels = 0;
  const identity = { available: true, sessionId: 'session', runtimeEpoch: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', reason: null };
  let statusResult = { data: identity, isPending: false, isError: false };
  let listResult = { data: { protocol: 1, state: 'available', sessionId: 'session', items: [], stale: true, lastUpdated: null } };
  let detailResult = {};
  const jsx = (type, props) => {
    assert.ok(typeof type === 'string' || typeof type === 'function', `Invalid JSX type: ${String(type)}`);
    return typeof type === 'function' ? type(props) : { type, props };
  };
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: contract => contract, defineSettings: contract => contract };
    if (name === '@getpaseo/plugin/client/ui') return { SettingsAction:'SettingsAction' };
    if (name === '@getpaseo/plugin/client') return { useSettings: () => ({ status: 'loading' }), useRpc: contract => async input => {
      contract.input.parse(input); calls.push({ name: contract.name, input }); return {};
    } };
    if (name === '@getpaseo/plugin/client/react-native') return { ScrollView: 'ScrollView', Icon:'Icon', copyText:async () => {} };
    if (name === 'react-native') return { Text: 'Text', View: 'View', Pressable: 'Pressable', Animated: { Value: class { interpolate() { return 0; } } } };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (name === 'react') return { Fragment:'Fragment', useEffect() {}, useLayoutEffect() {}, useRef:initial=>({current:initial}), useMemo:fn=>fn(), useCallback:fn=>fn, useState: initial => {
      const slot = hookIndex++; if (!(slot in states)) states[slot] = initial;
      return [states[slot], value => { states[slot] = value; }];
    } };
    if (name === '@tanstack/react-query') return {
      useMutation() { throw new Error('Read-only panels must not mutate'); },
      useQuery: options => {
        queries.push(options);
        const result = options.queryKey[0] === 'harness-status' ? statusResult : options.queryKey[0] === 'harness-list' ? listResult : detailResult;
        return { isPending: false, isFetching: false, isError: false, refetch: async () => {}, ...result };
      },
    };
    return require(name);
  };
  const contribute = (0, eval)(clientBundle)(load).default;
  const cleanup = contribute({
    paseo: { config:{get:async()=>({config:{plugins:{'paseo-accounts':{enabled:true}}}})}, agents: { list: async ({ signal }) => ({ subscription: { subscribe: value => observers.push({ value, signal }) } }) } },
    rpc: async () => ({ available: false, enabled: null }),
    addScreen: () => () => {},
    openScreen() {},
    addWorkspacePanel: panel => { panels.set(panel.id, panel); return () => { stoppedPanels++; }; },
    addHeaderButton: button => ({ ...button, update() {}, remove() {} }),
    addComposerPill: pill => { const registration = { ...pill, removed: false, update() {}, remove() { this.removed = true; } }; pills.push(registration); return registration; },
    openPanel: (id, target) => opened.push({ id, target }),
  });
  const props = { context: 'agent', layout:{platform:'web',compact:false}, agentId: 'agent', workspaceId: 'workspace', host: { id: 'host', label: 'Host' }, theme: { colors: { foreground: '#fff', foregroundMuted: '#aaa', statusDanger: '#f00' } }, navigation: { openAgent: input => opened.push(input) } };
  function render(id) { hookIndex = 0; queries.length = 0; return panels.get(id).Component(props); }
  const press = (tree, label) => { const match = nodes(tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label); assert.ok(match, label); match.props.onPress(); };
  try {
    await flush();
    const snapshot = { entries: [{ agent: { id: 'agent', workspaceId: 'workspace', provider: 'pi' } }, { agent: { id: 'other', workspaceId: 'workspace', provider: 'claude' } }] };
    observers.forEach(({ value }) => value.snapshot(snapshot));
    const registeredPills = pills.length;
    assert.equal(panels.size, 5);
    assert.equal(pills.find(pill => pill.id === 'work').button.behavior.kind, 'action');
    assert.ok(!pills.some(pill => ['harness-jobs', 'harness-subagents', 'foreground-tasks'].includes(pill.id)));
    observers.forEach(({ value }) => value.update({ type: 'agent_update', payload: { kind: 'upsert', agent: snapshot.entries[0].agent } }));
    assert.equal(pills.length, registeredPills, 'stream updates must not rebuild views');

    statusResult = { isPending: true };
    assert.match(text(render('harness-jobs')), /Connecting/);
    assert.equal(queries[1].enabled, false);
    statusResult = { data: { available: false, reason: 'Reload required' }, isPending: false };
    assert.match(text(render('harness-jobs')), /Reload required/);
    statusResult = { data: identity, isError: true };
    assert.match(text(render('harness-jobs')), /Session status unavailable/);
    statusResult = { data: identity };
    assert.match(text(render('harness-jobs')), /No\s+background jobs/);
    const job = { jobId: `job-${'a'.repeat(24)}`, status: 'running', name: 'Build', createdAt: new Date().toISOString(), updatedAt: null, observationOnly: false };
    listResult.data.items = [job];
    let tree = render('harness-jobs');
    const row = nodes(tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel.startsWith('Build · running'));
    assert.equal(row.props.accessibilityState.expanded, false, 'Jobs shares the accessible Agents disclosure');
    assert.equal(row.props['aria-expanded'], false, 'web exposes the disclosure state');
    assert.match(text(row), /Build.*Running/);
    assert.ok(nodes(row).some(node => node.type === 'Icon' && node.props.name === 'ChevronDown'));
    assert.equal(queries[2].enabled, false, 'status refresh must not retrieve collapsed output');
    assert.ok(nodes(tree).some(node => node.props?.style?.padding === 12), 'the standalone panel keeps its own padding; only the embedded Work list drops it');
    const list = nodes(tree).find(node => node.props?.style?.borderWidth === 1 && node.props.style.borderRadius === 8 && node.props.style.overflow === 'hidden');
    assert.ok(list && nodes(list).includes(row), 'job rows sit in one bordered list');
    row.props.onPress();
    detailResult = { data: { state: 'available', item: { jobId: job.jobId, text: 'Build output', stale: true, lastUpdated: null, truncated: true } } };
    tree = render('harness-jobs');
    assert.match(text(tree), /Build output/);
    assert.match(text(tree), /truncated/);
    const output = nodes(tree).find(node => node.type === 'Text' && node.props.children === 'Build output');
    assert.equal(output.props.selectable, true);
    assert.deepEqual(output.props.style, { color: '#fff', fontFamily: 'monospace', fontSize: 12, lineHeight: 18 });
    assert.equal(nodes(tree).filter(node => node.type === 'ScrollView').length, 2, 'output scrolls within a bounded well');
    assert.ok(nodes(tree).some(node => node.type === 'ScrollView' && node.props.style.maxHeight === 320));
    assert.ok(nodes(tree).some(node => node.props?.accessibilityLabel === 'Copy'), 'copy stays inside expanded output');
    await queries[2].queryFn();
    assert.equal(calls.at(-1).name, 'harness_jobs_output');
    assert.equal(calls.at(-1).input.expectedRuntimeEpoch, identity.runtimeEpoch);
    statusResult = { data: { ...identity, runtimeEpoch: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb' } };
    assert.doesNotMatch(text(render('harness-jobs')), /Build output/);
    assert.equal(queries[2].enabled, false, 'old selection invalidated by reload');

    statusResult = { data: identity }; states.length = 0;
    listResult.data.items = [{ ...job, name: null, status: 'completed', observationOnly: true }];
    tree = render('harness-jobs');
    const finishedRow = nodes(tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel?.startsWith(job.jobId));
    assert.ok(finishedRow && nodes(nodes(tree).find(node => node.props?.style?.borderWidth === 1 && node.props.style.borderRadius === 8)).includes(finishedRow), 'the all-jobs panel keeps finished jobs in the same bordered list, not a card per row');
    assert.ok(!nodes(tree).some(node => node.props?.style?.borderRadius === 10), 'no per-row card');
    assert.match(text(tree), new RegExp(`${job.jobId}.*Completed · .* · Observation only`), 'real ID fallback and observation label remain visible');
    states.length = 0;
    const task = { taskId: `subagent-task-${'b'.repeat(24)}`, childId: `subagent-child-${'c'.repeat(24)}`, groupId: `subagent-job-${'d'.repeat(24)}`, runtimeId: 'runtime', title: 'Review', status: 'completed', attempt: 1,
      source: { agentId: 'nested-owner', workspaceId: 'nested-workspace', sessionId: 'nested-session', runtimeEpoch: identity.runtimeEpoch } };
    listResult = { data: { state: 'available', items: [task], stale: true, lastUpdated: null } };
    tree = render('harness-subagents');
    press(tree, 'Review · Completed');
    detailResult = { data: { state: 'available', item: { ...task, text: 'Reviewed successfully', truncated: false, stale: true, lastUpdated: null, paseoAgentId: 'verified-child' } } };
    tree = render('harness-subagents');
    assert.match(text(tree), /Reviewed successfully/);
    press(tree, 'Open chat');
    assert.deepEqual(opened.pop(), { agentId: 'verified-child', serverId: 'host' });
    await queries[2].queryFn();
    assert.equal(calls.at(-1).name, 'harness_subagent_report');
    assert.equal(calls.at(-1).input.taskId, task.taskId, 'standalone report uses task ID, never the scoped selection key');
    assert.equal(calls.at(-1).input.agentId, 'nested-owner');
    assert.equal(calls.at(-1).input.workspaceId, 'nested-workspace');
    assert.equal(calls.at(-1).input.expectedSessionId, 'nested-session');
    assert.equal(calls.at(-1).input.expectedRuntimeEpoch, identity.runtimeEpoch);
    delete detailResult.data.item.paseoAgentId;
    assert.doesNotMatch(text(render('harness-subagents')), /Open chat/);
    assert.ok(calls.every(call => ['harness_jobs_output', 'harness_subagent_report'].includes(call.name)));
    assert.doesNotMatch(text(tree), /Cancel|Reap|Send instruction/);
  } finally { cleanup(); }
  assert.equal(stoppedPanels, 5);
  assert.ok(observers.every(({ signal }) => signal.aborted));
  assert.ok(pills.every(pill => pill.removed));
});
