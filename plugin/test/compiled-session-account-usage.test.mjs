import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
import { once } from 'node:events';

const compiler = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compiler, 'PASEO_PLUGIN_COMPILER is required');
const require = createRequire(resolve(compiler));
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'session-usage-compile-'));
after(() => rm(root, { recursive: true, force: true }));
for (const directory of ['server', 'shared']) await cp(join(pluginRoot, directory), join(root, directory), { recursive: true });
await writeFile(join(root, 'index.server.ts'), `export { registerSessionAccountUsage } from "./server/session-account-usage";`);
const { compilePlugin } = await import(pathToFileURL(resolve(compiler)));
const { serverBundle } = await compilePlugin({ server: join(root, 'index.server.ts') });
let activeHome, fsHooks;
const nativeFs = require('node:fs/promises');
const guardedFs = { ...nativeFs,
  lstat: async (...args) => { const stat = await nativeFs.lstat(...args); return fsHooks?.lstat?.(args[0], stat) ?? stat; },
  open: async (...args) => {
    const handle = await nativeFs.open(...args);
    try { await fsHooks?.afterOpen?.(args[0]); } catch (error) { await handle.close(); throw error; }
    const read = handle.read.bind(handle);
    handle.read = async (...params) => { const result = await read(...params); await fsHooks?.afterRead?.(args[0]); return result; };
    return handle;
  },
};
const { registerSessionAccountUsage } = (0, eval)(serverBundle)(name => name === 'node:os' ? { ...require(name), homedir: () => activeHome } : name === 'node:fs/promises' ? guardedFs : require(name));
const hash = value => createHash('sha256').update(value).digest('hex');
const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
const identity = (provider, accountId, subject) => hash(JSON.stringify([provider, accountId, subject]));

async function fixture({
  defaultSelected = false, accountId = 'same-name', subject = 'work-subject',
  reportedSubject = subject, reportedAccount = accountId, providerMetadata = true,
  snapshots, quotaBody,
} = {}) {
  const rootDir = await mkdtemp(join(tmpdir(), 'session-usage-fixture-'));
  activeHome = rootDir;
  const base = join(rootDir, '.pi', 'paseo-bridge');
  const operators = join(base, 'operators');
  const dir = join(rootDir, 'agent');
  await mkdir(operators, { recursive: true, mode: 0o700 }); await chmod(join(rootDir, '.pi'), 0o700); await chmod(base, 0o700); await chmod(operators, 0o700);
  await mkdir(dir, { mode: 0o700 });
  const accountClaims = { sub: reportedSubject, 'https://api.openai.com/auth': { chatgpt_account_id: reportedAccount, chatgpt_user_id: reportedSubject } };
  const codexCred = { type: 'oauth', access: jwt(accountClaims), expires: Date.now() + 3600000, accountId };
  // A same-name login under the unmanaged built-in openai provider must never be read.
  const personalClaims = { sub: 'personal-subject', chatgpt_account_id: 'personal',
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'personal', chatgpt_user_id: 'personal-subject' } };
  const personal = { type: 'oauth', access: jwt(personalClaims), expires: Date.now() + 3600000,
    accountId: 'personal' };
  const accounts = { version: 1, providers: {
    'openai-codex': { accounts: { [accountId]: codexCred } },
    openai: { accounts: { [accountId]: personal } },
  } };
  const auth = { 'openai-codex': codexCred, openai: personal };
  await writeFile(join(dir, 'pi-accounts.json'), JSON.stringify(accounts), { mode: 0o600 });
  await writeFile(join(dir, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });

  const socketPath = join(rootDir, 'controls.sock');
  let snapshotIndex = 0;
  const requests = [];
  const baseSnapshot = () => {
    const current = snapshots?.[Math.min(snapshotIndex, snapshots.length - 1)] ?? {};
    snapshotIndex++;
    return {
      protocol: 1, serviceEpoch: 'service-1', selectionRevision: 3, sessionId: 'session-1',
      ...(providerMetadata ? { providerId: 'openai-codex' } : {}),
      accounts: [{ id: accountId, label: 'Work', authKind: 'oauth' }],
      currentAccountId: defaultSelected ? null : accountId, defaultSelected,
      activationStatus: defaultSelected ? 'inactive' : 'active', busy: false, canSwitch: true,
      usage: {
        effectiveCredential: defaultSelected
          ? 'chatgpt-grant-configured' : 'chatgpt-grant-matched-refreshed',
        status: 'local-binding-confirmed', remoteEntitlement: 'not-queried',
        accountKey: current.accountKey ?? identity('openai-codex', accountId, subject),
        settingsUrl: 'https://chatgpt.com/settings/usage',
      },
      ...current,
    };
  };
  const server = net.createServer(socket => {
    let data = '';
    socket.on('data', chunk => {
      data += chunk.toString();
      const end = data.indexOf('\n'); if (end < 0) return;
      const request = JSON.parse(data.slice(0, end));
      requests.push(request.request);
      const result = baseSnapshot();
      socket.end(`${JSON.stringify({ v: 1, type: 'account_controls', id: request.id, success: true, agentId: 'agent', sessionId: 'session-1', runtimeEpoch: '123e4567-e89b-42d3-a456-426614174000', serviceEpoch: 'service-1', data: result })}\n`);
    });
  });
  server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600);
  const capability = 'a'.repeat(64);
  const descriptor = { version: 1, socketPath, capability, agentId: 'agent', sessionId: 'session-1', runtimeEpoch: '123e4567-e89b-42d3-a456-426614174000', serviceEpoch: 'service-1' };
  const descriptorFile = join(operators, `${hash('agent')}.accounts.json`);
  await writeFile(descriptorFile, JSON.stringify(descriptor), { mode: 0o600 });
  const registered = {};
  registerSessionAccountUsage({ registerUsageSource: source => { registered.source = source; } });
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), authorization: init.headers?.Authorization, accountId: init.headers?.['ChatGPT-Account-Id'] });
    const body = quotaBody ?? { plan_type: 'synthetic', rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 3600, reset_at: 2000000000 } } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const scope = model => ({ kind: 'session', provider: 'pi', model, env: { PASEO_AGENT_ID: 'agent', PI_CODING_AGENT_DIR: dir, HOME: rootDir } });
  const discoverAll = async model => {
    snapshotIndex = 0;
    return registered.source.discover(scope(model));
  };
  const discover = async model => (await discoverAll(model))[0];
  const fetchUsage = input => registered.source.fetch(input);
  return { rootDir, dir, server, oldFetch, calls, requests, codexAccess: codexCred.access,
    discover, discoverAll, fetchUsage, close: async () => {
      fsHooks = undefined; globalThis.fetch = oldFetch; server.close();
      await rm(rootDir, { recursive: true, force: true });
    } };
}

test('named and default Codex use the selected grant and ask only for openai-codex', async t => {
  for (const defaultSelected of [false, true]) {
    const f = await fixture({ defaultSelected }); t.after(f.close);
    const item = await f.discover('openai-codex/gpt-test');
    const report = await f.fetchUsage(item.input);
    assert.equal(report.status, 'available', JSON.stringify({ report, calls: f.calls }));
    assert.deepEqual(f.calls.map(call => call.url), ['https://chatgpt.com/backend-api/wham/usage']);
    assert.ok(f.calls.every(call => call.authorization === `Bearer ${f.codexAccess}`));
    assert.equal(item.key, identity('openai-codex', 'same-name', 'work-subject'));
    assert.ok(f.requests.length > 0);
    const codexSnapshot = request =>
      request.operation === 'snapshot' && request.providerId === 'openai-codex';
    assert.ok(f.requests.every(codexSnapshot), JSON.stringify(f.requests));
  }
});

test('sessions on openai/ and other non-Codex models get no usage source', async t => {
  const f = await fixture(); t.after(f.close);
  const models = ['openai/gpt-test', 'anthropic/claude-test',
    'openai-codexx/gpt-test', undefined];
  for (const model of models) assert.deepEqual(await f.discoverAll(model), [], String(model));
  assert.deepEqual(f.requests, [], 'no account-controls request for non-Codex models');
  assert.deepEqual(f.calls, []);
});

test('quota mapping preserves duration IDs, scoped limits, review windows, and over-100 utilization', async t => {
  const f = await fixture({ quotaBody: {
    plan_type: 'synthetic',
    rate_limit: { primary_window: { used_percent: 125, limit_window_seconds: 3600 } },
    additional_rate_limits: [{ metered_feature: 'feature-x', limit_name: 'Feature X', rate_limit: { secondary_window: { used_percent: 4, limit_window_seconds: 604800 } } }],
    code_review_rate_limit: { primary_window: { used_percent: 2, limit_window_seconds: 18000 } },
    credits: { balance: 9 },
  } }); t.after(f.close);
  const item = await f.discover('openai-codex/gpt-test');
  const report = await f.fetchUsage(item.input);
  assert.equal(report.status, 'available');
  assert.deepEqual(report.windows.map(({ id, usedPct, summary }) => [id, usedPct, summary ?? false]), [
    ['3600s', 125, true],
    ['limit:feature-x:weekly', 4, false],
    ['code_review:five_hour', 2, false],
  ]);
  assert.deepEqual(report.balances, [{ id: 'credits', label: 'Credits', remaining: 9, unit: 'credits', tone: 'ok' }]);
});

test('Codex refuses missing/wrong provider metadata and mismatched account or subject identity', async t => {
  for (const options of [
    { providerMetadata: false },
    { snapshots: [{ providerId: 'openai' }] },
    { reportedSubject: 'other-subject' },
    { reportedAccount: 'other-account' },
  ]) {
    const f = await fixture(options); t.after(f.close);
    const item = await f.discover('openai-codex/gpt-test');
    assert.equal(item.label, undefined, JSON.stringify(options));
    assert.notEqual((await f.fetchUsage(item.input)).status, 'available');
    assert.deepEqual(f.calls, []);
  }
});

async function managedFile(f, file) {
  const target = join(f.rootDir, 'private-' + file);
  await cp(join(f.dir, file), target); await chmod(target, 0o600); await rm(join(f.dir, file));
  const middle = join(f.rootDir, 'managed-' + file); await symlink(target, middle);
  await symlink('../managed-' + file, join(f.dir, file)); return target;
}

test('managed link chains support default and named Codex logins', async t => {
  for (const defaultSelected of [false, true]) {
    const f = await fixture({ defaultSelected }); t.after(f.close);
    for (const file of ['auth.json','pi-accounts.json']) await managedFile(f, file);
    const item = await f.discover('openai-codex/gpt-test');
    const report = await f.fetchUsage(item.input);
    assert.equal(report.status, 'available', JSON.stringify(report));
    assert.ok(f.calls.length > 0);
    assert.ok(f.calls.every(call => call.authorization === `Bearer ${f.codexAccess}`));
  }
});

test('unsafe or unreadable selected authentication never falls back and gives a sanitized local-file diagnosis', async t => {
  for (const mutation of ['mode','parent-mode','directory','dangling','loop','malformed','oversized','foreign-file','foreign-link','root-link']) {
    if(mutation === 'root-link' && process.getuid() === 0)continue; // Root-owned is user-owned when testing as root.
    const f = await fixture({ defaultSelected: true }); t.after(f.close);
    const path = join(f.dir,'auth.json');
    if (mutation === 'mode') await chmod(path,0o644);
    if (mutation === 'parent-mode') { const parent=join(f.rootDir,'unsafe');await mkdir(parent);await chmod(parent,0o777);await cp(path,join(parent,'credential'));await rm(path);await symlink(join(parent,'credential'),path); }
    if (['directory','dangling','loop'].includes(mutation)) { await rm(path); if(mutation === 'directory')await mkdir(path); else await symlink(mutation === 'loop'?'auth.json':'missing',path); }
    if (mutation === 'malformed') await writeFile(path,'sensitive-fixture-marker');
    if (mutation === 'oversized') await writeFile(path,' '.repeat(1024*1024+1));
    if (mutation === 'foreign-link' || mutation === 'root-link') await managedFile(f,'auth.json');
    if (mutation === 'root-link') fsHooks = { lstat: (name,stat) => { if(name === path)stat.uid=0;return stat; } };
    if (mutation.startsWith('foreign')) fsHooks = { lstat: (name,stat) => { if(name === path)stat.uid=process.getuid()+1; return stat; } };
    const item = await f.discover('openai-codex/gpt-test'); const report = await f.fetchUsage(item.input);
    assert.notEqual(report.status,'available'); assert.match(JSON.stringify(report),/authentication file/); assert.doesNotMatch(JSON.stringify(report),/sensitive-fixture-marker|session-usage-fixture-/); assert.deepEqual(f.calls,[]);
  }
});

test('link and file replacement during open/read invalidates results before any quota request', async t => {
  for (const stage of ['afterOpen','afterRead']) for (const replacement of ['link','file']) {
    const f = await fixture({ defaultSelected: true }); t.after(f.close);
    const target = await managedFile(f,'auth.json'); let changed=false;
    fsHooks = { [stage]: async name => {
      if(name !== target || changed)return; changed=true;
      if(replacement === 'link') { await rm(join(f.dir,'auth.json')); await symlink(target,join(f.dir,'auth.json')); }
      else { await rm(target); await writeFile(target,'{"synthetic":true}',{mode:0o600}); }
    } };
    const item = await f.discover('openai-codex/gpt-test'); const report = await f.fetchUsage(item.input);
    assert.ok(changed); assert.notEqual(report.status,'available'); assert.match(JSON.stringify(report),/authentication file/); assert.deepEqual(f.calls,[]);
  }
});

test('missing named credentials never substitute a default or an openai login', async t => {
  const openaiLogin = { type: 'oauth', access: 'x.e30.y', expires: Date.now() + 3600000 };
  for (const providers of [{}, { openai: { accounts: { 'same-name': openaiLogin } } }]) {
    const f = await fixture(); t.after(f.close);
    await writeFile(join(f.dir, 'pi-accounts.json'), JSON.stringify({ version: 1, providers }));
    const item = await f.discover('openai-codex/gpt-test');
    assert.notEqual((await f.fetchUsage(item.input)).status, 'available');
    assert.deepEqual(f.calls, []);
  }
});

test('a file rejected after discovery retains its local-file diagnosis and never uses fallback', async t => {
  const f=await fixture({defaultSelected:true});t.after(f.close);const target=await managedFile(f,'auth.json');
  const item=await f.discover('openai-codex/gpt-test');await chmod(target,0o644);
  const report=await f.fetchUsage(item.input);assert.notEqual(report.status,'available');assert.match(JSON.stringify(report),/authentication file/);assert.deepEqual(f.calls,[]);
});

test('a selection changed while quota is in flight discards the result without fallback', async t => {
  const f = await fixture({ snapshots:[{},{},{},{},{selectionRevision:4}] });t.after(f.close);
  const item=await f.discover('openai-codex/gpt-test');const report=await f.fetchUsage(item.input);
  assert.notEqual(report.status,'available');assert.match(JSON.stringify(report),/binding changed/);assert.equal(f.calls.length,1);
});

test('stale Codex selection revision/session changes invalidate usage after discovery', async t => {
  for (const mutation of [{ selectionRevision: 4 }, { sessionId: 'other-session' }]) {
    const f = await fixture({ snapshots: [{}, {}, mutation] }); t.after(f.close);
    const item = await f.discover('openai-codex/gpt-test');
    assert.notEqual((await f.fetchUsage(item.input)).status, 'available');
    if (mutation.sessionId) assert.deepEqual(f.calls, []);
  }
});
