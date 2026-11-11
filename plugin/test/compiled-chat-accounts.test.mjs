import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compiler = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compiler, 'PASEO_PLUGIN_COMPILER is required');
const require = createRequire(resolve(compiler));
const root = await mkdtemp(resolve(tmpdir(), 'chat-account-controls-'));
after(() => rm(root, { recursive: true, force: true }));
for (const dir of ['client', 'shared']) await cp(fileURLToPath(new URL(`../${dir}`, import.meta.url)), resolve(root, dir), { recursive: true });
// The real host compiler permits imports only below client/server/shared.
// Relocate the production contribution, adjusting only its relative imports.
const bridgeEntry = await readFile(new URL('../index.client.tsx', import.meta.url), 'utf8');
await writeFile(resolve(root, 'client/bridge-contribution.tsx'), bridgeEntry.replaceAll('from "./client/', 'from "./'));
await writeFile(resolve(root, 'index.client.tsx'), 'export { default as contributeBridge } from "./client/bridge-contribution"; export { contributeAccountControls, contributeChatAccountControls } from "./client/account-controls"; export { contributeHarness } from "./client/harness"; export { contributeBtw } from "./client/btw";');
const { compilePlugin } = await import(pathToFileURL(resolve(compiler)));
const { clientBundle } = await compilePlugin({ client: resolve(root, 'index.client.tsx') });
const flush = () => new Promise(resolve => setImmediate(resolve));

test('retired workspace contribution never reads config, observes agents or registers UI', async () => {
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: x => x, defineSettings: x => x };
    if (['react', 'react/jsx-runtime', 'react-native', '@getpaseo/plugin/client', '@getpaseo/plugin/client/ui', '@getpaseo/plugin/client/react-native', '@tanstack/react-query'].includes(name)) return {};
    return require(name);
  };
  const { contributeAccountControls } = (0, eval)(clientBundle)(load);
  for (const config of [{}, { plugins: { 'paseo-accounts': { enabled: false } } }, { plugins: { 'paseo-accounts': { enabled: true } } }, { plugins: null }, null]) {
    let reads = 0;
    const forbidden = () => { throw Error('retired workspace controls must not register or subscribe'); };
    const client = { paseo: { config: { get() { reads++; return config === null ? Promise.reject(Error('unavailable')) : Promise.resolve({ config }); } }, agents: { list: forbidden } }, addHeaderButton: forbidden, addComposerPill: forbidden };
    const stop = contributeAccountControls(client);
    await flush(); stop(); stop();
    assert.equal(reads, 0, 'even missing, disabled or unavailable paseo-accounts config is irrelevant');
  }
});

test('actual composer contribution targets each exact chat, includes background children and rejects context substitution', async () => {
  let observer, options;
  const registrations = [], requests = [], states = [];
  let hook = 0;
  const snapshot = { protocol: 1, serviceEpoch: 'service', selectionRevision: 1, sessionId: 'child-session', providerId: 'openai-codex', accounts: [{ id: 'Work', label: 'Work', authKind: 'oauth' }], currentAccountId: null, defaultSelected: true, busy: false, canSwitch: true, inheritance: 'inherited', usage: { effectiveCredential: 'unknown', settingsUrl: null } };
  let statusResult = { available: false, sessionId: null, runtimeEpoch: null, snapshot: null };
  const nodes = x => Array.isArray(x) ? x.flatMap(nodes) : !x || typeof x !== 'object' ? [] : [x, ...nodes(x.props?.children)];
  const text = x => Array.isArray(x) ? x.map(text).join('') : typeof x === 'string' ? x : x && typeof x === 'object' ? text(x.props?.children) : '';
  const jsx = (type, props) => typeof type === 'function' ? type(props ?? {}) : { type, props: props ?? {} };
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: x => x, defineSettings: x => x };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'react') return { useEffect() {}, useState(initial) { const i = hook++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; } };
    if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable' };
    if (name === '@getpaseo/plugin/client/ui') return { SettingsSection: 'Section', SettingsCard: 'Card', SettingsSelect: 'Select' };
    if (name === '@getpaseo/plugin/client/react-native') return { ScrollView: 'ScrollView' };
    if (name === '@getpaseo/plugin/client') return { useRpc: contract => async input => { requests.push({ name: contract.name, input }); return contract.name === 'account_controls_status' ? statusResult : { ok: true, requestId: input.request.requestId, snapshot }; } };
    if (name === '@tanstack/react-query') return { useQuery: value => { void value.queryFn(); return { data: statusResult, isPending: !statusResult.available, isFetching: false, isError: false, refetch: async () => ({ data: await value.queryFn(), isError: false }) }; } };
    return require(name);
  };
  const { contributeChatAccountControls } = (0, eval)(clientBundle)(load);
  const client = { paseo: { agents: { list: async input => { options = input; return { subscription: { subscribe: value => { observer = value; } } }; } } }, addComposerPill(input) { const item = { input, removed: false, remove() { this.removed = true; } }; registrations.push(item); return item; } };
  const stop = contributeChatAccountControls(client);
  try {
    await flush();
    assert.equal(options.includeBackground, true);
    const parent = { id: 'parent', provider: 'pi', workspaceId: 'workspace' };
    const child = { ...parent, id: 'child', visibility: 'background' };
    observer.snapshot({ entries: [{ agent: parent }, { agent: child }] });
    assert.deepEqual(registrations.map(r => r.input.agentId), ['parent', 'child']);
    assert.ok(registrations.every(r => r.input.id === 'pi-codex-account'));
    const Content = registrations[1].input.button.behavior.Content;
    const props = { context: 'agent', agentId: 'child', workspaceId: 'workspace', host: { id: 'host' }, theme: { colors: {} } };
    hook = 0; Content(props); await flush();
    assert.deepEqual(requests, [{ name: 'account_controls_status', input: { agentId: 'child', workspaceId: 'workspace', providerId: 'openai-codex' } }]);
    Content({ ...props, agentId: 'parent' }); Content({ ...props, workspaceId: 'other' }); Content({ ...props, context: 'workspace' });
    assert.equal(requests.length, 1, 'substituted popover contexts cannot even query another chat');
    statusResult = { available: true, sessionId: 'child-session', runtimeEpoch: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', snapshot };
    const draw = () => { hook = 0; return nodes(Content(props)); };
    draw(); await flush();
    let all = draw();
    const press = (label) => { const row = all.find(n => n.type === 'Pressable' && text(n) === label); assert.ok(row, `missing ${label}`); assert.ok(!row.props.disabled); row.props.onPress(); };
    snapshot.currentAccountId = 'Work'; snapshot.defaultSelected = false; all = draw();
    press('Work'); all = draw(); press('Confirm switch'); await flush(); await flush();
    assert.equal(requests.filter(r => r.name === 'account_controls_switch').at(-1).input.request.accountId, 'Work', 'same inherited account can be frozen as a local explicit override');
    snapshot.currentAccountId = null; snapshot.defaultSelected = true; all = draw();
    press('Use Pi built-in login'); all = draw(); press('Confirm switch'); await flush(); await flush();
    const explicit = requests.filter(r => r.name === 'account_controls_switch').at(-1).input;
    assert.equal(explicit.agentId, 'child'); assert.equal(explicit.workspaceId, 'workspace');
    assert.equal(explicit.expectedSessionId, 'child-session');
    assert.equal(explicit.expectedRuntimeEpoch, statusResult.runtimeEpoch);
    assert.equal(explicit.request.expectedServiceEpoch, 'service');
    assert.equal(explicit.request.expectedSelectionRevision, 1);
    assert.equal(explicit.request.expectedSessionId, 'child-session'); assert.equal(explicit.request.providerId, 'openai-codex');
    assert.equal(explicit.request.accountId, null); assert.equal(explicit.request.inherit, undefined, 'built-in login is explicit, not clear');
    snapshot.inheritance = 'explicit'; all = draw(); press('Follow parent account'); all = draw(); press('Confirm switch'); await flush(); await flush();
    const clear = requests.filter(r => r.name === 'account_controls_switch').at(-1).input;
    assert.equal(clear.agentId, 'child'); assert.equal(clear.request.inherit, true); assert.equal(clear.request.accountId, null);
    const named = r =>
      r.name === 'account_controls_status' ? r.input.providerId : r.input.request.providerId;
    assert.ok(requests.length > 1 && requests.every(r => named(r) === 'openai-codex'),
      'every account request names openai-codex');
    observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: { ...child, workspaceId: 'new-workspace' } } });
    assert.equal(registrations[1].removed, true);
    assert.equal(registrations[2].input.workspaceId, 'new-workspace');
    const beforeStale = requests.length;
    Content(props);
    assert.equal(requests.length, beforeStale, 'detached popover cannot query its previous chat/workspace');
    assert.equal(child.visibility, 'background', 'registration never promotes background chats');
  } finally { stop(); }
  assert.equal(options.signal.aborted, true);
  assert.ok(registrations.every(r => r.removed));
});

test('Work and BTW register current and newly observed background Pi children without promotion', async () => {
  const observers = [], pills = [];
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: x => x, defineSettings: x => x };
    if (['react', 'react/jsx-runtime', 'react-native', '@getpaseo/plugin/client', '@getpaseo/plugin/client/ui', '@getpaseo/plugin/client/react-native', '@tanstack/react-query'].includes(name)) return {};
    return require(name);
  };
  const { contributeHarness, contributeBtw } = (0, eval)(clientBundle)(load);
  const client = {
    paseo: { agents: { list: async options => ({ subscription: { subscribe: observer => observers.push({ options, observer }) } }) } },
    rpc: async () => ({}), addScreen: () => () => {}, addWorkspacePanel: () => () => {}, openPanel() {},
    addComposerPill(input) { const pill = { ...input, removed: false, update() {}, remove() { this.removed = true; } }; pills.push(pill); return pill; },
  };
  const stopWork = contributeHarness(client), stopBtw = contributeBtw(client);
  try {
    await flush();
    const current = Object.freeze({ id: 'current-background-child', workspaceId: 'workspace', provider: 'pi', visibility: 'background' });
    for (const { options, observer } of observers) observer.snapshot({ entries: options.includeBackground ? [{ agent: current }] : [] });
    assert.deepEqual(pills.filter(p => p.agentId === current.id).map(p => p.id).sort(), ['pi-btw', 'work']);
    const future = Object.freeze({ ...current, id: 'new-background-child' });
    for (const { options, observer } of observers) if (options.includeBackground) observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: future } });
    assert.deepEqual(pills.filter(p => p.agentId === future.id).map(p => p.id).sort(), ['pi-btw', 'work']);
    assert.equal(current.visibility, 'background'); assert.equal(future.visibility, 'background');
  } finally { stopBtw(); stopWork(); }
  assert.ok(pills.every(p => p.removed));
  assert.ok(observers.every(({ options }) => options.signal.aborted));
});

test('shared controls keep exactly one registration through overlapping contributions, reconnect, rename, eligibility and remount', async () => {
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: x => x, defineSettings: x => x };
    if (['react', 'react/jsx-runtime', 'react-native', '@getpaseo/plugin/client', '@getpaseo/plugin/client/ui', '@getpaseo/plugin/client/react-native', '@tanstack/react-query'].includes(name)) return {};
    return require(name);
  };
  const { contributeHarness, contributeBtw, contributeChatAccountControls } = (0, eval)(clientBundle)(load);
  const contributions = [contributeHarness, contributeBtw, contributeChatAccountControls];
  function host() {
    const observers = [], pills = [], panels = [], options = [], opened = [];
    const client = {
      paseo: { agents: { list: async input => { options.push(input); return { subscription: { subscribe: value => observers.push(value) } }; } } },
      rpc: async () => ({}), addScreen: () => () => {},
      addWorkspacePanel: input => { const panel = { ...input, removed: false }; panels.push(panel); return () => { panel.removed = true; }; },
      openPanel: (...args) => opened.push(args),
      addComposerPill(input) {
        assert.ok(!pills.some(p => !p.removed && p.id === input.id && p.agentId === input.agentId && p.workspaceId === input.workspaceId), 'host rejects duplicate registrations');
        const pill = { ...input, removed: false, update() { assert.ok(!this.removed); }, remove() { assert.ok(!this.removed); this.removed = true; } };
        pills.push(pill); return pill;
      },
    };
    const live = id => pills.filter(p => !p.removed && p.agentId === id);
    return { client, observers, pills, panels, options, opened, live };
  }
  const h = host(), other = host();
  const first = contributions.map(fn => fn(h.client)), second = contributions.map(fn => fn(h.client));
  const isolated = contributions.map(fn => fn(other.client));
  const stops = [...first, ...second, ...isolated];
  try {
    await flush();
    assert.equal(h.observers.length, 1, 'Work titles, Work, BTW and accounts consume one catalogue');
    assert.equal(other.observers.length, 1, 'different hosts/installations are not deduplicated together');
    const source = h.observers[0];
    const main = Object.freeze({ id: 'main', provider: 'pi', workspaceId: 'workspace', title: 'Main' });
    const child = Object.freeze({ ...main, id: 'child', visibility: 'background' });
    const future = Object.freeze({ ...child, id: 'future-child' });
    const expected = ['pi-btw', 'pi-codex-account', 'work'];
    const ids = id => h.live(id).map(p => p.id).sort();
    const snapshot = agents => source.snapshot({ entries: agents.map(agent => ({ agent })) });
    const upsert = agent => source.update({ type: 'agent_update', payload: { kind: 'upsert', agent } });
    snapshot([main, child]);
    other.observers[0].snapshot({ entries: [{ agent: main }] });
    assert.deepEqual(ids(main.id), expected); assert.deepEqual(ids(child.id), expected);
    const retained = h.live(child.id);
    for (let i = 0; i < 5; i++) { snapshot([main, child]); upsert({ ...child, title: `Rename ${i}` }); }
    assert.deepEqual(h.live(child.id), retained, 'rename/reconnect does not replace buttons or lose BTW state');
    upsert(future); assert.deepEqual(ids(future.id), expected);
    first.forEach(stop => { stop(); stop(); });
    assert.deepEqual(ids(child.id), expected, 'one owner releasing cannot remove the remaining owner controls');
    assert.equal(h.options[0].signal.aborted, false);
    const oldWork = h.live(child.id).find(p => p.id === 'work');
    upsert({ ...child, workspaceId: 'moved' });
    assert.ok(retained.every(p => p.removed));
    assert.ok(h.live(child.id).every(p => p.workspaceId === 'moved'));
    oldWork.button.behavior.onPress(); assert.equal(h.opened.length, 0, 'stale Work actions cannot target the new workspace');
    h.live(child.id).find(p => p.id === 'work').button.behavior.onPress();
    assert.deepEqual(h.opened, [['work', { workspaceId: 'moved', location: 'workspace' }]]);
    for (const ineligible of [{ archivedAt: 'archived' }, { provider: 'codex' }, { workspaceId: null }, { runtimeInfo: { extra: { independentDormant: true } } }]) {
      upsert({ ...child, ...ineligible }); assert.deepEqual(ids(child.id), []);
      upsert(child); assert.deepEqual(ids(child.id), expected);
    }
    source.update({ type: 'agent_update', payload: { kind: 'remove', agentId: future.id } });
    assert.deepEqual(ids(future.id), []);
    snapshot([child]); assert.deepEqual(ids(main.id), []);
    second.forEach(stop => stop());
    assert.ok(h.pills.every(p => p.removed)); assert.ok(h.panels.every(p => p.removed));
    assert.equal(h.options[0].signal.aborted, true);
    assert.equal(other.options[0].signal.aborted, false);
    assert.equal(other.live(main.id).length, 3);
    snapshot([main, child]); upsert(future);
    assert.equal(h.pills.filter(p => !p.removed).length, 0, 'disposed callbacks cannot resurrect controls');
    const remount = contributions.map(fn => fn(h.client)); stops.push(...remount);
    await flush();
    h.observers[1].snapshot({ entries: [{ agent: child }] });
    assert.deepEqual(ids(child.id), expected);
    assert.equal(child.visibility, 'background'); assert.equal(future.visibility, 'background');
  } finally { stops.reverse().forEach(stop => stop()); }
});

test('disposing before subscription bootstrap prevents late registration; a fresh contribution works', async () => {
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: x => x, defineSettings: x => x };
    if (['react', 'react/jsx-runtime', 'react-native', '@getpaseo/plugin/client', '@getpaseo/plugin/client/ui', '@getpaseo/plugin/client/react-native', '@tanstack/react-query'].includes(name)) return {};
    return require(name);
  };
  const { contributeChatAccountControls } = (0, eval)(clientBundle)(load);
  const pending = [], options = [], pills = [];
  const client = {
    paseo: { agents: { list: input => { options.push(input); return new Promise(resolve => pending.push(resolve)); } } },
    addComposerPill: input => { pills.push(input); return { remove() {} }; },
  };
  const stop = contributeChatAccountControls(client); stop();
  let subscriptions = 0;
  pending[0]({ subscription: { subscribe() { subscriptions++; } } }); await flush();
  assert.equal(subscriptions, 0); assert.equal(options[0].signal.aborted, true);
  const remount = contributeChatAccountControls(client);
  try {
    pending[1]({ subscription: { subscribe(observer) {
      observer.snapshot({ entries: [{ agent: { id: 'new', provider: 'pi', workspaceId: 'workspace' } }] });
    } } });
    await flush(); assert.equal(pills.length, 1);
  } finally { remount(); }
});

test('full plugin contribution leaves the account pill to paseo-accounts and leases Work/BTW controls', async () => {
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: x => x, defineSettings: x => x };
    if (['react', 'react/jsx-runtime', 'react-native', '@getpaseo/plugin/client', '@getpaseo/plugin/client/ui', '@getpaseo/plugin/client/react-native', '@tanstack/react-query'].includes(name)) return {};
    return require(name);
  };
  const { contributeBridge } = (0, eval)(clientBundle)(load);
  const observers = [], pills = [], panels = [];
  let configCalls = 0;
  const client = {
    paseo: { config: { get: () => { configCalls++; throw Error('bridge must not read paseo-accounts configuration'); } },
      agents: { list: async input => ({ subscription: { subscribe: observer => observers.push({ input, observer }) } }) } },
    rpc: async () => ({}), addScreen: () => () => {},
    addWorkspacePanel: input => { const panel = { ...input, removed: false }; panels.push(panel); return () => { panel.removed = true; }; },
    addHeaderButton: () => { throw Error('late config must not register legacy controls'); },
    addComposerPill: input => { const pill = { ...input, removed: false, update() {}, remove() { this.removed = true; } }; pills.push(pill); return pill; },
  };
  const a = contributeBridge(client), b = contributeBridge(client);
  try {
    await flush();
    assert.equal(configCalls, 0);
    const agent = { id: 'main', provider: 'pi', workspaceId: 'workspace', availableModes: [{ id: 'full-access' }, { id: 'dangerous-ask' }] };
    for (const { observer } of observers) observer.snapshot({ entries: [{ agent }] });
    assert.deepEqual(pills.filter(p => ['work', 'pi-btw', 'pi-codex-account'].includes(p.id)).map(p => p.id).sort(), ['pi-btw', 'work']);
    assert.equal(pills.some(p => p.id === 'pi-codex-account'), false, 'bridge must not compete with the paseo-accounts control');
    assert.equal(panels.filter(p => p.id === 'work').length, 1);
    a(); a(); assert.ok(pills.some(p => !p.removed));
    b(); assert.ok(pills.every(p => p.removed)); assert.ok(panels.every(p => p.removed));
    assert.ok(observers.every(({ input }) => input.signal.aborted));
    await flush();
    assert.ok(pills.every(p => p.removed));
  } finally { a(); b(); }
});
