import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const flush = () => new Promise(resolve => setImmediate(resolve));

test('compiled contribution preserves Pi pills, isolates installations and ignores late results', { skip: !compilerPath }, async () => {
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { clientBundle } = await compilePlugin({ client: resolve(root, 'index.client.tsx') });
  const load = (name) => {
    if (name === '@getpaseo/plugin') return { defineRpc: contract => contract };
    if (['@getpaseo/plugin/client', '@getpaseo/plugin/client/react-native', '@tanstack/react-query', 'react', 'react/jsx-runtime'].includes(name)) return {};
    return require(name);
  };
  const contribute = (0, eval)(clientBundle)(load).default;
  const fixtures = [];
  function fixture() {
    let observer;
    let signal;
    const registrations = [];
    const calls = [];
    const client = {
      paseo: { agents: { list: async options => {
        signal = options.signal;
        return { subscription: { subscribe: value => { observer = value; } } };
      } } },
      rpc: (contract, input) => new Promise(resolve => calls.push({ contract, input, resolve })),
      addComposerPill: input => {
        const registration = { input, updates: [], removed: false,
          update(patch) { assert.equal(this.removed, false); this.updates.push(patch); },
          remove() { this.removed = true; } };
        registrations.push(registration);
        return registration;
      },
    };
    const cleanup = contribute(client);
    const result = { registrations, calls, cleanup, get observer() { return observer; }, get signal() { return signal; } };
    fixtures.push(result);
    return result;
  }
  const pi = { id: 'same-agent', workspaceId: 'workspace', provider: 'pi', archivedAt: null };
  const good = { available: true, enabled: true, sessionId: 'session', runtimeEpoch: 'epoch', reason: null };
  try {
    const a = fixture();
    const b = fixture();
    await flush();
    a.observer.snapshot({ entries: [{ agent: pi }, { agent: { ...pi, id: 'claude', provider: 'claude' } }, { agent: { ...pi, id: 'archived', archivedAt: 'date' } }] });
    b.observer.snapshot({ entries: [{ agent: pi }] });
    assert.equal(a.registrations.length, 1);
    assert.equal(b.registrations.length, 1);
    assert.equal(a.calls.length, 1);
    assert.equal(a.calls[0].contract.name, 'permission_gate_status');
    a.calls[0].resolve(good);
    b.calls[0].resolve({ ...good, enabled: false });
    await flush();
    assert.match(a.registrations[0].updates.at(-1).label, /On/);
    assert.match(b.registrations[0].updates.at(-1).label, /Off/);
    a.observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: { ...pi, title: 'Streaming' } } });
    assert.equal(a.registrations.length, 1, 'ordinary updates must not rebuild the pill');
    a.observer.update({ type: 'agent_update', payload: { kind: 'upsert', agent: { ...pi, workspaceId: null } } });
    assert.equal(a.registrations[0].removed, true);
    assert.equal(b.registrations[0].removed, false, 'installations must have separate registrations');
    a.observer.snapshot({ entries: [{ agent: pi }] });
    const pending = a.calls.at(-1);
    const last = a.registrations.at(-1);
    a.cleanup();
    pending.resolve(good);
    await flush();
    assert.equal(last.updates.length, 0, 'late result after cleanup must not update the UI');
    assert.equal(a.signal.aborted, true);
    assert.equal(b.registrations[0].removed, false);
  } finally {
    for (const fixture of fixtures) fixture.cleanup();
  }
});
