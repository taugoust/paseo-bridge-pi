import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchPaseoPrompt,
  PromptAdmissionError,
} from "../extension/prompt-dispatch.ts";
import {
  promptRecoveryMessage,
  reportRejectedPrompt,
  retainPromptIfCurrent,
} from "../extension/prompt-admission.ts";
import { IDLE_PROMPT_CANCELLED, safePromptError } from "../extension/idle-preflight.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fixture() {
  let context = { sessionId: "original", generation: 0 };
  let sessionEpoch = 1;
  let currentCapability: any;
  const originalEntries: unknown[] = [];
  const newSessionEntries: unknown[] = [];
  const originalCapability = {
    retainPrompt(payload: unknown) {
      originalEntries.push(payload);
      return true;
    },
  };
  const replacementCapability = {
    retainPrompt(payload: unknown) {
      newSessionEntries.push(payload);
      return true;
    },
  };
  currentCapability = originalCapability;
  const lease = {
    capability: currentCapability,
    context,
    sessionId: context.sessionId,
    sessionEpoch,
    controller: new AbortController(),
  };
  const isCurrent = () => context.sessionId === lease.sessionId &&
    sessionEpoch === lease.sessionEpoch && currentCapability === lease.capability;
  return {
    lease,
    isCurrent,
    originalEntries,
    newSessionEntries,
    refreshContext() {
      context = { ...context, generation: context.generation + 1 };
    },
    setCurrentSession(sessionId: string) {
      sessionEpoch += 1;
      context = { sessionId, generation: 0 };
      currentCapability = replacementCapability;
    },
  };
}

test("async admission rejection after session switch never retains into either session", async () => {
  const state = fixture();
  const admission = deferred<{ disposition: "handled" | "queued" | "started" }>();
  const pi = {
    getCommands: () => [],
    sendUserMessage() {},
    submitUserMessage: () => admission.promise,
  };
  let response: string | undefined;
  const pending = dispatchPaseoPrompt(pi, "original text", "original text", false)
    .catch(error => {
      assert.ok(error instanceof PromptAdmissionError);
      return reportRejectedPrompt({
        reason: safePromptError(error.cause ?? error),
        cancelledMessage: IDLE_PROMPT_CANCELLED,
        capability: state.lease.capability,
        payload: { text: "original text" },
        signal: state.lease.controller.signal,
        isCurrent: state.isCurrent,
        sendFailure: message => { response = message; },
      });
    });
  state.setCurrentSession("replacement");
  admission.reject(new Error("request was aborted before admission"));
  assert.equal(await pending, true);
  assert.equal(response, IDLE_PROMPT_CANCELLED);
  assert.deepEqual(state.originalEntries, []);
  assert.deepEqual(state.newSessionEntries, []);
});

test("abort during admission rejection remains cancellation and skips retention", async () => {
  const state = fixture();
  const admission = deferred<{ disposition: "handled" | "queued" | "started" }>();
  const pi = {
    getCommands: () => [],
    sendUserMessage() {},
    submitUserMessage: () => admission.promise,
  };
  let response: string | undefined;
  const pending = dispatchPaseoPrompt(pi, "prompt", "prompt", false)
    .catch(error => {
      assert.ok(error instanceof PromptAdmissionError);
      return reportRejectedPrompt({
        reason: safePromptError(error.cause ?? error),
        cancelledMessage: IDLE_PROMPT_CANCELLED,
        capability: state.lease.capability,
        payload: { text: "prompt" },
        signal: state.lease.controller.signal,
        isCurrent: state.isCurrent,
        sendFailure: message => { response = message; },
      });
    });
  state.lease.controller.abort();
  admission.reject(new Error("request was aborted before admission"));
  assert.equal(await pending, true);
  assert.equal(response, IDLE_PROMPT_CANCELLED);
  assert.deepEqual(state.originalEntries, []);
  assert.deepEqual(state.newSessionEntries, []);
});

test("retention finishing after its lease aborts is not reported as saved", async () => {
  const controller = new AbortController();
  const save = deferred<boolean>();
  const capability = { retainPrompt: () => save.promise };
  const pending = retainPromptIfCurrent({
    capability,
    payload: { text: "prompt" },
    reason: "preflight failed",
    signal: controller.signal,
    isCurrent: () => true,
  });
  controller.abort();
  save.resolve(true);
  assert.equal(await pending, "stale");
});

test("rejected admission reports a real failure, retains exact text, and never retries", async () => {
  const failure = new Error("request was aborted before admission");
  const retained: unknown[] = [];
  let calls = 0;
  let response: string | undefined;
  const pi = {
    getCommands: () => [],
    sendUserMessage() {},
    submitUserMessage() {
      calls += 1;
      return Promise.reject(failure);
    },
  };
  const capability = {
    retainPrompt(payload: unknown) {
      retained.push(payload);
      return true;
    },
  };
  const pending = dispatchPaseoPrompt(pi, "keep this exact text", "keep this exact text", false)
    .catch(error => {
      assert.ok(error instanceof PromptAdmissionError);
      return reportRejectedPrompt({
        reason: safePromptError(error.cause ?? error),
        cancelledMessage: IDLE_PROMPT_CANCELLED,
        capability,
        payload: { text: "keep this exact text" },
        signal: new AbortController().signal,
        isCurrent: () => true,
        sendFailure: message => { response = message; },
      });
    });
  assert.equal(await pending, true);
  assert.equal(calls, 1);
  assert.deepEqual(retained, [{ text: "keep this exact text" }]);
  assert.equal(response,
    "Prompt not sent: request was interrupted before admission. " +
    promptRecoveryMessage({ text: "keep this exact text" }, true));
});

test("fresh event contexts in the same session keep admission lease current", async () => {
  const state = fixture();
  state.refreshContext();
  const result = await retainPromptIfCurrent({
    capability: state.lease.capability,
    payload: { text: "prompt" },
    reason: "preflight failed",
    signal: state.lease.controller.signal,
    isCurrent: state.isCurrent,
  });
  assert.equal(result, "saved");
  assert.deepEqual(state.originalEntries, [{ text: "prompt" }]);
});
