import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import net from 'node:net';
import { BridgeTransport } from '../../extension/bridge-transport.ts';
import { writePermissionGateOperatorDescriptor } from '../../extension/permission-gate-operator.js';

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

test('compiled plugin backend operates the real bridge without prompt dispatch or leaking capability', { skip: !compilerPath, timeout: 10000 }, async () => {
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { serverBundle } = await compilePlugin({ server: resolve(pluginRoot, 'index.server.ts') });
  const root = await mkdtemp(join(tmpdir(), 'gate-plugin-'));
  const transport = new BridgeTransport(join(root, 'session.jsonl'), join(root, 'bridge.sock'));
  let client;
  let enabled = true;
  let commandCalls = 0;
  const errors = [];
  const handlers = new Map();
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: contract => contract };
    if (name === 'node:os') return { ...require(name), homedir: () => root };
    return require(name);
  };
  const contribute = (0, eval)(serverBundle)(load).default;
  const cleanup = contribute({ handle: (contract, handler) => handlers.set(contract.name, { contract, handler }) });
  let descriptor;
  try {
    transport.bind({
      command: async () => { commandCalls++; }, attached() {}, detached() {}, error: error => errors.push(error),
      permissionGateOperator: () => ({ descriptor, authority: () => ({
        status: sessionId => ({ sessionId, enabled }),
        applyMode: (sessionId, next) => ({ sessionId, enabled: (enabled = next) }),
      }) }),
    });
    descriptor = { version: 1, socketPath: `${transport.pipePath}.operator`, capability: transport.operatorCapability,
      agentId: 'agent', sessionId: 'session', runtimeEpoch: transport.operatorEpoch };
    transport.start();
    client = net.connect(transport.pipePath);
    await once(client, 'connect');
    writePermissionGateOperatorDescriptor(join(root, '.pi', 'paseo-bridge'), descriptor);
    const context = { paseo: { agents: { ref: id => ({ refresh: async () => ({ agent: { id, workspaceId: 'workspace', provider: 'pi' } }) }) } } };
    const invoke = async (name, input) => {
      const { contract, handler } = handlers.get(name);
      return contract.output.parse(await handler(contract.input.parse(input), context));
    };
    const target = { agentId: 'agent', workspaceId: 'workspace' };
    const status = await invoke('permission_gate_status', target);
    assert.equal(status.available, true);
    assert.equal(status.enabled, true);
    assert.equal(JSON.stringify(status).includes(descriptor.capability), false);
    assert.equal('socketPath' in status, false);
    const set = { ...target, enabled: false, expectedSessionId: status.sessionId, expectedRuntimeEpoch: status.runtimeEpoch };
    assert.deepEqual(await invoke('permission_gate_set', set), { enabled: false });
    assert.equal(enabled, false);
    assert.equal(commandCalls, 0);
    assert.equal(transport.connected, true);
    await assert.rejects(invoke('permission_gate_set', { ...set, enabled: true, expectedRuntimeEpoch: 'stale' }), /changed/);
    await assert.rejects(invoke('permission_gate_set', { ...set, enabled: true, workspaceId: 'other' }), /workspace/);
    assert.equal(enabled, false);
    transport.suspend();
    assert.equal((await invoke('permission_gate_status', target)).available, false);
    await assert.rejects(invoke('permission_gate_set', { ...set, enabled: true }));
    assert.equal(enabled, false);
    assert.equal(commandCalls, 0);
    assert.deepEqual(errors, []);
  } finally {
    cleanup?.();
    client?.destroy();
    transport.close();
    await rm(root, { recursive: true, force: true });
  }
});
