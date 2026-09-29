import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

test('compiled popover uses actual host export boundaries and renders every status branch', { skip: !compilerPath }, async () => {
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { clientBundle } = await compilePlugin({ client: resolve(root, 'index.client.tsx') });
  let query;
  const jsx = (type, props) => {
    assert.ok(typeof type === 'string' || typeof type === 'function', `Invalid JSX element type: ${String(type)}`);
    return typeof type === 'function' ? type(props) : { type, props };
  };
  const hostHelpers = Object.fromEntries(['Icon', 'Modal', 'ScrollView', 'FlatList', 'TextInput', 'copyText', 'useRevealedText', 'useToast'].map(name => [name, () => null]));
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: contract => contract };
    if (name === '@getpaseo/plugin/client') return { useRpc: () => async () => ({}) };
    // Paseo 0.10 packages/app/src/plugins/react-native/runtime.ts exports
    // helpers only. Core primitives come from its separate react-native module.
    if (name === '@getpaseo/plugin/client/react-native') return hostHelpers;
    if (name === 'react-native') return { View: 'View', Text: 'Text', Pressable: 'Pressable' };
    if (name === 'react') return { useEffect() {}, useState: initial => [initial, () => {}] };
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === '@tanstack/react-query') return { useQuery: () => query, useMutation: () => ({ isPending: false, mutate() {} }) };
    return require(name);
  };
  const contribute = (0, eval)(clientBundle)(load).default;
  let observer;
  let contribution;
  const cleanup = contribute({
    paseo: { agents: { list: async () => ({ subscription: { subscribe: value => { observer = value; } } }) } },
    rpc: async () => ({ available: false, enabled: null }),
    addComposerPill: value => { contribution = value; return { update() {}, remove() {} }; },
  });
  const nodes = element => !element || typeof element !== 'object' ? [] : [element, ...[element.props?.children].flat(Infinity).flatMap(nodes)];
  try {
    await new Promise(resolve => setImmediate(resolve));
    observer.snapshot({ entries: [{ agent: { id: 'agent', workspaceId: 'workspace', provider: 'pi' } }] });
    const Content = contribution.button.behavior.Content;
    for (const state of ['loading', 'unavailable', 'error', 'on', 'off']) {
      query = {
        data: state === 'loading' || state === 'error' ? undefined : {
          available: state !== 'unavailable', enabled: state === 'on', sessionId: 'session', runtimeEpoch: 'epoch', reason: 'Unavailable',
        },
        isPending: state === 'loading', isFetching: false, isStale: false, isError: state === 'error', refetch: async () => {},
      };
      const tree = Content({ context: 'agent', agentId: 'agent', workspaceId: 'workspace', theme: { colors: { foreground: '#fff', foregroundMuted: '#aaa', statusDanger: '#f00' } } });
      assert.equal(tree.type, 'View');
      const buttons = nodes(tree).filter(node => node.type === 'Pressable');
      assert.equal(buttons.length, 2);
      assert.equal(Boolean(buttons[0].props.disabled), state !== 'off');
      assert.equal(Boolean(buttons[1].props.disabled), state !== 'on');
    }
  } finally { cleanup(); }
});
