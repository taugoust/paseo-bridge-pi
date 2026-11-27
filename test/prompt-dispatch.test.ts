import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchPaseoPrompt,
  isExtensionCommand,
  PromptAdmissionError,
} from "../extension/prompt-dispatch.ts";

const commands = () => [{ name: "slow-mode", source: "extension" }, { name: "review", source: "prompt" }];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("recognizes exact extension commands using Pi's space-delimited parser", () => {
  const pi = { getCommands: commands, sendUserMessage() {} };
  for (const text of ["/slow-mode", "/slow-mode off"]) assert.equal(isExtensionCommand(pi, text), true);
  for (const text of ["/slow-mode-extra", "/slow-mode\toff", "/review", "plain text"]) assert.equal(isExtensionCommand(pi, text), false);
});

for (const delivery of [undefined, "steer", "followUp"] as const) {
  test(`awaits actual command outcome and streams notifications for ${delivery ?? "prompt"}`, async () => {
    const completion = deferred();
    const notices: unknown[] = [];
    let settled = false;
    const pi = {
      getCommands: commands,
      sendUserMessage() { throw new Error("commands must never become model input"); },
      async dispatchExtensionCommand(name: string, args: string, options: any) {
        assert.equal(name, "slow-mode"); assert.equal(args, " off\n literal ");
        assert.equal(options.allowDialogs, false, "remote commands cannot wait on invisible local dialogs");
        options.onNotify("  Literal notice\n", "warning");
        await completion.promise;
        return { status: "completed" as const, notifications: [] };
      },
    };
    const pending = dispatchPaseoPrompt(pi, "/slow-mode  off\n literal ", "/slow-mode  off\n literal ", false,
      undefined, (message, type) => notices.push({ message, type }), delivery).then(result => { settled = true; return result; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.deepEqual(notices, [{ message: "  Literal notice\n", type: "warning" }]);
    completion.resolve();
    assert.deepEqual(await pending, { agentInvoked: false });
  });
}

test("Stop cancels a command wait without claiming that arbitrary command work stopped", async () => {
  const controller = new AbortController();
  const completion = deferred();
  const notices: string[] = [];
  let notify!: (message: string, type: "info") => void;
  let workCompleted = false;
  const pi = { getCommands: commands, sendUserMessage() { assert.fail("must not submit model text"); },
    async dispatchExtensionCommand(_name: string, _args: string, options: any) {
      notify = options.onNotify;
      await completion.promise; workCompleted = true;
      return { status: "completed" as const, notifications: [] };
    } };
  const pending = dispatchPaseoPrompt(pi, "/slow-mode", "/slow-mode", false, undefined,
    text => notices.push(text), undefined, controller.signal);
  controller.abort();
  await assert.rejects(pending, /wait aborted.*may still be running/);
  assert.equal(workCompleted, false);
  notify("late command notice", "info");
  assert.deepEqual(notices, []);
  completion.resolve();
});

test("legacy ordinary prompts retain expansion without inventing an admission receipt", async () => {
  const completion = deferred();
  let options: unknown;
  const pi = { getCommands: commands, sendUserMessage(_content: unknown, received: unknown) { options = received; return completion.promise; } };
  assert.deepEqual(await dispatchPaseoPrompt(pi, "/review", "/review", true), {});
  assert.deepEqual(options, { deliverAs: "followUp", expandPromptTemplates: true });
  completion.resolve();
});

for (const disposition of ["handled", "queued", "started"] as const) {
  test(`ordinary prompt waits for real ${disposition} admission`, async () => {
    const gate = deferred();
    let settled = false;
    const pi = { getCommands: commands, sendUserMessage() { assert.fail("must use admission API"); },
      async submitUserMessage() { await gate.promise; return { disposition }; } };
    const pending = dispatchPaseoPrompt(pi, "literal", "literal", false).then(value => { settled = true; return value; });
    await Promise.resolve(); assert.equal(settled, false);
    gate.resolve();
    assert.deepEqual(await pending, { agentInvoked: disposition !== "handled" });
  });
}

test("sync failures and invalid receipts reject before admission", async () => {
  const syncFailure = new Error("request was aborted before sending");
  const syncPi = {
    getCommands: commands,
    sendUserMessage() {},
    submitUserMessage() { throw syncFailure; },
  };
  await assert.rejects(dispatchPaseoPrompt(syncPi, "literal", "literal", false), error => {
    assert.ok(error instanceof PromptAdmissionError);
    assert.equal(error.cause, syncFailure);
    return true;
  });

  const invalidPi = {
    getCommands: commands,
    sendUserMessage() {},
    async submitUserMessage() { return {} as any; },
  };
  await assert.rejects(dispatchPaseoPrompt(invalidPi, "literal", "literal", false),
    PromptAdmissionError);
});

test("legacy async failures after send remain non-retryable", async () => {
  const failure = new Error("accepted model work failed");
  let observed: unknown;
  const pi = {
    getCommands: commands,
    sendUserMessage() { return Promise.reject(failure); },
  };
  assert.deepEqual(await dispatchPaseoPrompt(pi, "literal", "literal", false,
    error => { observed = error; }), {});
  await Promise.resolve();
  assert.equal(observed, failure);
});

test("asynchronous pre-admission rejection remains a recoverable admission failure", async () => {
  const failure = new Error("authentication unavailable");
  const pi = {
    getCommands: commands,
    sendUserMessage() { assert.fail("must not fall back after a real rejection"); },
    async submitUserMessage(): Promise<never> { throw failure; },
  };
  await assert.rejects(dispatchPaseoPrompt(pi, "literal", "literal", false), error => {
    assert.ok(error instanceof PromptAdmissionError);
    assert.equal(error.cause, failure);
    return true;
  });
});

test("ordinary queued messages preserve their delivery options", async () => {
  for (const delivery of ["steer", "followUp"] as const) {
    let options: unknown;
    const pi = { getCommands: commands, sendUserMessage(_content: unknown, received: unknown) { options = received; } };
    await dispatchPaseoPrompt(pi, "literal", "literal", false, undefined, undefined, delivery);
    assert.deepEqual(options, { deliverAs: delivery });
  }
});

test("reports real failed and vanished commands without silently submitting them", async () => {
  const pi = { getCommands: commands, sendUserMessage() { throw new Error("must not submit"); },
    async dispatchExtensionCommand() { return { status: "failed" as const, error: { message: "literal failure\n  detail" }, notifications: [] }; } };
  await assert.rejects(dispatchPaseoPrompt(pi, "/slow-mode", "/slow-mode", false), { message: "literal failure\n  detail" });
  await assert.rejects(dispatchPaseoPrompt({ ...pi, dispatchExtensionCommand: async () => ({ status: "not_found" as const, notifications: [] }) },
    "/slow-mode", "/slow-mode", false), /no longer available/);
});

test("unpatched runtimes and command attachments fail explicitly instead of false acceptance or image loss", async () => {
  const pi = { getCommands: commands, sendUserMessage() { throw new Error("must not submit"); } };
  await assert.rejects(dispatchPaseoPrompt(pi, "/slow-mode", "/slow-mode", false), /cannot report extension command outcomes/);
  await assert.rejects(dispatchPaseoPrompt(pi, [{ type: "image", data: "a" }], "/slow-mode", false), /do not accept image attachments/);
});
