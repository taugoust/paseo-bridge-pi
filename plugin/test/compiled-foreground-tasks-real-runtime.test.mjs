import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { BridgeTransport } from '../../extension/bridge-transport.ts';
import { foregroundTasksSocketPath, writeForegroundTasksDescriptor, removeForegroundTasksDescriptor } from '../../extension/foreground-task-operator.js';

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
const runtimeEnabled = process.env.PAE_FOREGROUND_RUNTIME_TEST === '1';
const repo = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const paeRoot = process.env.PI_AGENT_EXTENSIONS_SOURCE ? resolve(process.env.PI_AGENT_EXTENSIONS_SOURCE) : undefined;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = () => globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
  const r = Math.floor(Math.random() * 16); return (c === 'x' ? r : (r & 3) | 8).toString(16);
});

const providerSource = `
export default function fixture(pi) {
  pi.registerProvider('harness-test', {
    baseUrl: 'http://127.0.0.1:1/never-contacted', apiKey: 'test-only', api: 'openai-completions',
    models: [{ id: 'mock', name: 'Foreground integration fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
    streamSimple: (_model, context, options) => {
      const users = context.messages.filter(message => message.role === 'user');
      const latest = users.length ? (typeof users.at(-1).content === 'string' ? users.at(-1).content : (users.at(-1).content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\\n')) : '';
      const interaction = latest.includes('TEST_PERMISSION') ? { kind: 'permission', title: 'Run the protected fixture action?', options: ['allow', 'deny'] }
        : latest.includes('TEST_QUESTIONNAIRE') ? { kind: 'questionnaire', questions: [{ id: 'route', prompt: 'Choose a fixture route', options: [{ value: 'route-a', label: 'Route A' }, { value: 'route-b', label: 'Route B' }], allowOther: true }] } : undefined;
      const assistant = { role: 'assistant', content: [], api: 'openai-completions', provider: 'harness-test', model: 'mock', stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: assistant };
          let result;
          if (interaction) {
            const service = globalThis.__paeWorkerInteractionsV1;
            if (service?.protocol !== 1 || service.mode !== 'headless') throw new Error('Real headless worker interaction service is missing');
            const answer = await service.request(interaction, options?.signal);
            result = interaction.kind === 'permission' ? (answer.cancelled ? 'permission=cancelled' : 'permission=' + answer.value)
              : (answer.cancelled ? 'questionnaire=cancelled' : 'questionnaire=' + answer.answers.map(item => item.value).join(','));
          } else if (latest.includes('TEST_WAIT_STOP')) {
            await new Promise(resolve => {
              const timer = setTimeout(done, 60000);
              const abort = () => done();
              function done() { clearTimeout(timer); options?.signal?.removeEventListener('abort', abort); resolve(); }
              options?.signal?.addEventListener('abort', abort, { once: true });
              if (options?.signal?.aborted) done();
            });
            result = options?.signal?.aborted ? 'stop=aborted' : 'stop=timed-out';
            if (options?.signal?.aborted) assistant.stopReason = 'aborted';
          } else if (latest.includes('TEST_FRESH_TURN')) result = 'initial=' + latest.slice(0, 300);
          else result = 'fresh-turn=' + latest.slice(0, 500);
          assistant.content = [{ type: 'text', text: result }];
          if (options?.signal?.aborted) { assistant.stopReason = 'aborted'; yield { type: 'error', reason: 'aborted', error: assistant }; }
          else yield { type: 'done', reason: assistant.stopReason, message: assistant };
        },
        result: async () => assistant,
      };
    },
  });
}
`;

test('real HeadlessForegroundManager and Pi workers integrate through the private Paseo bridge (no fake core service)', {
  skip: !runtimeEnabled, timeout: 240_000,
}, async () => {
  assert.ok(compilerPath, 'Set PASEO_PLUGIN_COMPILER to the installed Paseo 0.10 compiler');
  assert.ok(paeRoot, 'PAE_FOREGROUND_RUNTIME_TEST=1 requires an explicit PI_AGENT_EXTENSIONS_SOURCE path');
  const piTestPath = process.env.PI_TUI_TEST_PI;
  assert.ok(piTestPath, 'PAE_FOREGROUND_RUNTIME_TEST=1 requires PI_TUI_TEST_PI pointing to a raw, unguarded Pi executable');
  const rawPi = await realpath(piTestPath);
  assert.ok(rawPi.startsWith('/nix/store/'), `PI_TUI_TEST_PI must resolve to an immutable Nix-store executable, got ${rawPi}`);
  await access(rawPi, constants.X_OK);
  const executableText = await readFile(rawPi, 'utf8').catch(() => '');
  if (executableText.startsWith('#!')) assert.doesNotMatch(executableText, /agentsh\\s+(?:permission-gate|wrap)|permission-gate\\s+run/i,
    'PI_TUI_TEST_PI must be the raw Pi executable, not a guarded wrapper');
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { HeadlessForegroundManager } = await import(pathToFileURL(join(paeRoot, 'subagent/headless-foreground.ts')));
  const { discoverTuiWorkers } = await import(pathToFileURL(join(paeRoot, 'subagent/tui-worker-store.ts')));
  const { callTuiWorker } = await import(pathToFileURL(join(paeRoot, 'subagent/tui-worker-client.ts')));
  const { processIsAlive } = await import(pathToFileURL(join(paeRoot, 'subagent/tui-worker-tmux.ts')));
  const { serverBundle } = await compilePlugin({ server: resolve(repo, 'index.server.ts') });
  const root = await mkdtemp(join(tmpdir(), 'paseo-foreground-real-'));
  const home = join(root, 'home'), agentDir = join(root, 'pi-agent'), stateRoot = join(root, 'headless-state'), cwd = join(root, 'work');
  await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(agentDir, { recursive: true, mode: 0o700 }), mkdir(cwd, { recursive: true, mode: 0o700 })]);
  const providerFile = join(agentDir, 'provider.ts');
  await writeFile(providerFile, providerSource);
  const backgroundExtension = join(paeRoot, 'background-job/index.ts');
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    extensions: [providerFile, backgroundExtension], defaultProvider: 'harness-test', defaultModel: 'mock', defaultProjectTrust: 'yes', quietStartup: true,
  }));

  const oldEnv = new Map(['PI_CODING_AGENT_DIR', 'PI_TUI_WORKER_LAUNCHER', 'PI_TUI_WORKER_LAUNCH_MODE'].map(key => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Explicitly override any inherited supervised/guarded launcher with the raw PI_TUI_TEST_PI selection.
  process.env.PI_TUI_WORKER_LAUNCHER = rawPi;
  process.env.PI_TUI_WORKER_LAUNCH_MODE = 'none';
  const owner = `parent-session-${uuid()}`;
  const workspaceId = 'foreground-integration-workspace';
  const manager = new HeadlessForegroundManager(stateRoot, () => 'native', () => true);
  manager.activate(owner);
  const service = manager.service();
  const bridgePath = join(root, 'bridge.sock');
  const transport = new BridgeTransport(join(root, 'parent-session.jsonl'), bridgePath);
  const handlers = new Map();
  const load = name => {
    if (name === '@getpaseo/plugin') return { defineRpc: contract => contract };
    if (name === 'node:os') return { ...require(name), homedir: () => home };
    return require(name);
  };
  const contribute = (0, eval)(serverBundle)(load).default;
  const cleanup = contribute({ handle: (contract, handler) => handlers.set(contract.name, { contract, handler }) });
  let controller;
  let descriptor;
  try {
    transport.bind({
      command: async () => {}, attached() {}, detached() {}, error: error => { throw error; },
      foregroundTasksIdentity: () => transport.connected && descriptor ? { ...descriptor, service } : undefined,
      foregroundTasks: request => service.execute(request),
    });
    transport.start();
    controller = net.connect(bridgePath);
    await once(controller, 'connect');
    descriptor = { version: 1, socketPath: foregroundTasksSocketPath(bridgePath), capability: transport.foregroundTasksCapability,
      agentId: 'agent-real', sessionId: owner, runtimeEpoch: transport.operatorEpoch, serviceEpoch: service.epoch };
    writeForegroundTasksDescriptor(join(home, '.pi', 'paseo-bridge'), descriptor);
    const context = { paseo: { agents: { ref: id => ({ refresh: async () => ({ agent: { id, workspaceId, provider: 'pi' } }) }) } } };
    const invoke = async (name, input) => {
      const { contract, handler } = handlers.get(name);
      assert.ok(contract && handler, `missing plugin RPC ${name}`);
      return contract.output.parse(await handler(contract.input.parse(input), context));
    };
    const target = { agentId: 'agent-real', workspaceId };
    const waitTask = async (title, predicate = () => true, timeoutMs = 45_000) => {
      const deadline = Date.now() + timeoutMs;
      let latest;
      while (Date.now() < deadline) {
        latest = await invoke('foreground_tasks_status', target);
        const task = latest.tasks?.find(item => item.title.includes(title) && predicate(item));
        if (task) return task;
        await delay(100);
      }
      throw new Error(`Timed out waiting for ${title}; last status=${JSON.stringify(latest)}`);
    };
    const launch = (title, taskText) => {
      const promise = manager.launch({ task: taskText, cwd, model: 'harness-test/mock:off' }, owner, cwd);
      promise.catch(() => {});
      return promise;
    };
    const viewTask = async task => {
      const status = await invoke('foreground_tasks_status', target);
      const result = await invoke('foreground_tasks_control', { ...target, expectedSessionId: status.sessionId, expectedRuntimeEpoch: status.runtimeEpoch,
        request: { operation: 'view', target: { taskId: task.taskId, childId: task.childId, workerEpoch: task.workerEpoch } } });
      assert.equal(result.state, 'available', result.message ?? '');
      return result.view;
    };
    const respond = async (task, interaction, answer) => {
      const status = await invoke('foreground_tasks_status', target);
      return invoke('foreground_tasks_control', { ...target, expectedSessionId: status.sessionId, expectedRuntimeEpoch: status.runtimeEpoch,
        request: { operation: 'respond', target: { taskId: task.taskId, childId: task.childId, workerEpoch: task.workerEpoch },
          requestId: uuid(), interactionId: interaction.id, answer } });
    };

    // This status call crosses Paseo RPC -> private socket -> real manager/service.
    const empty = await invoke('foreground_tasks_status', target);
    assert.equal(empty.available, true, empty.reason ?? '');
    assert.deepEqual(empty.tasks, []);

    const permissionRun = launch('TEST_PERMISSION', 'TEST_PERMISSION');
    const permissionTask = await waitTask('TEST_PERMISSION', task => task.status === 'waiting-permission' && task.pendingInteractions === 1);
    assert.ok(permissionTask.workerEpoch, 'pending worker must publish its real worker epoch');
    const permissionView = await viewTask(permissionTask);
    const permissionInteraction = permissionView.interactions[0];
    assert.equal(permissionInteraction.request.kind, 'permission');
    const permissionReply = await respond(permissionTask, permissionInteraction, { kind: 'permission', cancelled: false, value: 'allow' });
    assert.equal(permissionReply.accepted, true, permissionReply.message ?? '');
    await permissionRun;
    const permissionDone = await viewTask(permissionTask);
    assert.ok(permissionDone.messages.some(message => message.text.includes('permission=allow')), 'real worker did not receive the explicit permission decision');

    const questionnaireRun = launch('TEST_QUESTIONNAIRE', 'TEST_QUESTIONNAIRE');
    const questionTask = await waitTask('TEST_QUESTIONNAIRE', task => task.status === 'waiting-input' && task.pendingInteractions === 1);
    const questionInteraction = (await viewTask(questionTask)).interactions[0];
    assert.equal(questionInteraction.request.kind, 'questionnaire');
    const questionnaireReply = await respond(questionTask, questionInteraction, { kind: 'questionnaire', cancelled: false,
      answers: [{ id: 'route', value: 'route-a', wasCustom: false }] });
    assert.equal(questionnaireReply.accepted, true, questionnaireReply.message ?? '');
    await questionnaireRun;
    const questionDone = await viewTask(questionTask);
    assert.ok(questionDone.messages.some(message => message.text.includes('questionnaire=route-a')), 'real worker did not receive the questionnaire answer');

    const freshRun = await launch('TEST_FRESH_TURN', 'TEST_FRESH_TURN');
    await freshRun;
    const freshTask = await waitTask('TEST_FRESH_TURN', task => task.status === 'completed');
    const manifestBefore = discoverTuiWorkers(join(stateRoot, 'workers'), owner).find(worker => worker.taskId === freshTask.taskId);
    assert.ok(manifestBefore);
    assert.equal(manifestBefore.execution, 'rpc-headless');
    assert.equal(manifestBefore.presentation, 'headless-foreground');
    assert.equal(Object.hasOwn(manifestBefore, 'placement'), false, 'integration created no tmux pane/window placement');
    const firstWorkerStatus = await callTuiWorker(manifestBefore, { operation: 'status' });
    assert.equal(firstWorkerStatus.ok, true);
    const firstView = await viewTask(freshTask);
    // A close/reopen has no bridge command: it observes the same worker and epoch again.
    await delay(100);
    const reopenedView = await viewTask(freshTask);
    const sameWorkerStatus = await callTuiWorker(manifestBefore, { operation: 'status' });
    assert.equal(sameWorkerStatus.ok, true);
    assert.equal(sameWorkerStatus.data.pid, firstWorkerStatus.data.pid, 'close/reopen replaced the worker');
    assert.equal(reopenedView.task.workerEpoch, firstView.task.workerEpoch);
    const sessionStatus = await invoke('foreground_tasks_status', target);
    const freshPrompt = await invoke('foreground_tasks_control', { ...target, expectedSessionId: sessionStatus.sessionId, expectedRuntimeEpoch: sessionStatus.runtimeEpoch,
      request: { operation: 'prompt', target: { taskId: freshTask.taskId, childId: freshTask.childId, workerEpoch: freshTask.workerEpoch },
        requestId: uuid(), message: 'FRESH_USER_MESSAGE' } });
    assert.equal(freshPrompt.accepted, true, freshPrompt.message ?? '');
    const freshDeadline = Date.now() + 25_000;
    let freshView;
    while (Date.now() < freshDeadline) {
      freshView = await viewTask(freshTask);
      if (freshView.messages.some(message => message.text.includes('fresh-turn=') && message.text.includes('FRESH_USER_MESSAGE'))) break;
      await delay(100);
    }
    assert.ok(freshView.messages.some(message => message.role === 'user' && message.text.includes('Direct user instruction from Paseo') && message.text.includes('FRESH_USER_MESSAGE')),
      'fresh prompt did not retain direct-user origin in the real worker transcript');
    assert.ok(freshView.messages.some(message => message.text.includes('fresh-turn=') && message.text.includes('FRESH_USER_MESSAGE')),
      'fresh user prompt did not start a new worker turn');

    const stopStatus = await invoke('foreground_tasks_status', target);
    const stopTurn = await invoke('foreground_tasks_control', { ...target, expectedSessionId: stopStatus.sessionId, expectedRuntimeEpoch: stopStatus.runtimeEpoch,
      request: { operation: 'prompt', target: { taskId: freshTask.taskId, childId: freshTask.childId, workerEpoch: freshTask.workerEpoch },
        requestId: uuid(), message: 'TEST_WAIT_STOP' } });
    assert.equal(stopTurn.accepted, true, stopTurn.message ?? '');
    const stopTask = await waitTask('TEST_FRESH_TURN', task => task.status === 'running' && task.canStop);
    const stopIdentity = await invoke('foreground_tasks_status', target);
    const stopped = await invoke('foreground_tasks_control', { ...target, expectedSessionId: stopIdentity.sessionId, expectedRuntimeEpoch: stopIdentity.runtimeEpoch,
      request: { operation: 'stop', target: { taskId: stopTask.taskId, childId: stopTask.childId, workerEpoch: stopTask.workerEpoch }, requestId: uuid() } });
    assert.equal(stopped.accepted, true, stopped.message ?? '');
    const terminal = await waitTask('TEST_FRESH_TURN', task => task.status === 'cancelled');
    assert.equal(terminal.canStop, false);
    assert.deepEqual(manager.readonlyTaskList(owner, 50).find(task => task.taskId === freshTask.taskId)?.status, 'cancelled');
  } finally {
    cleanup?.(); controller?.destroy(); transport.close();
    removeForegroundTasksDescriptor(join(home, '.pi', 'paseo-bridge'), 'agent-real', transport.operatorEpoch);
    try { await manager.shutdown(true); } catch {}
    for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const workers = discoverTuiWorkers(join(stateRoot, 'workers'), owner);
    for (const worker of workers) {
      const deadline = Date.now() + 8000;
      while (await processIsAlive(worker.processPid, worker.processToken) && Date.now() < deadline) await delay(50);
      assert.equal(await processIsAlive(worker.processPid, worker.processToken), false, `test worker ${worker.childId} leaked`);
    }
    await delay(100);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
