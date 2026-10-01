import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const flush = () => new Promise(resolve => setImmediate(resolve));
const walk = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(walk)];
const text = node => !node ? '' : typeof node === 'string' ? node : typeof node === 'number' ? String(node) : typeof node !== 'object' ? '' : [node.props?.children].flat(Infinity).map(text).join(' ');

test('compiled foreground popover reports closed-state attention, persists interaction answers/drafts, and locks uncertain in-flight actions across reopen', { skip: !compilerPath }, async () => {
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { clientBundle } = await compilePlugin({ client: resolve(root, 'index.client.tsx') });
  const observers = [], pills = [], calls = [], statusCalls = [], states = [], refs = [], effects = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0, deferPrompt = false, resolvePrompt, closes = 0;
  let viewState = { isStale: false, isFetching: false, isError: false };
  const task = { taskId: 'task-1', childId: 'child-1', workerEpoch: 'worker-1', groupId: 'group-1', attempt: 1, title: 'Helper', model: 'harness-test/mock:off', status: 'waiting-permission',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z', pendingInteractions: 2, canPrompt: true, canStop: true };
  const status = { available: true, sessionId: 'session', runtimeEpoch: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', tasks: [task], reason: null };
  const view = { task, messages: [...Array.from({ length: 21 }, (_, index) => ({ id: `prior-${index}`, role: 'user', text: `Prior activity ${index}`, timestamp: 'now' })),
    { id: 'm1', role: 'assistant', text: 'Working', timestamp: 'now', truncated: true }], interactions: [
    { id: 'permission-1', workerEpoch: 'worker-1', createdAt: 'now', request: { kind: 'permission', title: 'Run command?', options: ['allow', 'deny'] } },
    { id: 'question-1', workerEpoch: 'worker-1', createdAt: 'now', request: { kind: 'questionnaire', questions: [{ id: 'choice', prompt: 'Which route?', options: [{ value: 'a', label: 'Route A' }, { value: 'b', label: 'Route B' }], allowOther: false }] } },
  ], nextCursor: 'history-cursor', truncated: true };
  const jsx = (type, props) => typeof type === 'function' ? type(props) : { type, props };
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: contract => contract };
    if (name === '@getpaseo/plugin/client') return { useRpc: contract => async input => {
      contract.input.parse(input); calls.push({ name: contract.name, input });
      if (contract.name === 'foreground_tasks_control') {
        if (input.request.operation === 'prompt' && deferPrompt) {
          deferPrompt = false;
          return await new Promise(resolve => { resolvePrompt = resolve; });
        }
        return { protocol: 1, sessionId: 'session', epoch: 'service', state: 'available', accepted: true };
      }
      throw new Error(`unexpected RPC ${contract.name}`);
    } };
    if (name === '@getpaseo/plugin/client/react-native') return { TextInput: 'TextInput' };
    if (name === 'react-native') return { Text: 'Text', View: 'View', Pressable: 'Pressable' };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (name === 'react') return {
      useEffect(effect, deps = []) {
        const slot = effectIndex++;
        const prior = effects[slot];
        if (!prior || deps.length !== prior.deps.length || deps.some((value, i) => value !== prior.deps[i])) {
          prior?.cleanup?.(); effects[slot] = { deps, cleanup: effect() };
        }
      },
      useMemo: fn => fn(),
      useRef: initial => { const slot = refIndex++; return refs[slot] ??= { current: initial }; },
      useState: initial => {
        const slot = stateIndex++;
        if (!(slot in states)) states[slot] = typeof initial === 'function' ? initial() : initial;
        return [states[slot], value => { states[slot] = typeof value === 'function' ? value(states[slot]) : value; }];
      },
    };
    if (name === '@tanstack/react-query') return { useQuery: options => {
      const key = options.queryKey[0];
      return { isPending: false, isFetching: false, isError: false, isStale: false, refetch: async () => {},
        ...(key === 'foreground-tasks' ? { data: status } : { ...viewState, data: view }) };
    } };
    return require(name);
  };
  const contribute = (0, eval)(clientBundle)(load).default;
  const cleanup = contribute({
    paseo: { agents: { list: async () => ({ subscription: { subscribe: value => observers.push(value) } }) } },
    rpc: async (contract, input) => { statusCalls.push({ name: contract.name, input }); return status; },
    addWorkspacePanel: () => () => {},
    addComposerPill: pill => {
      const registration = { ...pill, updates: [], update(patch) { this.updates.push(patch); this.button = { ...this.button, ...patch }; }, remove() {} };
      pills.push(registration); return registration;
    },
  });
  const agent = { id: 'agent', workspaceId: 'workspace', provider: 'pi' };
  const props = { context: 'agent', agentId: 'agent', workspaceId: 'workspace', host: { id: 'host', label: 'Host' }, layout: { compact: true, platform: 'ios' },
    theme: { colors: { foreground: '#fff', foregroundMuted: '#aaa', statusDanger: '#f00', border: '#555', surface1: '#222' } }, close() { closes++; } };
  function resetMount() {
    for (const effect of effects) effect?.cleanup?.();
    effects.length = 0; states.length = 0; refs.length = 0;
  }
  function render() {
    stateIndex = 0; refIndex = 0; effectIndex = 0;
    return pills.find(pill => pill.id === 'foreground-tasks').button.behavior.Content(props);
  }
  const press = (tree, label) => {
    const item = walk(tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel === label);
    assert.ok(item, `${label}; tree=${text(tree)}`); assert.equal(item.props.disabled, false, `${label} unexpectedly disabled`); item.props.onPress(); return item;
  };
  const node = (tree, type, label) => walk(tree).find(item => item.type === type && item.props.accessibilityLabel === label);
  try {
    await flush(); observers.forEach(observer => observer.snapshot({ entries: [{ agent }] })); await flush();
    const pill = pills.find(item => item.id === 'foreground-tasks');
    assert.ok(pill); assert.equal(pill.button.behavior.kind, 'popover');
    assert.ok(statusCalls.some(call => call.name === 'foreground_tasks_status'), 'composer pill polls status while closed');
    assert.match(pill.updates.at(-1).label, /Q\d+.*P\d+/); assert.match(pill.updates.at(-1).title, /permissions/);

    let tree = render();
    assert.equal(walk(tree).some(item => item.type === 'ScrollView'), false, 'composer popover must use only the host surface scroll owner');
    assert.equal(tree.props.style.maxHeight, 410);
    assert.match(text(tree), /Helper · waiting-permission/);
    assert.equal(calls.length, 0, 'opening a pending permission never submits a decision');
    press(tree, 'Helper · waiting-permission · harness-test/mock:off · 2 awaiting you');
    tree = render(); assert.match(text(tree), /Working/);
    assert.match(text(tree), /harness-test\/mock:off/, 'task detail must display the resolved model');
    assert.equal(calls.length, 0, 'rendering pending interactions never submits a decision');
    const treeNodes = walk(tree);
    const approvalIndex = treeNodes.findIndex(item => item.type === 'Pressable' && item.props.accessibilityLabel === 'allow');
    const historyIndex = treeNodes.findIndex(item => item.type === 'Text' && text(item).includes('Recent activity · newest first'));
    const sendIndex = treeNodes.findIndex(item => item.type === 'Pressable' && item.props.accessibilityLabel === 'Send message');
    const stopIndex = treeNodes.findIndex(item => item.type === 'Pressable' && item.props.accessibilityLabel === 'Stop helper');
    assert.ok(approvalIndex >= 0 && historyIndex > approvalIndex, 'pending approvals must appear above activity history');
    assert.ok(sendIndex >= 0 && historyIndex > sendIndex, 'prompt composer must appear above activity history');
    assert.ok(stopIndex >= 0 && historyIndex > stopIndex, 'Stop must appear above activity history');
    assert.match(text(tree), /Showing the newest 20 of\s+22\s+fetched messages/);
    assert.match(text(tree), /assistant\s+·\s+message truncated/);
    assert.match(text(tree), /Earlier worker activity is available but not shown in this view/);
    view.nextCursor = undefined; tree = render();
    assert.match(text(tree), /Earlier worker history was truncated and cannot be recovered/);
    view.nextCursor = 'history-cursor'; tree = render();

    // Questionnaire choices survive popover dismissal/reopen.
    press(tree, 'Route A'); tree = render();
    assert.ok(node(tree, 'Pressable', '✓ Route A'));
    const input = node(tree, 'TextInput', 'Message foreground helper');
    input.props.onChangeText('unsent draft'); tree = render();
    press(tree, 'Close'); assert.equal(closes, 1);
    resetMount(); tree = render();
    assert.equal(node(tree, 'TextInput', 'Message foreground helper').props.value, 'unsent draft');
    assert.ok(node(tree, 'Pressable', '✓ Route A'), 'questionnaire answer was not retained across reopen');

    press(tree, 'Submit answers'); await flush();
    const questionnaire = calls.filter(call => call.name === 'foreground_tasks_control').at(-1);
    assert.equal(questionnaire.input.request.operation, 'respond');
    assert.equal(questionnaire.input.request.interactionId, 'question-1');
    assert.deepEqual(questionnaire.input.request.answer, { kind: 'questionnaire', cancelled: false, answers: [{ id: 'choice', value: 'a', wasCustom: false }] });
    assert.match(questionnaire.input.request.requestId, /^[0-9a-f-]{36}$/);

    tree = render(); press(tree, 'allow'); await flush();
    const permission = calls.filter(call => call.name === 'foreground_tasks_control').at(-1);
    assert.equal(permission.input.request.interactionId, 'permission-1');
    assert.deepEqual(permission.input.request.answer, { kind: 'permission', cancelled: false, value: 'allow' });
    assert.match(permission.input.request.requestId, /^[0-9a-f-]{36}$/);

    // An accepted stop gets a fresh id after close/reopen and a new user turn.
    tree = render(); press(tree, 'Stop helper'); await flush();
    const firstStop = calls.filter(call => call.name === 'foreground_tasks_control' && call.input.request.operation === 'stop').at(-1);
    press(tree, 'Close'); resetMount(); tree = render();
    node(tree, 'TextInput', 'Message foreground helper').props.onChangeText('fresh turn after stop'); tree = render();
    press(tree, 'Send message'); await flush();
    const freshPrompt = calls.filter(call => call.name === 'foreground_tasks_control' && call.input.request.operation === 'prompt').at(-1);
    assert.equal(freshPrompt.input.request.message, 'fresh turn after stop');
    press(tree, 'Stop helper'); await flush();
    const secondStop = calls.filter(call => call.name === 'foreground_tasks_control' && call.input.request.operation === 'stop').at(-1);
    assert.notEqual(secondStop.input.request.requestId, firstStop.input.request.requestId, 'confirmed stop id must not be reused for a later turn');

    // Close/reopen while a prompt is unresolved keeps the worker and mutation lock.
    tree = render();
    node(tree, 'TextInput', 'Message foreground helper').props.onChangeText('submitted draft'); tree = render();
    deferPrompt = true; press(tree, 'Send message'); await flush();
    const submitted = calls.filter(call => call.name === 'foreground_tasks_control' && call.input.request.operation === 'prompt').at(-1);
    assert.equal(submitted.input.request.message, 'submitted draft');
    press(tree, 'Close'); resetMount(); tree = render();
    assert.equal(node(tree, 'TextInput', 'Message foreground helper').props.value, 'submitted draft');
    assert.equal(node(tree, 'Pressable', 'Send message').props.disabled, true, 'reopen must not allow a duplicate while the original is pending');
    node(tree, 'TextInput', 'Message foreground helper').props.onChangeText('newer draft'); tree = render();
    assert.equal(node(tree, 'TextInput', 'Message foreground helper').props.value, 'newer draft');
    assert.equal(node(tree, 'Pressable', 'Send message').props.disabled, true);
    resolvePrompt({ protocol: 1, sessionId: 'session', epoch: 'service', state: 'available', accepted: true });
    await flush(); await flush(); tree = render();
    assert.equal(node(tree, 'TextInput', 'Message foreground helper').props.value, 'newer draft', 'late success must not clear a newer draft');
    assert.match(text(tree), /Message accepted and queued for the helper/);
    assert.equal(node(tree, 'Pressable', 'Send message').props.disabled, false, 'completed request lock was not released');

    // A stale view disables actions even with cached current task status.
    viewState = { isStale: true };
    tree = render();
    assert.equal(node(tree, 'Pressable', 'allow').props.disabled, true, 'stale view must disable permission decisions');
    assert.equal(node(tree, 'Pressable', 'Send message').props.disabled, true, 'stale conversation must disable prompts');
    // A replaced worker identity disables decisions from its old interaction snapshot.
    viewState = { isStale: false, isFetching: false, isError: false };
    status.tasks = [{ ...task, workerEpoch: 'replacement-worker' }];
    tree = render();
    const staleApproval = node(tree, 'Pressable', 'allow');
    assert.ok(staleApproval); assert.equal(staleApproval.props.disabled, true, 'expired worker approval must be disabled');
    press(tree, '← Tasks');
    status.tasks = [{ ...task, workerEpoch: '', status: 'lost' }];
    tree = render();
    assert.match(text(tree), /worker no longer available/);
    assert.equal(walk(tree).some(item => item.type === 'Pressable' && item.props.accessibilityLabel.startsWith('Helper')), false);
    assert.equal(calls.filter(call => call.name === 'foreground_tasks_control').length, 6, 'no background auto-approval or duplicate mutation occurred');
  } finally { cleanup(); resetMount(); }
});
