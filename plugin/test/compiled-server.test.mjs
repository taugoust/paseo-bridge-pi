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
import { writePermissionGateOperatorDescriptor, writeHarnessReadOnlyDescriptor } from '../../extension/permission-gate-operator.js';
import { validateHarnessReadOnlyDescriptor } from '../server/harness-readonly-transport.ts';

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
  let workspaceId = 'workspace';
  let changeWorkspaceAfterList = false;
  let changeEpochAfterList = false;
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
      harnessReadOnly: async request => {
        if (request.method === 'status') return { available: true, sessionId: 'session', jobs: true, subagents: true };
        if (request.method === 'jobs.list') {
          if (changeWorkspaceAfterList) workspaceId = 'changed-workspace';
          if (changeEpochAfterList) writeHarnessReadOnlyDescriptor(join(root, '.pi', 'paseo-bridge'), { ...readDescriptor, runtimeEpoch: '00000000-0000-4000-8000-000000000002' });
          return { protocol: 1, state: 'available', sessionId: 'session', items: [], lastUpdated: null, stale: false };
        }
        if (request.method === 'subagents.list') return { protocol: 1, state: 'available', sessionId: 'session', items: [{
          taskId: 'subagent-task-111111111111111111111111', childId: 'subagent-child-222222222222222222222222',
          groupId: 'subagent-job-333333333333333333333333', runtimeId: 'runtime-exact', attempt: 1,
          status: 'running', title: 'child', lastUpdated: null, stale: false,
        }], lastUpdated: null, stale: false };
        throw new Error('unexpected read-only method');
      },
    });
    descriptor = { version: 1, socketPath: `${transport.pipePath}.operator`, capability: transport.operatorCapability,
      agentId: 'agent', sessionId: 'session', runtimeEpoch: transport.operatorEpoch };
    transport.start();
    client = net.connect(transport.pipePath);
    await once(client, 'connect');
    writePermissionGateOperatorDescriptor(join(root, '.pi', 'paseo-bridge'), descriptor);
    const readDescriptor = { version: 1, socketPath: `${transport.pipePath}.harness-readonly`,
      capability: transport.harnessReadOnlyCapability, agentId: 'agent', sessionId: 'session', runtimeEpoch: transport.operatorEpoch };
    writeHarnessReadOnlyDescriptor(join(root, '.pi', 'paseo-bridge'), readDescriptor);
    assert.equal(validateHarnessReadOnlyDescriptor(readDescriptor, 'agent'), true);
    assert.deepEqual((await (await import('node:fs/promises')).readdir(join(root, '.pi', 'paseo-bridge', 'operators'))).sort(),
      [`${(await import('node:crypto')).createHash('sha256').update('agent').digest('hex')}.readonly.json`, `${(await import('node:crypto')).createHash('sha256').update('agent').digest('hex')}.json`].sort());
    const context = { paseo: { agents: { ref: id => ({ refresh: async () => ({ agent: { id, workspaceId, provider: 'pi' } }) }) } } };
    const invoke = async (name, input) => {
      const { contract, handler } = handlers.get(name);
      return contract.output.parse(await handler(contract.input.parse(input), context));
    };
    const target = { agentId: 'agent', workspaceId: 'workspace' };
    const readonlyStatus = await invoke('harness_status', target);
    assert.equal(readonlyStatus.available, true, readonlyStatus.reason ?? '');
    assert.equal(readonlyStatus.sessionId, 'session');
    const readTarget = { ...target, expectedSessionId: readonlyStatus.sessionId, expectedRuntimeEpoch: readonlyStatus.runtimeEpoch };
    const jobs = await invoke('harness_jobs_list', readTarget);
    assert.equal(jobs.state, 'available');
    changeWorkspaceAfterList = true;
    await assert.rejects(invoke('harness_jobs_list', readTarget), /workspace/);
    changeWorkspaceAfterList = false;
    workspaceId = 'workspace';
    changeEpochAfterList = true;
    await assert.rejects(invoke('harness_jobs_list', readTarget), /session changed/);
    changeEpochAfterList = false;
    writeHarnessReadOnlyDescriptor(join(root, '.pi', 'paseo-bridge'), readDescriptor);
    const tasks = await invoke('harness_subagents_list', readTarget);
    assert.equal(tasks.items[0].taskId, 'subagent-task-111111111111111111111111');
    assert.equal(tasks.items[0].paseoAgentId, undefined);
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
    // Simulate retained transports from before readonly support: prototype
    // replacement does not invoke the new instance field initializers.
    await new Promise(resolve => transport.readonlyServer.close(resolve));
    delete transport.readonlyServer;
    delete transport.readonlySockets;
    // Rebind without any permission-gate callback/authority; readonly status must remain available.
    transport.bind({ command: async () => {}, attached() {}, detached() {}, error: error => errors.push(error),
      harnessReadOnly: async request => ({ available: true, sessionId: request.sessionId, jobs: true, subagents: true }) });
    writeHarnessReadOnlyDescriptor(join(root, '.pi', 'paseo-bridge'), { version: 1,
      socketPath: `${transport.pipePath}.harness-readonly`, capability: transport.harnessReadOnlyCapability,
      agentId: 'agent', sessionId: 'session', runtimeEpoch: transport.operatorEpoch });
    const noGateStatus = await invoke('harness_status', target);
    assert.equal(noGateStatus.available, true);
    assert.equal(noGateStatus.sessionId, 'session');
    assert.deepEqual(errors, []);
  } finally {
    cleanup?.();
    client?.destroy();
    transport.close();
    await rm(root, { recursive: true, force: true });
  }
});
