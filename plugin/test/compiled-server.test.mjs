import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { processStartToken } from '../../shim/runtime-registry.js';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';
import net from 'node:net';
import { BridgeTransport } from '../../extension/bridge-transport.ts';
import { writePermissionGateOperatorDescriptor, writeHarnessReadOnlyDescriptor } from '../../extension/permission-gate-operator.js';
import { foregroundTasksSocketPath, writeForegroundTasksDescriptor } from '../../extension/foreground-task-operator.js';
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
  let observationMode = 'valid';
  let descendantMode = 'valid';
  let childReadCalls = 0;
  const foregroundCalls = [];
  const task = { taskId: 'task-1', childId: 'child-1', workerEpoch: 'worker-epoch-1', groupId: 'group-1', attempt: 1, title: 'Helper', model: 'harness-test/mock:off', status: 'waiting-permission',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z', pendingInteractions: 1, canPrompt: true, canStop: true };
  const foregroundService = { protocol: 1, sessionId: 'session', epoch: 'service-epoch', async execute(request) {
    foregroundCalls.push(request);
    if (request.sessionId !== this.sessionId || request.epoch !== this.epoch) throw new Error('stale service identity');
    if (request.operation !== 'list' && (!request.target || request.target.taskId !== task.taskId || request.target.childId !== task.childId || request.target.workerEpoch !== task.workerEpoch)) throw new Error('stale worker ownership/epoch');
    if (request.operation === 'list') return { protocol: 1, sessionId: this.sessionId, epoch: this.epoch, state: 'available', tasks: [task] };
    if (request.operation === 'view') return { protocol: 1, sessionId: this.sessionId, epoch: this.epoch, state: 'available', view: { task, messages: [], interactions: [{ id: 'permission-1', workerEpoch: task.workerEpoch, createdAt: task.createdAt, request: { kind: 'permission', title: 'Run command?', options: ['allow', 'deny'] } }], truncated: false } };
    return { protocol: 1, sessionId: this.sessionId, epoch: this.epoch, state: 'available', accepted: true };
  } };
  const errors = [];
  const handlers = new Map();
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: contract => contract, defineSettings: contract => contract };
    if (name === 'node:os') return { ...require(name), homedir: () => root };
    return require(name);
  };
  const contribute = (0, eval)(serverBundle)(load).default;
  const cleanup = contribute({ registerSettings: contract => { assert.equal(contract.id, 'work-source'); assert.deepEqual(contract.schema.parse({}), { sources: [] }); }, handle: (contract, handler) => handlers.set(contract.name, { contract, handler }), registerUsageSource: () => () => {}, before: () => () => {} });
  let descriptor;
  try {
    transport.bind({
      command: async () => { commandCalls++; }, attached() {}, detached() {}, error: error => errors.push(error),
      permissionGateOperator: () => ({ descriptor, authority: () => ({
        status: sessionId => ({ sessionId, enabled }),
        applyMode: (sessionId, next) => ({ sessionId, enabled: (enabled = next) }),
      }) }),
      foregroundTasksIdentity: () => ({ agentId: 'agent', sessionId: 'session', runtimeEpoch: transport.operatorEpoch, capability: transport.foregroundTasksCapability, service: foregroundService }),
      foregroundTasks: request => foregroundService.execute(request),
      harnessReadOnly: async request => {
        if (request.method === 'status') return { available: true, sessionId: 'session', jobs: true, subagents: true };
        if (request.method === 'observability.snapshot') return { protocol: 1, state: 'available', sessionId: observationMode === 'stale' ? 'old-session' : 'session', feature: request.payload.feature, lastUpdated: null, stale: false, data: { steps: [{ text: 'Review', status: observationMode === 'invalid' ? 'invented' : 'blocked', secret: 'never-forward' }] } };
        if (request.method === 'jobs.list') {
          if (changeWorkspaceAfterList) workspaceId = 'changed-workspace';
          if (changeEpochAfterList) writeHarnessReadOnlyDescriptor(join(root, '.pi', 'paseo-bridge'), { ...readDescriptor, runtimeEpoch: '00000000-0000-4000-8000-000000000002' });
          return { protocol: 1, state: 'available', sessionId: 'session', items: [
            { jobId: 'job-' + '1'.repeat(24), status: 'completed', name: 'direct fixture', createdAt: '2026-01-01', updatedAt: null, observationOnly: false },
            { jobId: 'job-' + '2'.repeat(24), status: 'completed', name: 'grandchild fixture', createdAt: '2026-01-01', updatedAt: null, observationOnly: false, fromSubagent: true },
          ], nextCursor: 'opaque-page', lastUpdated: null, stale: false };
        }
        if (request.method === 'jobs.output') return { protocol: 1, state: 'available', sessionId: 'session', item: { jobId: request.payload.jobId, text: 'Grandchild read-only output', truncated: false, source: 'log', lastUpdated: null, stale: true }, lastUpdated: null, stale: true };
        if (request.method === 'subagents.list' && request.sessionId === 'child-session') {
          childReadCalls++;
          if (descendantMode === 'slow') await new Promise(resolve => setTimeout(resolve, 2000));
        }
        if (request.method === 'subagents.list' && request.sessionId === 'child-session') return { protocol: 1, state: 'available', sessionId: descendantMode === 'wrong-session' ? 'wrong-session' : 'child-session', ...(descendantMode === 'cursor-cycle' ? { nextCursor: 'repeated' } : {}), items: [{
          taskId: 'subagent-task-' + '4'.repeat(24), childId: 'subagent-child-' + '5'.repeat(24), groupId: 'subagent-job-' + '6'.repeat(24), runtimeId: 'grandchild-runtime', attempt: 1, status: 'running', title: 'descendant', lastUpdated: null, stale: false,
          source: { agentId: 'forged', workspaceId: 'forged', sessionId: 'forged', runtimeEpoch: 'forged' }, parentKey: 'forged',
        }], lastUpdated: null, stale: descendantMode === 'stale' };
        if (request.method === 'subagents.list') return { protocol: 1, state: 'available', sessionId: 'session', items: [{
          taskId: 'subagent-task-111111111111111111111111', childId: 'subagent-child-222222222222222222222222',
          groupId: 'subagent-job-333333333333333333333333', runtimeId: 'runtime-exact', attempt: 1,
          status: 'waiting', title: 'child', lastUpdated: null, stale: false,
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
    const readDescriptor = { version: 1, socketPath: transport.harnessReadOnlySocketPath,
      capability: transport.harnessReadOnlyCapability, agentId: 'agent', sessionId: 'session', runtimeEpoch: transport.operatorEpoch };
    writeHarnessReadOnlyDescriptor(join(root, '.pi', 'paseo-bridge'), readDescriptor);
    const foregroundDescriptor = { version: 1, socketPath: foregroundTasksSocketPath(transport.pipePath), capability: transport.foregroundTasksCapability,
      agentId: 'agent', sessionId: 'session', runtimeEpoch: transport.operatorEpoch, serviceEpoch: foregroundService.epoch };
    writeForegroundTasksDescriptor(join(root, '.pi', 'paseo-bridge'), foregroundDescriptor);
    assert.equal(validateHarnessReadOnlyDescriptor(readDescriptor, 'agent'), true);
    assert.deepEqual((await (await import('node:fs/promises')).readdir(join(root, '.pi', 'paseo-bridge', 'operators'))).sort(),
      [`${(await import('node:crypto')).createHash('sha256').update('agent').digest('hex')}.foreground.json`, `${(await import('node:crypto')).createHash('sha256').update('agent').digest('hex')}.readonly.json`, `${(await import('node:crypto')).createHash('sha256').update('agent').digest('hex')}.json`].sort());
    const refreshedAgents = [];
    const context = { paseo: { agents: { ref: id => ({ refresh: async () => { refreshedAgents.push(id); return { agent: { id, workspaceId, provider: 'pi' } }; } }) } } };
    const invoke = async (name, input) => {
      const { contract, handler } = handlers.get(name);
      return contract.output.parse(await handler(contract.input.parse(input), context));
    };
    const target = { agentId: 'agent', workspaceId: 'workspace' };
    const readonlyStatus = await invoke('harness_status', target);
    assert.equal(readonlyStatus.available, true, readonlyStatus.reason ?? '');
    assert.equal(readonlyStatus.sessionId, 'session');
    const readTarget = { ...target, expectedSessionId: readonlyStatus.sessionId, expectedRuntimeEpoch: readonlyStatus.runtimeEpoch };
    const childIdentity = { taskId: `subagent-task-${'1'.repeat(24)}`, childId: `subagent-child-${'2'.repeat(24)}`,
      groupId: `subagent-job-${'3'.repeat(24)}`, attempt: 2, runtimeId: 'exact-child-runtime' };
    const registry = join(root, '.pi', 'paseo-bridge', 'runtimes');
    await mkdir(registry, { recursive: true, mode: 0o700 });
    const liveRecord = { ...childIdentity, lifecycle: 'active', managed: true, parentSessionId: 'session',
      pid: process.pid, processStartToken: processStartToken(), agentId: 'existing-child', workspaceId: 'workspace' };
    const putRecord = record => writeFile(join(registry, 'child.json'), JSON.stringify(record), { mode: 0o600 });
    await putRecord(liveRecord);
    const routeInput = { ...readTarget, ...childIdentity };
    assert.deepEqual(await invoke('harness_subagent_route', routeInput), { agentId: 'existing-child', workspaceId: 'workspace' });
    for (const changed of [{ attempt: 1 }, { childId: `subagent-child-${'4'.repeat(24)}` }, { groupId: `subagent-job-${'5'.repeat(24)}` }, { runtimeId: 'other-runtime' }, { expectedSessionId: 'other-session' }, { expectedRuntimeEpoch: '00000000-0000-4000-8000-000000000001' }]) {
      await assert.rejects(invoke('harness_subagent_route', { ...routeInput, ...changed }));
    }
    for (const changed of [{ parentSessionId: 'other-owner' }, { processStartToken: 'dead:pid' }, { lifecycle: 'reaped' }]) {
      await putRecord({ ...liveRecord, ...changed });
      await assert.rejects(invoke('harness_subagent_route', routeInput));
    }
    await putRecord(liveRecord);
    assert.equal(commandCalls, 0, 'route lookup never prompts, imports or creates a child');
    {
      const childDescriptor = { ...readDescriptor, agentId: 'existing-child', sessionId: 'child-session' };
      writeHarnessReadOnlyDescriptor(join(root, '.pi', 'paseo-bridge'), childDescriptor);
      const matchingRecord = { ...liveRecord, attempt: 1, runtimeId: 'runtime-exact' };
      await putRecord(matchingRecord);
      const treeInput = { ...readTarget, includeDescendants: true };
      const tree = await invoke('harness_subagents_list', treeInput);
      assert.equal(tree.items.length, 2, 'verified readonly child inventory exposes descendants');
      const beforeConcurrent = childReadCalls;
      const concurrent = await Promise.all([invoke('harness_subagents_list', treeInput), invoke('harness_subagents_list', treeInput)]);
      assert.equal(childReadCalls - beforeConcurrent, 1, 'same exact source/session/epoch/page shares a single subtree read');
      assert.deepEqual(concurrent[0], concurrent[1]);
      const beforeOtherPage = childReadCalls;
      await Promise.all([invoke('harness_subagents_list', treeInput), invoke('harness_subagents_list', { ...treeInput, cursor: 'other-page' })]);
      assert.equal(childReadCalls - beforeOtherPage, 2, 'different page snapshots are never incorrectly coalesced');
      await assert.rejects(invoke('harness_subagents_list', { ...treeInput, expectedSessionId: 'wrong-source-session' }), 'single-flight must not cross source identity');
      assert.equal(tree.items[0].source.sessionId, 'session');
      assert.equal(tree.items[1].source.sessionId, 'child-session');
      assert.equal(tree.items[1].source.agentId, 'existing-child', 'producer cannot forge source routing');
      assert.notEqual(tree.items[1].parentKey, 'forged', 'producer cannot forge ancestry');
      assert.equal(tree.items[1].parentKey, JSON.stringify([JSON.stringify(['agent', 'workspace', 'session', readTarget.expectedRuntimeEpoch, tree.items[0].taskId]), tree.items[0].childId, 1, 'runtime-exact']));
      for (const changed of [{ parentSessionId: 'other-owner' }, { processStartToken: 'dead:pid' }, { attempt: 2 }, { lifecycle: 'reaped' }]) {
        await putRecord({ ...matchingRecord, ...changed });
        assert.equal((await invoke('harness_subagents_list', treeInput)).items.length, 1, 'missing ownership evidence omits descendant relation');
      }
      for (const mode of ['wrong-session', 'cursor-cycle', 'stale']) {
        descendantMode = mode;
        await putRecord(matchingRecord);
        const omitted = await invoke('harness_subagents_list', treeInput);
        assert.equal(omitted.items.length, 1, 'stale identity or pagination cannot manufacture descendants');
        assert.equal(omitted.hierarchyPartial, true);
        assert.match(omitted.hierarchyMessage, /unavailable/);
      }
      descendantMode = 'slow';
      await putRecord(matchingRecord);
      const started = Date.now();
      const bounded = await invoke('harness_subagents_list', treeInput);
      assert.ok(Date.now() - started < 1800, 'slow descendant cannot extend traversal beyond its overall deadline');
      assert.equal(bounded.items.length, 1, 'direct rows survive slow child inventory');
      assert.equal(bounded.hierarchyPartial, true);
      assert.match(bounded.hierarchyMessage, /unavailable|budget/);
      descendantMode = 'valid';
      await putRecord(liveRecord);
      assert.equal(commandCalls, 0, 'descent remains readonly, no child creation');
    }
    const observed = await invoke('observability_snapshot', { ...readTarget, feature: 'progress' });
    assert.equal(observed.data.steps[0].status, 'blocked');
    assert.equal(JSON.stringify(observed).includes('never-forward'), false);
    observationMode = 'stale';
    await assert.rejects(invoke('observability_snapshot', { ...readTarget, feature: 'progress' }), /identity mismatch/);
    observationMode = 'invalid';
    await assert.rejects(invoke('observability_snapshot', { ...readTarget, feature: 'progress' }));
    observationMode = 'valid';
    const jobs = await invoke('harness_jobs_list', readTarget);
    assert.equal(jobs.state, 'available');
    assert.equal(jobs.items[0].fromSubagent, undefined);
    assert.equal(jobs.items[1].fromSubagent, true, 'compiled server preserves descendant partition');
    assert.equal(jobs.nextCursor, 'opaque-page');
    assert.equal((await invoke('harness_jobs_output', { ...readTarget, jobId: jobs.items[1].jobId })).item.text, 'Grandchild read-only output');
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
    assert.equal(tasks.items[0].status, 'waiting', 'read-only server projection preserves waiting as a nonterminal task status');
    assert.equal(tasks.items[0].paseoAgentId, undefined, 'wrong attempt/runtime never obtains another child title route');
    await putRecord({ ...liveRecord, attempt: 1, runtimeId: 'runtime-exact' });
    const beforeTitleLookup = refreshedAgents.length;
    const titled = await invoke('harness_subagents_list', readTarget);
    assert.equal(titled.items[0].paseoAgentId, 'existing-child');
    assert.equal(titled.items[0].paseoWorkspaceId, 'workspace');
    assert.deepEqual(refreshedAgents.slice(beforeTitleLookup), ['agent', 'agent', 'agent'], 'root read and final registry attribution are revalidated without per-child catalog snapshots');
    await putRecord(liveRecord);
    const foreground = await invoke('foreground_tasks_status', target);
    assert.equal(foreground.available, true, foreground.reason ?? '');
    assert.equal(foreground.tasks[0].workerEpoch, 'worker-epoch-1');
    assert.equal(foreground.tasks[0].model, 'harness-test/mock:off');
    task.status = 'waiting';
    assert.equal((await invoke('foreground_tasks_status', target)).tasks[0].status, 'waiting', 'strict foreground task response accepts waiting');
    task.status = 'unknown';
    const rejectedUnknown = await invoke('foreground_tasks_status', target);
    assert.equal(rejectedUnknown.available, false, 'strict foreground task response rejects unknown statuses');
    assert.match(rejectedUnknown.reason, /Invalid (?:enum value|option)|received/i);
    task.status = 'waiting-permission';
    task.workerEpoch = '';
    const pendingTaskList = await invoke('foreground_tasks_status', target);
    assert.equal(pendingTaskList.available, true, 'a starting/lost task with no live worker epoch must not invalidate the whole list');
    assert.equal(pendingTaskList.tasks[0].workerEpoch, '');
    task.workerEpoch = 'worker-epoch-1';
    const fgTarget = { ...target, expectedSessionId: foreground.sessionId, expectedRuntimeEpoch: foreground.runtimeEpoch };
    const fgRequest = { operation: 'respond', target: { taskId: 'task-1', childId: 'child-1', workerEpoch: 'worker-epoch-1' },
      requestId: '5d0a7c1c-1853-4c91-9f0c-51cc3a488657', interactionId: 'permission-1', answer: { kind: 'permission', cancelled: false, value: 'allow' } };
    assert.equal((await invoke('foreground_tasks_control', { ...fgTarget, request: fgRequest })).accepted, true);
    assert.equal(foregroundCalls.at(-1).requestId, fgRequest.requestId, 'the exact UI idempotency key reaches the core service');
    await assert.rejects(invoke('foreground_tasks_control', { ...fgTarget, expectedRuntimeEpoch: '00000000-0000-4000-8000-000000000001', request: fgRequest }), /changed/);
    await assert.rejects(invoke('foreground_tasks_control', { ...fgTarget, request: { ...fgRequest, target: { ...fgRequest.target, workerEpoch: 'expired' } } }), /ownership\/epoch/);
    assert.equal(JSON.stringify(foreground).includes(foregroundDescriptor.capability), false);
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
      socketPath: transport.harnessReadOnlySocketPath, capability: transport.harnessReadOnlyCapability,
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
