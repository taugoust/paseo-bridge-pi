import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchAfterIdlePreflight,
  IDLE_PREFLIGHT_KEY,
  safePromptError,
} from "../extension/idle-preflight.ts";

const active = new AbortController().signal;

test('malformed, synchronously throwing, and unrecognized capabilities fail closed', async () => {
  for (const capability of [false, 'ready', {}, { ready: true, check: 1 },
    { ready: 1, check: async () => 'continue' },
    { ready: true, check() { throw new Error('sync failure'); } },
    { ready: true, check: async () => 'unexpected' }]) {
    const result = await dispatchAfterIdlePreflight(capability, active, async () => assert.fail('must not send'));
    assert.equal(result.dispatched, false);
    assert.ok(['error', 'cancel'].includes(result.outcome));
  }
});

test('late continue after lifetime abort never dispatches and removes the listener', async () => {
  const { getEventListeners } = await import('node:events');
  const controller = new AbortController();
  let resolve!: (value: string) => void;
  let sends = 0;
  const pending = dispatchAfterIdlePreflight({ ready: true, check(signal: AbortSignal) {
    assert.equal(signal, controller.signal);
    return new Promise<string>(done => { resolve = done; });
  } }, controller.signal, async () => ++sends);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort();
  assert.deepEqual(await pending, { outcome: 'cancel', dispatched: false });
  resolve('continue');
  await Promise.resolve();
  assert.equal(sends, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('settled checks remove listeners; dispatch errors remain observable rather than retrying', async () => {
  const { getEventListeners } = await import('node:events');
  for (const check of [async () => 'continue', async () => 'cancel', async () => { throw new Error('check failed'); }]) {
    const controller = new AbortController();
    await dispatchAfterIdlePreflight({ ready: true, check }, controller.signal, async () => 1);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  let sends = 0;
  const failure = new Error('RPC send failed');
  await assert.rejects(dispatchAfterIdlePreflight({ ready: true, check: async () => 'continue' }, active, async () => {
    sends++; throw failure;
  }), error => error === failure);
  assert.equal(sends, 1);
});

test("bridge handshake safely dispatches when optional warning extension is absent", async () => {
  let sends = 0;
  const result = await dispatchAfterIdlePreflight(undefined, active, async () => ++sends);
  assert.equal(IDLE_PREFLIGHT_KEY, "__piIdleContextPreflightV1");
  assert.deepEqual(result, { outcome: "unavailable", dispatched: true, value: 1 });
  assert.equal(sends, 1);
});

test("cancellation is authoritative even without the optional warning extension", async () => {
  const result = await dispatchAfterIdlePreflight(undefined, AbortSignal.abort(), async () => assert.fail("must not dispatch"));
  assert.deepEqual(result, { outcome: "cancel", dispatched: false });
});

test("registered extension Cancel stops dispatch; Ignore dispatches once", async () => {
  let sends = 0;
  const cancelled = await dispatchAfterIdlePreflight(
    { ready: true, check: async () => "cancel" as const }, active, async () => ++sends,
  );
  assert.deepEqual(cancelled, { outcome: "cancel", dispatched: false });
  assert.equal(sends, 0);

  const ignored = await dispatchAfterIdlePreflight(
    { ready: true, check: async () => "continue" as const }, active, async () => ++sends,
  );
  assert.deepEqual(ignored, { outcome: "continue", dispatched: true, value: 1 });
  assert.equal(sends, 1);
});

test("genuine compaction failures preserve safe diagnostics and remain errors", async () => {
  const failure = new Error("compaction aborted");
  const capability = { ready: true, check: async () => { throw failure; } };
  const result = await dispatchAfterIdlePreflight(capability, active,
    async () => assert.fail("must not dispatch"));
  assert.equal(result.outcome, "error");
  assert.equal(result.error, failure);
  assert.equal(safePromptError(failure), "compaction interrupted");
  assert.doesNotMatch(safePromptError(failure), /\babort(ed)?\b/i);
});

test("external signal abort remains an intentional cancellation", async () => {
  const controller = new AbortController();
  const check = () => new Promise<"continue">(() => {});
  const pending = dispatchAfterIdlePreflight({ ready: true, check }, controller.signal,
    async () => assert.fail("must not dispatch"));
  controller.abort();
  assert.deepEqual(await pending, { outcome: "cancel", dispatched: false });
});

test("aborted and failed preflight never silently dispatch a paid prompt", async () => {
  let sends = 0;
  const controller = new AbortController();
  controller.abort();
  const aborted = await dispatchAfterIdlePreflight({ ready: true, check: async () => "continue" as const }, controller.signal, async () => ++sends);
  const failed = await dispatchAfterIdlePreflight({ ready: true, check: async () => { throw new Error("dialog failed"); } }, active, async () => ++sends);
  const notReady = await dispatchAfterIdlePreflight({ ready: false, check: async () => "continue" as const }, active, async () => ++sends);
  assert.equal(aborted.dispatched, false);
  assert.equal(failed.dispatched, false);
  assert.equal(notReady.dispatched, false);
  assert.equal(sends, 0);
});

test("lifecycle abort settles even a broken capability that ignores cancellation", async () => {
  const controller = new AbortController();
  const capability = { ready: true, check: () => new Promise<"continue">(() => {}) };
  const result = dispatchAfterIdlePreflight(capability, controller.signal, async () => assert.fail("must not dispatch"));
  controller.abort();
  assert.equal((await result).outcome, "cancel");
});
