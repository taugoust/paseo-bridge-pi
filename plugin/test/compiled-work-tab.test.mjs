import assert from 'node:assert/strict';
import test from 'node:test';
import { treeAttemptKey } from '../shared/subagent-tree.ts';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compilerPath, 'Set PASEO_PLUGIN_COMPILER to the installed Paseo compiler; this integration must not silently skip');
// Resolve schema/runtime dependencies from the real host compiler installation,
// not undeclared bridge-local packages. Missing host dependencies must fail.
const require = createRequire(resolve(compilerPath));
const nativePresentation = await import(pathToFileURL(require.resolve('@getpaseo/server/pi-tool-presentation')));
const nativeDisplay = await import(pathToFileURL(require.resolve('@getpaseo/protocol/tool-call-display')));
const nativeToolLabel = (name, input, result) => {
  const detail = nativePresentation.mapPiToolCallDetail(nativePresentation.parseToolArgs(name, input), nativePresentation.parseToolResult(result));
  const display = nativeDisplay.buildToolCallDisplayModel({ name, detail, status: 'completed', error: null });
  return `Tool ${display.displayName}${display.summary ? ` · ${display.summary}` : ''} · completed`;
};
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)];
// Nested native syntax Text tokens concatenate exactly as RN/DOM text nodes do.
const compactText = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(compactText).join('') : compactText(node?.props?.children ?? []);
const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : node?.props?.testID === 'work-code-line' ? compactText(node) : node?.type === 'SettingsAction' ? text([node.props.label, node.props.hint, node.props.actionLabel, node.props.children]) : text(node?.props?.children ?? []);

// A small host renderer: execute compiled components, keep hook identity by JSX
// key/path, and run real effect setup/cleanup on mount/unmount. No Work logic is
// reproduced here; navigation and RPC are observed host boundaries.
function renderer() {
  let active, cursor;
  const instances = new Map();
  const componentProps = new Map();
  let seen;
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in active.slots)) active.slots[i] = typeof initial === 'function' ? initial() : initial;
      const owner = active;
      return [owner.slots[i], value => { owner.slots[i] = typeof value === 'function' ? value(owner.slots[i]) : value; }];
    },
    useRef(initial) { const [ref] = hooks.useState(() => ({ current: initial })); return ref; },
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    useEffect(fn, deps) {
      const i = cursor++;
      const previous = active.effects[i];
      if (!previous || !deps || deps.some((value, index) => value !== previous.deps[index])) {
        previous?.cleanup?.();
        active.effects[i] = { deps, cleanup: fn() };
      }
    },
  };
  const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
  function visit(node, path) {
    if (Array.isArray(node)) return node.map((child, i) => visit(child, `${path}/${child?.key ?? i}`));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      path += `/${node.type.name}:${node.key ?? ''}`;
      seen.add(path);
      componentProps.set(node.type.name, node.props);
      if (!instances.has(path)) instances.set(path, { slots: [], effects: [] });
      active = instances.get(path); cursor = 0;
      return visit(node.type(node.props), path);
    }
    return { ...node, props: { ...node.props, children: visit(node.props.children, `${path}/children`) } };
  }
  function unmount() { for (const instance of instances.values()) instance.effects.forEach(effect => effect.cleanup?.()); instances.clear(); }
  return { hooks, jsx, unmount, componentProps, render(Component, props) {
    seen = new Set();
    const tree = visit(jsx(Component, props), 'root');
    for (const [path, instance] of instances) if (!seen.has(path)) {
      instance.effects.forEach(effect => effect.cleanup?.()); instances.delete(path);
    }
    return tree;
  } };
}

test('compiled Work uses one workspace tab, source-scoped persistent UI, and UI-only close', async t => {
  const previousRAF = globalThis.requestAnimationFrame, previousCancelRAF = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {};
  t.after(() => { if (previousRAF) globalThis.requestAnimationFrame = previousRAF; else delete globalThis.requestAnimationFrame; if (previousCancelRAF) globalThis.cancelAnimationFrame = previousCancelRAF; else delete globalThis.cancelAnimationFrame; });
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { clientBundle } = await compilePlugin({ client: fileURLToPath(new URL('../index.client.tsx', import.meta.url)) });
  const { defineSettings } = await import(pathToFileURL(require.resolve('@getpaseo/plugin')));
  const ui = renderer();
  const calls = [], queries = [];
  let settings = { status: 'loading' };
  let settingsContract;
  let rpcResponse = async () => ({ available: false });
  let workAgents;
  let hierarchyMessage;
  let workJobs = [], foregroundJobs = [];
  let conversationError = false;
  let messages = [{ id: 'm1', role: 'assistant', text: 'Worker transcript evidence' }];
  let statusError = false;
  const pillUpdates = [];
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: contract => contract, defineSettings };
    if (name === '@getpaseo/plugin/client') return { useSettings: contract => { settingsContract = contract; return settings; }, useRpc: contract => async input => { calls.push({ name: contract.name, input }); return {}; } };
    if (name === '@getpaseo/plugin/client/ui') return { SettingsAction: 'SettingsAction', SettingsSection: 'SettingsSection', SettingsRow: 'SettingsRow', SettingsToggle: 'SettingsToggle' };
    if (name === '@getpaseo/plugin/client/react-native') return { ScrollView: 'ScrollView', Icon: 'Icon', TextInput: 'TextInput' };
    if (name === 'react-native') return { ActivityIndicator: 'ActivityIndicator', View: 'View', Text: 'Text', Pressable: 'Pressable',
      Animated: { Value: class { interpolate() { return 'rotation'; } }, View: 'AnimatedView' },
      Easing: { linear: value => value },
      AccessibilityInfo: { isReduceMotionEnabled: async () => true, addEventListener: () => ({ remove() {} }) },
    };
    if (name === 'react/jsx-runtime') return { jsx: ui.jsx, jsxs: ui.jsx, Fragment: 'Fragment' };
    if (name === 'react') return { Fragment: 'Fragment', ...ui.hooks, useLayoutEffect: ui.hooks.useEffect, createElement: (type, props, ...children) => ui.jsx(type, { ...props, ...(children.length ? { children } : {}) }, props?.key) };
    if (name === '@tanstack/react-query') return { useQuery(options) {
      queries.push(options);
      const key = options.queryKey;
      const data = workAgents === undefined ? (key[0] === 'harness-status' ? { available: false } : undefined)
        : key[0] === 'harness-status' ? { available: true, sessionId: 's', runtimeEpoch: 'e' }
        : key[0] === 'harness-list' ? { state: 'available', items: key[1] === 'subagents' ? workAgents : workJobs, ...(key[1] === 'subagents' ? { hierarchyMessage } : {}) }
        : key[0] === 'harness-detail' ? { state: 'available', item: { text: 'Owned grandchild job output', truncated: false } }
        : key[0] === 'foreground-tasks' ? { available: true, tasks: foregroundJobs }
        : key[0] === 'worker-conversation' ? { state: 'available', item: { messages, nextCursor: 2, execution: 'running', liveText: 'Streaming assistant delta', liveEvents: [{ sequence: 3, kind: 'tool_end', toolCallId: 'call-1', name: 'bash', status: 'completed', arguments: { command: 'git status --short', private: 'ARGUMENT_SECRET' }, result: 'LIVE_RESULT_SECRET' }] } }
        : undefined;
      return { data, isPending: false, isError: (key[0] === 'worker-conversation' && conversationError) || (key[0] === 'harness-status' && statusError), refetch() {} };
    }, useMutation() { return { isPending: false, mutate() { throw Error('Unexpected mutation'); } }; } };
    return require(name);
  };
  const contribute = (0, eval)(clientBundle)(load).default;
  function host() {
    const observers = [], pills = [], panels = [], opened = [], screens = [];
    const cleanup = contribute({
      paseo: { config: { get: async () => ({ config: { plugins: { 'paseo-accounts': { enabled: true } } } }) }, agents: { list: async options => ({ subscription: { subscribe: observer => { observer.includeBackground = options?.includeBackground === true; observers.push(observer); } } }) } },
      addScreen: () => () => {}, openScreen: value => screens.push(value),
      addWorkspacePanel: panel => { panels.push(panel); return () => {}; },
      addHeaderButton: () => ({ update() {}, remove() {} }),
      addComposerPill: pill => { const registration = { ...pill, update(value) { pillUpdates.push(value); }, remove() { this.removed = true; } }; pills.push(registration); return registration; },
      openPanel: (id, options) => opened.push({ id, options }),
      rpc: async (contract, input) => { calls.push({ name: contract.name, input }); return rpcResponse(contract, input); },
    });
    return { observers, pills, panels, opened, screens, cleanup };
  }
  const first = host(), second = host();
  await new Promise(resolve => setImmediate(resolve));
  const agents = ['a', 'b'].map(id => ({ id, title: `Conversation ${id.toUpperCase()}`, workspaceId: 'w', provider: 'pi' }));
  const snapshot = host => host.observers.forEach(observer => observer.snapshot({ entries: agents.map(agent => ({ agent })) }));
  snapshot(first); snapshot(second);
  const pill = (host, id) => host.pills.find(pill => pill.id === 'work' && pill.agentId === id && !pill.removed);
  const click = (host, id) => { assert.equal(pill(host, id).button.behavior.kind, 'action'); pill(host, id).button.behavior.onPress(); };
  const panel = host => { const work = host.panels.filter(panel => panel.id === 'work'); assert.equal(work.length, 1); assert.equal(work[0].context, 'workspace'); assert.deepEqual(work[0].locations, ['workspace']); return work[0].Component; };
  const props = { context: 'workspace', workspaceId: 'w', host: { id: 'host' }, theme: { colors: { foreground: '#fff', foregroundMuted: '#aaa', surface0: '#111', surface1: '#222', surface2: '#333', border: '#444', statusSuccess: '#0f0', statusWarning: '#fa0', statusDanger: '#f00' } }, layout: { platform: 'web', compact: false } };
  const render = (host = first, overrides = {}) => { queries.length = 0; return ui.render(panel(host), { ...props, ...overrides }); };
  const select = (tree, section) => { const tab = nodes(tree).find(node => node.props?.accessibilityRole === 'tab' && node.props.children?.props?.children === section); assert.ok(tab, section); tab.props.onPress(); };
  const selected = tree => nodes(tree).find(node => node.props?.accessibilityRole === 'tab' && node.props.accessibilityState.selected)?.props.children.props.children;
  const scroll = tree => nodes(tree).find(node => node.type === 'ScrollView');
  try {
    const icon = pill(first, 'a').button.icon;
    const iconProps = { ...props, context: 'agent', agentId: 'a', size: 16, color: '#fff' };
    workAgents = [
      { taskId: 'running', status: 'running', reaped: false },
      ...Array.from({ length: 4 }, (_, i) => ({ taskId: `idle-${i}`, status: 'completed', reaped: false })),
      { taskId: 'reaped', status: 'completed', reaped: true },
    ];
    let indicator = ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, '1 working', 'spinner counts only running agents, not four retained idle agents');
    assert.ok(!nodes(indicator).some(n => n.props?.accessibilityLabel === 'Idle agents'));
    workAgents[0].status = 'completed';
    indicator = ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, 'Work', 'idle agents do not advertise execution');
    assert.ok(!nodes(indicator).some(n => n.props?.accessibilityLabel === 'Idle agents'));
    workJobs = [{ id: 'job-running', status: 'running' }, { id: 'job-done', status: 'completed' }];
    indicator = ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, '1 job', 'running job outranks five idle subagents');
    workJobs.push({ jobId: 'grandchild-indicator', status: 'running', fromSubagent: true });
    ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, '2 jobs', 'verified descendant jobs count in the same top-level indicator');
    workJobs.pop();
    assert.ok(!nodes(indicator).some(n => n.props?.accessibilityLabel === 'Idle agents'));
    foregroundJobs = [{ taskId: 'foreground-running', status: 'running' }];
    ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, '2 jobs', 'running foreground work is included');
    workAgents[0].status = 'pending';
    workAgents[1].status = 'starting';
    ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, '2 working', 'running subagents outrank running jobs');
    workAgents[0].status = 'completed';
    workAgents[1].status = 'completed';
    workJobs = []; foregroundJobs = [];
    indicator = ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, 'Work', 'idle agents stay unobtrusive after jobs finish');
    assert.ok(!nodes(indicator).some(n => n.props?.accessibilityLabel === 'Idle agents'));
    workAgents = [];
    ui.render(icon, iconProps);
    assert.equal(pillUpdates.at(-1).label, 'Work');
    workAgents = undefined;
    ui.unmount();
    assert.match(text(render()), /Select Work/);
    assert.equal(queries.length, 0, 'unbound native tab never queries an arbitrary agent');
    click(first, 'a'); click(first, 'a'); click(first, 'b');
    assert.deepEqual(first.opened, Array(3).fill({ id: 'work', options: { workspaceId: 'w', location: 'workspace' } }), 'native workspace identity never contains an agent id');
    let tree = render();
    assert.equal(queries.filter(query => query.queryKey[0] === 'harness-status').at(-1).queryKey[1], 'b');
    const tabNodes = nodes(tree).filter(node => node.props?.accessibilityRole === 'tab');
    assert.equal(tabNodes.length, 4, 'Work retains four native sections at narrow width');
    assert.ok(tabNodes.every(node => (typeof node.props.style === 'function' ? node.props.style({pressed:false}) : node.props.style)?.minHeight >= 44), 'tabs retain accessible touch targets at narrow widths');
    assert.ok(tabNodes.some(node => node.props.accessibilityState?.selected && (typeof node.props.style === 'function' ? node.props.style({pressed:false}) : node.props.style)?.borderBottomWidth === 2), 'selected section has native underline feedback');
    select(tree, 'Jobs'); tree = render();
    const jobsAction = nodes(tree).find(node => node.type === 'SettingsAction' && node.props.actionLabel === 'Completed');
    assert.ok(jobsAction, 'Jobs uses the host SettingsAction via shared WorkAction');
    assert.equal(jobsAction.props.style, undefined, 'Jobs action has no custom button styling');
    workAgents = [];
    workJobs = [
      { jobId: 'job-grandchild', name: 'Grandchild fixture', status: 'running', createdAt: '2026-01-01', updatedAt: null, observationOnly: false, fromSubagent: true },
      { jobId: 'job-direct', name: 'Direct fixture', status: 'running', createdAt: '2026-01-01', updatedAt: null, observationOnly: false },
      { jobId: 'job-child', name: 'Child fixture', status: 'running', createdAt: '2026-01-01', updatedAt: null, observationOnly: true, fromSubagent: true },
    ];
    tree = render();
    assert.equal(nodes(tree).filter(node => node.props?.accessibilityRole === 'header' && node.props.children === 'From subagents').length, 1);
    assert.ok(text(tree).indexOf('Direct fixture') < text(tree).indexOf('From subagents'), 'direct jobs retain their first section');
    assert.ok(text(tree).indexOf('Grandchild fixture') > text(tree).indexOf('From subagents'));
    const grandchild = nodes(tree).find(node => node.type === 'Pressable' && node.props.accessibilityLabel?.startsWith('Grandchild fixture'));
    assert.ok(grandchild, 'same existing job row is used'); grandchild.props.onPress(); tree = render();
    assert.match(text(tree), /Owned grandchild job output/);
    assert.equal(nodes(tree).find(node => node.type === 'Text' && node.props.children === 'Owned grandchild job output').props.style.fontFamily, 'monospace');
    assert.ok(!nodes(tree).some(node => /cancel|signal|reap/i.test(node.props?.accessibilityLabel ?? '')), 'jobs remain read-only');
    workJobs = [];
    workAgents = undefined;
    scroll(tree).props.onScroll({ nativeEvent: { contentOffset: { y: 321 } } });
    tree = render();
    assert.equal(scroll(tree).props.contentOffset.y, 321, 'status/query rerenders must not reset a mounted scroll position');
    click(first, 'a'); tree = render();
    assert.equal(selected(tree), 'Goals', 'new source does not inherit another source section');
    assert.equal(queries.filter(query => query.queryKey[0] === 'harness-status').at(-1).queryKey[1], 'a');
    select(tree, 'Agents'); tree = render();
    const agentsAction = nodes(tree).find(node => node.type === 'SettingsAction' && node.props.actionLabel === 'Completed');
    assert.ok(agentsAction, 'Agents uses the host SettingsAction via shared WorkAction');
    assert.equal(agentsAction.type, jobsAction.type);
    assert.deepEqual(Object.keys(agentsAction.props).sort(), Object.keys(jobsAction.props).sort());
    assert.equal(agentsAction.props.style, undefined);
    workAgents = [
      ...Array.from({ length: 5 }, (_, i) => ({ taskId: `task-${i}`, childId: `child-${i}`, title: `Worker ${i}`, status: i < 3 ? 'completed' : 'running', reaped: false, attempt: 1, runtimeId: `runtime-${i}` })),
      { taskId: 'old-task', childId: 'old-child', title: 'Old worker', status: 'completed', reaped: true, attempt: 1, runtimeId: null },
    ];
    tree = render();
    const rows = tree => nodes(tree).filter(n => n.type === 'Pressable' && /^(Worker \d|Old worker|Helper|Urgent|Renamed native child|URGENT[^·]*) ·/.test(n.props?.accessibilityLabel ?? ''));
    const completedRows = tree => nodes(tree).filter(n => n.type === 'SettingsAction' && /^(Worker \d|Old worker|Helper|Urgent|Renamed native child|URGENT)/.test(n.props?.label ?? ''));
    assert.equal(rows(tree).length, 5);
    {
      const originalRows = workAgents;
      const source = { agentId: 'nested-owner', workspaceId: 'nested-workspace', sessionId: 'nested-session', runtimeEpoch: 'nested-epoch' };
      const parent = { ...originalRows[0], reaped: true };
      const child = { ...originalRows[3], title: 'Worker 6', source, parentKey: treeAttemptKey(parent) };
      hierarchyMessage = 'Some descendant inventories are unavailable (stale evidence or read limits). Descendants of exited or unverifiable agents are unavailable; historical ancestry is not inferred.';
      workAgents = [child, parent]; tree = render();
      assert.doesNotMatch(text(tree), /Some descendant inventories are unavailable/);
      assert.doesNotMatch(text(tree), /historical ancestry is not inferred/);
      assert.doesNotMatch(text(tree), /Conversation A/, 'Work does not repeat the conversation title above its tabs');
      const ancestor = nodes(tree).find(n => n.props?.accessibilityLabel === 'Agent hierarchy level 1');
      assert.equal(ancestor.props.style.borderWidth, undefined, 'idle ancestor in active tree uses existing active-row wrapper, not completed card');
      assert.ok(nodes(ancestor).some(n => n.props?.accessibilityLabel === 'Idle'), 'idle ancestor retains existing green idle indicator');
      assert.deepEqual(rows(tree).map(n => n.props.accessibilityLabel.split(' · ')[0]), ['Worker 0', 'Worker 6'], 'finished parent retained before active descendant');
      assert.deepEqual(nodes(tree).filter(n => /^Agent hierarchy level /.test(n.props?.accessibilityLabel ?? '')).map(n => [n.props.accessibilityLabel, n.props.style.marginLeft]), [['Agent hierarchy level 1', 0], ['Agent hierarchy level 2', 16]], 'narrow child retains common right edge without changing row padding');
      const hierarchy = nodes(tree).filter(n => /^Agent hierarchy level /.test(n.props?.accessibilityLabel ?? ''));
      hierarchy.forEach((node, index) => {
        node.props.onLayout({ nativeEvent: { layout: { x: index * 16, y: index * 200, width: 300, height: 60 } } });
        const inner = nodes(node).find(n => n.type === 'View' && n !== node && n.props.onLayout);
        assert.ok(inner, 'real compiled NativeRow exposes its measured leading anchor');
        inner.props.onLayout({ nativeEvent: { layout: { x: 12, y: 8, width: 276, height: 40 } } });
      });
      tree = render();
      const overlay = nodes(tree).find(n => n.props?.pointerEvents === 'none' && n.props?.importantForAccessibility === 'no-hide-descendants');
      assert.ok(overlay, 'compiled Agents render a noninteractive connector overlay');
      assert.deepEqual(nodes(overlay).filter(n => n !== overlay).map(n => [n.props.style.left, n.props.style.top, n.props.style.width, n.props.style.height]), [[18.5, 32, 1, 196], [19, 227.5, 9, 1]], 'measured parent/child status centers drive real compiled connector Views');
      rows(tree)[1].props.onPress(); tree = render();
      const nestedQuery = queries.find(q => q.queryKey[0] === 'worker-conversation');
      assert.ok(nestedQuery.queryKey.includes('nested-session') && nestedQuery.queryKey.includes('nested-epoch') && nestedQuery.queryKey.includes('nested-owner'), 'nested trace bound to actual parent session and epoch');
      rows(tree)[1].props.onPress();
      hierarchyMessage = undefined;
      workAgents = originalRows; tree = render();
    }
    const desktopStyle = Object.assign({}, ...rows(tree)[0].props.style({ pressed: false }));
    assert.equal(desktopStyle.gap, 6);
    assert.equal(desktopStyle.paddingHorizontal, 12);
    assert.equal(desktopStyle.paddingVertical, 8);
    assert.equal(desktopStyle.minHeight, 44);
    tree = render(first, { layout: { platform: 'web', compact: true } });
    assert.equal(Object.assign({}, ...rows(tree)[0].props.style({})).minHeight, 44);
    tree = render();
    assert.equal(nodes(tree).find(n => n.type === 'SettingsAction').props.label, '');
    assert.equal(rows(tree).filter(n => n.props.accessibilityLabel.includes('Idle')).length, 3);
    assert.ok(!text(tree).includes('Old worker'));
    assert.equal(first.screens.length, 0);
    assert.equal(calls.filter(c => c.name === 'independent_agent_open').length, 0);
    rows(tree)[0].props.onPress(); tree = render();
    assert.match(text(tree), /Worker transcript evidence/);
    assert.equal(rows(tree).length, 5, 'historical inline expansion retains the identical list');
    assert.equal(nodes(tree).filter(n => n.props?.testID === 'work-agent-detail').length, 0, 'no new detail screen');
    assert.ok(nodes(tree).some(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Open child chat'), 'historical chat button retained');
    const liveQuery = queries.find(q => q.queryKey[0] === 'worker-conversation');
    assert.equal(liveQuery.refetchInterval, 1200);
    assert.equal(liveQuery.refetchOnReconnect, true);
    assert.ok(!queries.some(q => q.queryKey[0] === 'harness-detail' && q.enabled), 'live log replaces final-report reads');
    // A retained older attempt must not keep the primary selection alive after resume.
    const originalAttempt = workAgents[0];
    const resumedAttempt = { ...originalAttempt, childId: 'resumed-child', attempt: 2, runtimeId: 'resumed-runtime', status: 'running' };
    workAgents.push(resumedAttempt);
    tree = render();
    assert.equal(nodes(tree).filter(n => n.props?.testID === 'work-agent-conversation').length, 0, 'superseded primary selection closes even while old attempt is retained');
    assert.doesNotMatch(text(tree), /Owned grandchild job output|Worker transcript evidence/, 'stale primary selection cannot display cached taskId-only report or trace');
    assert.ok(!queries.some(q => q.queryKey[0] === 'harness-detail' && q.enabled), 'superseded selection never enables fallback task report');
    assert.equal(rows(tree).length, 5, 'resumed attempt does not add a peer row');
    assert.doesNotMatch(text(tree), /Previous attempts/, 'collapsed primary row has no peer history control');
    rows(tree).find(n => n.props.accessibilityLabel.startsWith('Worker 0 ·')).props.onPress(); tree = render();
    assert.deepEqual(queries.find(q => q.queryKey[0] === 'worker-conversation').queryKey.slice(6, 10), ['task-0', 'resumed-child', 2, 'resumed-runtime'], 'explicit latest click binds resumed trace');
    assert.ok(text(tree).indexOf('Previous attempts (1)') > text(tree).indexOf('Open child chat'), 'history is at bottom after current trace and child chat action');
    nodes(tree).find(n => n.type === 'Pressable' && text(n).includes('Previous attempts (1)')).props.onPress(); tree = render();
    nodes(tree).find(n => n.type === 'Pressable' && text(n).includes('Attempt 1')).props.onPress(); tree = render();
    assert.deepEqual(queries.filter(q => q.queryKey[0] === 'worker-conversation').map(q => q.queryKey.slice(6, 10)), [
      ['task-0', 'resumed-child', 2, 'resumed-runtime'], ['task-0', 'child-0', 1, 'runtime-0'],
    ], 'history remains separately bound to retained original attempt');
    rows(tree).find(n => n.props.accessibilityLabel.startsWith('Worker 0 ·')).props.onPress(); tree = render();
    assert.doesNotMatch(text(tree), /Previous attempts|Attempt 1/, 'collapsing parent unmounts history');
    rows(tree).find(n => n.props.accessibilityLabel.startsWith('Worker 0 ·')).props.onPress(); tree = render();
    assert.match(text(tree), /Previous attempts/);
    assert.doesNotMatch(text(tree), /Attempt 1/, 'history resets collapsed when parent reopens');
    resumedAttempt.reaped = true;
    resumedAttempt.status = 'completed';
    tree = render();
    nodes(tree).find(n => n.type === 'SettingsAction' && n.props.actionLabel === 'Completed').props.onPress(); tree = render();
    const completedWithHistory = completedRows(tree).find(n => n.props.label === 'Worker 0');
    assert.ok(completedWithHistory, 'latest reaped task appears as a native completed action row');
    assert.equal(completedWithHistory.props.hint, 'Completed', 'preserve the existing execution label rather than introducing Finished or claiming delivered success');
    assert.equal(completedWithHistory.props.actionLabel, 'Details');
    completedWithHistory.props.onPress(); tree = render();
    assert.match(text(tree), /Previous attempts/);
    assert.ok(nodes(tree).some(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Open child chat'), 'completed task with history expands and preserves chat action');
    nodes(tree).find(n => n.type === 'Pressable' && text(n).includes('Previous attempts (1)')).props.onPress(); tree = render();
    nodes(tree).find(n => n.type === 'Pressable' && text(n).includes('Attempt 1')).props.onPress(); tree = render();
    assert.ok(queries.some(q => q.queryKey[0] === 'worker-conversation' && q.queryKey[7] === 'child-0' && q.queryKey[8] === 1), 'completed task historical trace remains reachable');
    const nextAttempt = { ...resumedAttempt, childId: 'third-child', attempt: 3, runtimeId: 'third-runtime', status: 'running', reaped: false };
    workAgents.push(nextAttempt); tree = render();
    assert.ok(!completedRows(tree).some(n => n.props.label === 'Worker 0'), 'latest active attempt removes its task from Completed');
    assert.equal(nodes(tree).filter(n => n.props?.testID === 'work-agent-conversation').length, 0, 'completed Details selection cannot survive an exact attempt change');
    assert.ok(!queries.some(q => q.queryKey[0] === 'worker-conversation'), 'superseded completed selection stops both current and historical polling');
    workAgents.pop();
    select(tree, 'Agents');
    workAgents.pop();
    tree = render();
    if (!nodes(tree).some(n => n.props?.testID === 'work-agent-conversation')) {
      rows(tree).find(n => n.props.accessibilityLabel.startsWith('Worker 0 ·')).props.onPress(); tree = render();
    }
    workAgents[0].status = 'running';
    messages = [...messages, { id: 'm2', role: 'tool', text: 'Live tool execution evidence' }];
    tree = render();
    assert.doesNotMatch(text(tree), /Live tool execution evidence/, 'tool output never leaks into the collapsed label');
    assert.ok(nodes(tree).some(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Tool Tool · unknown'), 'unmatched result remains an honest collapsed tool badge');
    assert.equal(nodes(tree).filter(n => n.props?.testID === 'work-agent-conversation').length, 1);
    assert.ok(nodes(tree).some(n => n.type === 'ScrollView' && n.props.style?.maxHeight === 320), 'bounded native timeline retained');
    assert.match(text(tree), /Streaming assistant delta/);
    assert.ok(nodes(tree).some(n => n.props.accessibilityLabel === 'Assistant is working'), 'native loader appears only from authoritative running state');
    assert.doesNotMatch(text(tree), /Working…|retained snapshot/i);
    messages = [
      { id: 'call-row', role: 'assistant', text: 'Checking **the current state** with `git`.', parts: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'git status --short', private: 'ARGUMENT_SECRET' }, status: 'completed', result: 'RESULT_SECRET' }] },
      { id: 'result-row', role: 'tool', toolCallId: 'call-1', toolName: 'bash', status: 'completed', text: 'RESULT_SECRET' },
      { id: 'markdown-row', role: 'assistant', text: '# Summary\n\nA **formatted** paragraph with `inline code`.\n\n- one list item\n\n3. First numbered item.\n4. Second numbered item.' },
      { id: 'parent-row', role: 'parent', text: 'Please **review** this request. Use notify_parent then task_outcome; preserve _one_two_ as emphasis.' },
    ];
    tree = render();
    const timeline = nodes(tree).find(n => n.type === 'ScrollView' && n.props.style?.maxHeight === 320);
    assert.equal(timeline.props.contentContainerStyle.gap ?? 0, 0, 'timeline does not insert gaps for invisible correlated result rows');
    assert.ok(!nodes(tree).some(n => n.key === 'result-row'), 'correlated tool results have no empty layout wrapper');
    assert.ok(nodes(tree).filter(n => n.type === 'View' && n.props.style?.marginHorizontal === -13).every(n => !n.props.style.marginBottom), 'collapsed tool badges have no extra inter-row margin');
    assert.match(text(tree), /git status --short/, 'badge uses the compact native command summary');
    assert.match(text(tree), /formatted/, 'assistant prose is rendered through the Markdown adapter');
    assert.ok(nodes(tree).some(n => n.props?.testID === 'transcript-markdown'));
    assert.ok(nodes(tree).some(n => n.type === 'p' && n.props.style.fontSize === 15 && n.props.style.lineHeight === '21px'), 'body matches native content typography');
    assert.ok(nodes(tree).some(n => n.type === 'h1' && n.props.style.fontSize === 24 && n.props.style.lineHeight === '31px'), 'heading follows native content scale');
    assert.ok(nodes(tree).some(n => n.type === 'code' && n.props.style.fontSize === 12), 'inline code matches native code size');
    assert.ok(nodes(tree).some(n => n.type === 'strong'), 'web markdown keeps strong semantics');
    assert.match(text(tree), /notify_parent then task_outcome/, 'native/CommonMark intraword underscores preserve literal tool identifiers');
    assert.ok(nodes(tree).some(n => n.type === 'em' && text(n).includes('one_two')), 'underscore emphasis still works around identifiers');
    assert.ok(nodes(tree).some(n => n.type === 'code'), 'web markdown keeps inline code semantics');
    assert.ok(nodes(tree).some(n => n.type === 'ul' && nodes(n).some(child => child.type === 'li')), 'web markdown keeps list semantics');
    const orderedList = nodes(tree).find(n => n.type === 'ol');
    assert.equal(orderedList?.props.start, 3, 'numbered lists preserve their starting ordinal rather than becoming bullets');
    const orderedItems = nodes(orderedList).filter(n => n.type === 'li');
    assert.equal(orderedItems.length, 2, 'consecutive numbered items share one native-spaced list block');
    assert.deepEqual(orderedItems.map(n => n.props.style.marginBottom), [4, 0], 'native list item spacing is4px, with no extra per-item block gap');
    assert.ok(nodes(tree).some(n => n.type === 'View' && n.props.style?.alignSelf === 'flex-end'), 'parent input uses the native user-message bubble treatment');
    assert.equal(nodes(tree).filter(n => n.type === 'Text' && n.props.children === 'parent').length, 0, 'no separate parent role label');
    assert.doesNotMatch(text(tree), /ARGUMENT_SECRET|RESULT_SECRET|LIVE_RESULT_SECRET/, 'correlated tool results and full arguments stay inside the collapsed badge');
    const toolBadge = nodes(tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Tool Shell · git status --short · completed');
    assert.ok(toolBadge, 'badge uses native icon/name/summary presentation');
    assert.equal(toolBadge.props.accessibilityState.expanded, false, 'tool details start collapsed');
    assert.equal(nodes(toolBadge).filter(n => n.type === 'Icon').length, 1, 'native collapsed badges have one leading icon, no trailing check/chevron clutter');
    assert.ok(nodes(toolBadge).some(n => n.type === 'Icon' && n.props.name === 'SquareTerminal' && n.props.size === 12));
    let automaticScrolls = 0;
    timeline.props.ref.current = { scrollToEnd() { automaticScrolls++; } };
    toolBadge.props.onPress(); tree = render();
    nodes(tree).find(n => n.type === 'ScrollView' && n.props.style?.maxHeight === 320).props.onContentSizeChange();
    assert.equal(automaticScrolls, 0, 'expanding earlier tool details preserves the reading anchor instead of snapping to the live tail');
    timeline.props.ref.current = null;
    assert.doesNotMatch(text(tree), /ARGUMENT_SECRET/, 'native Bash schema omits unsupported private argument fields even when expanded');
    assert.match(text(tree), /git status --short/, 'supported native command remains visible when expanded');
    assert.match(text(tree), /LIVE_RESULT_SECRET/, 'newer live completion overlays the persisted call and reveals its result only on click');
    assert.doesNotMatch(text(tree), /"result": "RESULT_SECRET"/, 'stale persisted result is superseded by the latest correlated live result');
    assert.ok(nodes(tree).some(n => n.type === 'Icon' && n.props.name === 'ChevronDown'), 'expanded badge replaces its leading tool icon with the native disclosure');
    const previousMessages = messages;
    const jsonFile = '{"content":[1,2],"title":"literal file"}';
    const typedJobArguments = { action: 'start', command: 'echo typed', name: 'Typed job' };
    const typedJobResult = { content: [{ type: 'text', text: 'job-111111111111111111111111  Running  0s  Typed job\ncwd: /fixture\ncommand: echo typed\nStarted in a new tmux pane.' }], details: { job_id: 'job-111111111111111111111111', name: 'Typed job', status: 'running', action: 'start' } };
    const literalJsonResult = '{"content":[{"type":"text","text":"must remain literal JSON"}]}';
    messages = [
      { id: 'shell-fixture', role: 'assistant', text: '', parts: [{ type: 'toolCall', id: 'shell-fixture-call', name: 'bash', arguments: { command: 'printf actual-shell-json' }, status: 'completed', result: JSON.stringify({ content: [{ type: 'text', text: '{"content":[1,2],"shell_stdout":true}' }], details: {}, structuredContent: { output: '{"content":[1,2],"shell_stdout":true}', exit_code: 0 } }) }] },
      { id: 'unknown-fixture', role: 'assistant', text: '', parts: [{ type: 'toolCall', id: 'unknown-fixture-call', name: 'custom_tool', arguments: { query: 'unknown-tool-query' }, status: 'completed', result: JSON.stringify({ type: 'tool_result', content: JSON.stringify({ content: [{ type: 'text', text: 'unknown tool readable output' }] }) }) }] },
      { id: 'read-fixture', role: 'assistant', text: '', parts: [{ type: 'toolCall', id: 'read-fixture-call', name: 'read', arguments: { path: '/tmp/actual.json', offset: 7, limit: 20 }, status: 'completed', result: JSON.stringify(JSON.stringify({ content: [{ type: 'text', text: jsonFile }], structuredContent: jsonFile })) }] },
      { id: 'typed-job-fixture', role: 'assistant', text: '', parts: [{ type: 'toolCall', id: 'typed-job-call', name: 'background_job', arguments: typedJobArguments, status: 'completed', result: 'TYPED_JOB_RAW_FALLBACK', resultFormat: 'text', toolPresentation: { version: 1, toolName: 'background_job', result: typedJobResult } }] },
      { id: 'literal-fixture', role: 'assistant', text: '', parts: [{ type: 'toolCall', id: 'literal-call', name: 'custom_tool', arguments: { action: 'literal' }, status: 'completed', result: literalJsonResult, resultFormat: 'text' }] },
      { id: 'write-fixture', role: 'assistant', text: '', parts: [{ type: 'toolCall', id: 'write-fixture-call', name: 'write', arguments: { path: '/tmp/written.ts', content: 'export const written = "exact content";\n' }, status: 'completed', result: 'Written successfully' }] },
      { id: 'edit-fixture', role: 'assistant', text: '', parts: [{ type: 'toolCall', id: 'edit-fixture-call', name: 'edit', arguments: { path: '/tmp/edited.ts', edits: [{ oldText: 'old exact fragment', newText: 'new exact fragment' }] }, status: 'completed', result: 'Edited successfully' }] },
    ];
    tree = render();
    assert.doesNotMatch(text(tree), /literal file|exact content|old exact fragment/, 'all representative details remain collapsed');
    for (const label of ['Tool Shell · printf actual-shell-json · completed', 'Tool Custom tool · completed', 'Tool Read · /tmp/actual.json · completed', 'Tool Write · /tmp/written.ts · completed', 'Tool Edit · /tmp/edited.ts · completed', nativeToolLabel('background_job', typedJobArguments, typedJobResult), nativeToolLabel('custom_tool', { action: 'literal' }, { content: [{ type: 'text', text: literalJsonResult }] })]) {
      nodes(tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === label).props.onPress();
      tree = render();
    }
    assert.ok(text(tree).includes('{"content":[1,2],"shell_stdout":true}'), 'shell JSON stdout remains literal content');
    assert.match(text(tree), /unknown tool readable output/, 'legacy unknown transport retains readable output through the native fallback');
    assert.match(text(tree), /Running · 0s/, 'validated typed job details use native lifecycle presentation');
    assert.doesNotMatch(text(tree), /TYPED_JOB_RAW_FALLBACK|Started in a new tmux pane/, 'typed projection is not replaced by the older flattened transport text');
    assert.ok(text(tree).includes(literalJsonResult), 'unknown literal JSON payload is terminal text, not reinterpreted as another transport');
    assert.ok(text(tree).includes(jsonFile), 'double-stringified MCP result shows exact JSON file text, not its transport envelope');
    assert.match(text(tree), /export const written = "exact content";/);
    assert.deepEqual(nodes(tree).filter(n => n.props?.testID === 'work-code-line-number').map(n => text(n)), ['7'], 'only Read content gets absolute positions, using its authoritative offset');
    assert.ok(nodes(tree).filter(n => n.props?.testID === 'work-native-code-surface').length >= 4, 'native shell/file details use bounded code surfaces');
    assert.ok(nodes(tree).some(n => n.props?.testID === 'work-native-tool-section'), 'native unknown-tool fallback uses prose rather than a fabricated code surface');
    assert.match(text(tree), /− old exact fragment/);
    assert.match(text(tree), /\+ new exact fragment/);
    assert.doesNotMatch(text(tree), /structuredContent|\\\\"content\\\\"|@@/, 'no duplicated transport, escaped envelope, or fabricated diff positions');
    messages = previousMessages;
    tree = render();
    nodes(tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Older messages').props.onPress(); tree = render();
    assert.equal(queries.find(q => q.queryKey[0] === 'worker-conversation').queryKey.at(-1), 2);
    workAgents[0].status = 'completed'; tree = render();
    assert.equal(queries.find(q => q.queryKey[0] === 'worker-conversation').queryKey.at(-1), 2, 'settlement does not reset history pagination');
    nodes(tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Latest messages').props.onPress(); tree = render();
    assert.equal(queries.find(q => q.queryKey[0] === 'worker-conversation').queryKey.at(-1), undefined);
    assert.equal(calls.filter(c => c.name === 'independent_agent_open').length, 0, 'row click only reads transcript');
    workAgents[0].status = 'completed';
    rows(tree)[0].props.onPress(); tree = render();
    assert.equal(rows(tree).length, 5);
    assert.doesNotMatch(text(tree), /Worker transcript evidence/);
    assert.ok(!queries.some(q => q.queryKey[0] === 'worker-conversation'), 'collapse stops transcript polling');
    rows(tree)[0].props.onPress(); tree = render();
    conversationError = true; tree = render();
    assert.match(text(tree), /Conversation unavailable/);
    assert.doesNotMatch(text(tree), /Worker transcript evidence/, 'errors do not present stale transcript');
    conversationError = false;
    statusError = true; tree = render();
    assert.doesNotMatch(text(tree), /Worker transcript evidence/, 'unavailable source hides retained detail');
    assert.equal(rows(tree).length, 0);
    statusError = false; tree = render();
    nodes(tree).find(n => n.type === 'SettingsAction' && n.props.actionLabel === 'Completed').props.onPress();
    tree = render();
    assert.equal(completedRows(tree).length, 1);
    assert.match(text(tree), /Old worker/);
    assert.equal(completedRows(tree)[0].props.hint, 'Completed');
    assert.equal(completedRows(tree)[0].props.style, undefined, 'completed rows use native SettingsAction geometry without a custom card');
    rpcResponse = async contract => contract.name === 'harness_status'
      ? { available: true, sessionId: 's', runtimeEpoch: 'e' } : { agentId: 'history-child' };
    completedRows(tree)[0].props.onPress();
    await new Promise(resolve => setImmediate(resolve));
    tree = render();
    assert.doesNotMatch(text(tree), /Worker transcript evidence/, 'completed click retains historical direct-chat behavior');
    assert.equal(first.screens.length, 0, 'missing historical runtime never creates a replacement conversation');
    assert.equal(calls.filter(c => c.name === 'independent_agent_open').length, 0);
    calls.length = 0; first.screens.length = 0;
    select(tree, 'Agents');
    workAgents = undefined;
    click(first, 'b'); tree = render();
    assert.equal(selected(tree), 'Jobs'); assert.equal(scroll(tree).props.contentOffset.y, 321);
    const beforeClose = calls.length;
    ui.unmount(); tree = render();
    assert.equal(selected(tree), 'Jobs'); assert.equal(scroll(tree).props.contentOffset.y, 321);
    const restored = [];
    const scroller = scroll(tree).props;
    scroller.ref.current = { scrollTo: options => restored.push(options) };
    scroller.onLayout({ nativeEvent: { layout: { height: 500 } } });
    scroller.onContentSizeChange(800, 100);
    scroller.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
    assert.equal(restored.length, 0, 'loading placeholder cannot accommodate the saved offset');
    scroller.onContentSizeChange(800, 2000);
    assert.deepEqual(restored, [{ y: 321, animated: false }], 'restore after asynchronous content hydrates');
    assert.equal(calls.length, beforeClose, 'unmount/remount has no cancel/reap/stop RPC');
    ui.unmount(); tree = render();
    const userRestores = [];
    const userScroller = scroll(tree).props;
    userScroller.ref.current = { scrollTo: options => userRestores.push(options) };
    userScroller.onLayout({ nativeEvent: { layout: { height: 500 } } });
    userScroller.onContentSizeChange(800, 100);
    userScroller.onScroll({ nativeEvent: { contentOffset: { y: 0 } } });
    userScroller.onScrollBeginDrag();
    userScroller.onScroll({ nativeEvent: { contentOffset: { y: 57 } } });
    userScroller.onContentSizeChange(800, 2000);
    assert.deepEqual(userRestores, [], 'intentional user scrolling cancels pending restoration');
    ui.unmount(); tree = render();
    assert.equal(scroll(tree).props.contentOffset.y, 57, 'user position replaces the old restoration target');
    ui.unmount();
    assert.match(text(render(second)), /Select Work/, 'client/host selection is isolated');
    ui.unmount();
    assert.match(text(render(first, { workspaceId: 'elsewhere' })), /Select Work/);
    assert.equal(queries.length, 0);
    tree = render();
    assert.ok(queries.filter(query => query.queryKey[0] === 'harness-status').every(query => query.queryKey.includes('b') && query.queryKey.includes('w')));
    first.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: { ...agents[1], workspaceId: 'new-workspace' } } }));
    assert.match(text(render()), /Select Work/, 'moving source invalidates old workspace binding');
    assert.equal(queries.length, 0);
    click(first, 'a'); render();
    const target = { hostId: 'host', agentId: 'a', workspaceId: 'w', sessionId: 'session', runtimeEpoch: 'epoch', taskId: 'task', childId: 'child', groupId: 'group', attempt: 1, runtimeId: 'runtime', title: 'Helper' };
    let releaseIdentity;
    rpcResponse = () => new Promise(resolve => { releaseIdentity = resolve; });
    const pendingOpen = ui.componentProps.get('WorkOverview').openConversation(target);
    const rejected = assert.rejects(pendingOpen, /no longer selected/);
    first.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'a' } }));
    releaseIdentity({ available: true, sessionId: 'session', runtimeEpoch: 'epoch' });
    await rejected;
    assert.equal(calls.filter(call => call.name === 'independent_agent_open').length, 0, 'stale source cannot create a child conversation after identity lookup');
    assert.equal(first.screens.length, 0);
    first.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: agents[0] } }));
    click(first, 'a'); render();
    first.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: { ...agents[0], archivedAt: 'now' } } }));
    assert.match(text(render()), /Select Work/, 'archiving source invalidates binding');
    assert.equal(queries.length, 0);
    first.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: agents[0] } }));
    click(first, 'a'); tree = render();
    assert.equal(selected(tree), 'Goals', 'reappearing source starts with fresh UI state');
    rpcResponse = async contract => contract.name === 'harness_status'
      ? { available: true, sessionId: 'session', runtimeEpoch: 'epoch' }
      : { agentId: 'real-child-agent' };
    workAgents = [{ taskId: 'task', childId: 'child', title: 'Helper', status: 'completed', reaped: false, attempt: 1, runtimeId: 'runtime' }];
    messages = [{ id: 'm1', role: 'assistant', text: 'Worker transcript evidence' }];
    rpcResponse = async contract => contract.name === 'harness_status'
      ? { available: true, sessionId: 's', runtimeEpoch: 'e' }
      : { agentId: 'real-child-agent' };
    tree = render(); select(tree, 'Agents'); tree = render();
    rows(tree)[0].props.onPress(); tree = render();
    const continuation = () => nodes(tree).find(n => n.type === 'Pressable' && n.props.accessibilityLabel === 'Open child chat');
    for (const status of ['pending', 'launching', 'starting', 'running', 'waiting', 'lost']) {
      workAgents[0].status = status; tree = render();
      assert.match(text(tree), /Worker transcript evidence/, `${status} transcript remains viewable`);
      assert.equal(continuation().props.disabled, false, status);
    }
    for (const status of ['failed', 'cancelled', 'completed']) {
      workAgents[0].status = status; tree = render();
      assert.equal(continuation().props.disabled, false, `${status} checkpoint can be checked by server`);
    }
    workAgents[0].needsAttention = true; tree = render();
    assert.equal(continuation().props.disabled, false, 'opening a copy does not answer the unresolved interaction');
    workAgents[0].status = 'running'; tree = render();
    const continueButton = continuation();
    assert.ok(continueButton, 'interactive continuation is explicit in the rendered conversation');
    continueButton.props.onPress();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.filter(c => c.name === 'independent_agent_open').length, 0, 'Open child chat must never create a snapshot chat');
    assert.equal(calls.filter(c => c.name === 'harness_subagent_route').length, 2, 'stale click and current click each resolve only an existing route');
    assert.deepEqual(first.screens.at(-1), { screenId: 'independent-conversation', params: { agentId: 'real-child-agent' } }, 'existing verified conversation helper owns native conversation navigation');
    ui.componentProps.get('WorkOverview').openWorkspace('native-workspace');
    assert.deepEqual(first.screens.at(-1), { screenId: 'independent-conversation', params: { workspaceId: 'native-workspace', serverId: 'host' } });
    first.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'a' } }));
    assert.match(text(render()), /Select Work/, 'removed source invalidates binding');
    assert.equal(queries.length, 0);
    assert.equal(first.screens.length, 2, 'only explicit user navigation opens the native navigation screen');
    assert.ok(calls.every(call => !/cancel|stop|reap|close/.test(call.name)));

    // Full refresh: contribution, subscriptions and hook state are all recreated.
    // Only the host's supported settings document survives.
    ui.unmount();
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const persisted = { hostId: 'host', workspaceId: 'w', agentId: 'a', sessionId: 's' };
    settings = {
      status: 'ready', values: { sources: [] }, revision: '0',
      async save(values, revision) {
        assert.equal(revision, this.revision);
        this.values = settingsContract.schema.parse(values);
        this.revision = String(Number(this.revision) + 1);
        return true;
      },
      async reload() {},
    };
    const writer = host(); await tick(); snapshot(writer);
    click(writer, 'a'); render(writer); await tick();
    assert.equal(settingsContract.id, 'work-source');
    assert.equal(settingsContract.scope, 'host');
    assert.deepEqual(settings.values.sources, [persisted]);
    ui.unmount(); writer.cleanup();
    assert.deepEqual(settings.values.sources, [persisted], 'teardown does not erase restoration hints');
    for (const scenario of ['valid', 'removed', 'archived', 'wrong-workspace', 'wrong-provider', 'dormant', 'stale-host', 'stale-session']) {
      settings.values = { sources: [{ ...persisted, ...(scenario === 'stale-host' ? { hostId: 'old-host' } : {}) }] };
      const cold = host(); await tick();
      try {
        render(cold); await tick();
        assert.match(text(render(cold)), /Select Work/, 'wait for subscription hydration');
        assert.deepEqual(settings.values.sources[0].agentId, 'a', 'delayed snapshot does not discard saved hint');
        const source = { ...agents[0],
          ...(scenario === 'archived' ? { archivedAt: 'now' } : {}),
          ...(scenario === 'wrong-workspace' ? { workspaceId: 'other' } : {}),
          ...(scenario === 'wrong-provider' ? { provider: 'other' } : {}),
          ...(scenario === 'dormant' ? { runtimeInfo: { extra: { independentDormant: true } } } : {}),
        };
        rpcResponse = async () => ({ available: true, sessionId: scenario === 'stale-session' ? 'replacement' : 's', runtimeEpoch: 'reconnected' });
        cold.observers.forEach(observer => observer.snapshot({ entries: (scenario === 'removed' ? [agents[1]] : [source, agents[1]]).map(agent => ({ agent })) }));
        render(cold); await tick();
        const restoredTree = render(cold);
        if (scenario === 'valid') {
          assert.equal(queries.filter(query => query.queryKey[0] === 'harness-status').at(-1).queryKey[1], 'a');
          settings.values = { sources: [{ ...persisted, agentId: 'b' }] };
          render(cold); await tick();
          render(cold); assert.equal(queries.filter(query => query.queryKey[0] === 'harness-status').at(-1).queryKey[1], 'a', 'another client cannot live-switch an active source');
          ui.unmount();
          render(cold); assert.equal(queries.filter(query => query.queryKey[0] === 'harness-status').at(-1).queryKey[1], 'a', 'UI-only close preserves local source');
          cold.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'a' } }));
          assert.match(text(render(cold)), /Select Work/);
        } else {
          assert.match(text(restoredTree), /Select Work/, scenario);
          assert.equal(queries.length, 0, 'invalid hint never queries another agent');
          settings.values = { sources: [{ ...persisted, agentId: 'b' }] };
          render(cold); await tick();
          assert.match(text(render(cold)), /Select Work/, 'invalid hint cannot fall through to a later unrelated hint');
        }
      } finally { ui.unmount(); cold.cleanup(); }
    }
    // Settings themselves can arrive after the inventory; do not claim an
    // empty/default preference before the supported hook reports ready.
    const readySettings = settings;
    settings = { status: 'loading' };
    const delayedSettings = host(); await tick(); snapshot(delayedSettings);
    assert.match(text(render(delayedSettings)), /Select Work/);
    settings = readySettings; settings.values = { sources: [persisted] };
    rpcResponse = async () => ({ available: true, sessionId: 's', runtimeEpoch: 'e' });
    render(delayedSettings); await tick();
    render(delayedSettings); assert.equal(queries.filter(query => query.queryKey[0] === 'harness-status').at(-1).queryKey[1], 'a');
    ui.unmount(); delayedSettings.cleanup();

    // Removal while validating identity must not restore a now-invalid source.
    const removedPending = host(); await tick(); snapshot(removedPending);
    let releaseRemoved;
    rpcResponse = () => new Promise(resolve => { releaseRemoved = resolve; });
    render(removedPending);
    removedPending.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'a' } }));
    releaseRemoved({ available: true, sessionId: 's', runtimeEpoch: 'e' });
    await tick();
    assert.match(text(render(removedPending)), /Select Work/);
    ui.unmount(); removedPending.cleanup();

    // Reconnect can hydrate the inventory before the Pi session is available.
    // Retain the precise hint while offline and retry, without choosing B.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    settings.values = { sources: [persisted] };
    const reconnecting = host(); await tick(); snapshot(reconnecting);
    rpcResponse = async () => ({ available: false });
    render(reconnecting); await tick();
    assert.match(text(render(reconnecting)), /Select Work/);
    rpcResponse = async () => ({ available: true, sessionId: 's', runtimeEpoch: 'new-epoch' });
    t.mock.timers.tick(5000); await tick();
    render(reconnecting); assert.equal(queries.filter(query => query.queryKey[0] === 'harness-status').at(-1).queryKey[1], 'a');
    ui.unmount(); reconnecting.cleanup();
    t.mock.timers.reset();

    // An explicit click wins even when a saved source's identity RPC is in flight.
    settings.values = { sources: [persisted] };
    const racing = host(); await tick(); snapshot(racing);
    let releaseRestore;
    rpcResponse = () => new Promise(resolve => { releaseRestore = resolve; });
    render(racing);
    click(racing, 'b');
    releaseRestore({ available: true, sessionId: 's', runtimeEpoch: 'e' });
    await tick();
    rpcResponse = async () => ({ available: true, sessionId: 'b-session', runtimeEpoch: 'e' });
    render(racing); assert.equal(queries.filter(query => query.queryKey[0] === 'harness-status').at(-1).queryKey[1], 'b');
    await tick();
    assert.equal(settings.values.sources[0].agentId, 'b');
    ui.unmount(); racing.cleanup();

    settings.values = { sources: [persisted] };
    const removedExplicit = host(); await tick(); snapshot(removedExplicit);
    rpcResponse = () => new Promise(resolve => { releaseRestore = resolve; });
    render(removedExplicit);
    click(removedExplicit, 'b');
    removedExplicit.observers.forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'remove', agentId: 'b' } }));
    releaseRestore({ available: true, sessionId: 's', runtimeEpoch: 'e' });
    await tick();
    assert.match(text(render(removedExplicit)), /Select Work/, 'removal of an explicitly selected source cannot revive an older pending restore');
    ui.unmount(); removedExplicit.cleanup();

    // Work titles reuse the exact verified child route and native catalog, not task text.
    settings.values = { sources: [] };
    rpcResponse = async () => ({ available: true, sessionId: 's', runtimeEpoch: 'e' });
    const titledHost = host(); t.after(() => titledHost.cleanup()); await tick(); snapshot(titledHost);
    const nativeChild = { id: 'native-child', workspaceId: 'child-workspace', provider: 'pi', title: 'Urgent' };
    const updateChild = agent => titledHost.observers.filter(observer => observer.includeBackground).forEach(observer => observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent } }));
    updateChild(nativeChild);
    const expectedBackgroundPills = ['pi-btw', 'work'];
    const actualBackgroundPills = titledHost.pills.filter(pill => pill.agentId === nativeChild.id && !pill.removed && expectedBackgroundPills.includes(pill.id));
    assert.deepEqual(actualBackgroundPills.map(pill => pill.id).sort(), expectedBackgroundPills, 'current/new background Pi chats get exactly one bridge-owned Work and BTW control');
    assert.ok(!titledHost.pills.some(pill => pill.id === 'pi-codex-account' && !pill.removed), 'account composer ownership stays with the companion');
    assert.ok(actualBackgroundPills.every(pill => pill.workspaceId === nativeChild.workspaceId), 'composer controls target the exact background chat workspace');
    workAgents = [{ taskId: 'title-task', childId: 'title-child', groupId: 'title-group', attempt: 1, runtimeId: 'title-runtime', status: 'running', title: 'URGENT original instructions remain in expanded metadata', paseoAgentId: nativeChild.id, paseoWorkspaceId: nativeChild.workspaceId }];
    click(titledHost, 'a'); tree = render(titledHost); select(tree, 'Agents'); tree = render(titledHost);
    assert.ok(rows(tree).length, `Native title row missing: ${text(tree)}`);
    assert.match(rows(tree)[0].props.accessibilityLabel, /^Urgent/);
    assert.doesNotMatch(rows(tree)[0].props.accessibilityLabel, /original instructions/);
    rows(tree)[0].props.onPress(); tree = render(titledHost);
    assert.match(text(tree), /Task:\s+URGENT original instructions remain in expanded metadata/);
    for (const status of ['lost', 'failed']) {
      workAgents = [{ ...workAgents[0], status }]; tree = render(titledHost);
      const state = status[0].toUpperCase() + status.slice(1);
      assert.ok(nodes(tree).some(node => node.type === 'View' && node.props.accessibilityLabel === state && node.props.style?.backgroundColor === '#f00'), `${state} uses the native danger indicator`);
      assert.ok(nodes(tree).some(node => node.type === 'Text' && text(node) === state && [node.props.style].flat().some(style => style?.color === '#f00')), `${state} text uses native danger color`);
    }
    workAgents = [{ ...workAgents[0], status: 'completed' }]; tree = render(titledHost);
    assert.ok(nodes(tree).some(node => node.type === 'View' && node.props.accessibilityLabel === 'Idle' && node.props.style?.backgroundColor === '#0f0'), 'healthy idle agents retain their success indicator');
    updateChild({ ...nativeChild, title: 'Renamed native child' }); tree = render(titledHost);
    assert.match(rows(tree)[0].props.accessibilityLabel, /^Renamed native child/);
    assert.ok(!nodes(tree).some(node => node.type === 'Text' && node.props.accessibilityRole === 'header' && text(node) === 'Renamed native child'), 'expanded trace does not repeat the agent row title');
    assert.equal(nodes(tree).filter(node => node.props?.testID === 'work-agent-conversation').length, 1, 'removing the redundant heading preserves the trace');
    updateChild({ ...nativeChild, workspaceId: 'unrelated-workspace', title: 'Unrelated private title' }); tree = render(titledHost);
    assert.doesNotMatch(rows(tree)[0].props.accessibilityLabel, /Unrelated private title/);
    assert.match(rows(tree)[0].props.accessibilityLabel, /^URGENT/);
    ui.unmount(); titledHost.cleanup();
  } finally { ui.unmount(); first.cleanup(); second.cleanup(); }
});
