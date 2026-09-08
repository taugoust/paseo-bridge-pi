import assert from "node:assert/strict";
import test from "node:test";
import { isRuntimeReloadCommand, requireIdleReload, validateReloadPrompt } from "../extension/reload-command.ts";

test("remote reload is an exact command with no builtin or old alias", () => {
  for (const text of ["/remote-reload", " /remote-reload \n"]) {
    assert.equal(isRuntimeReloadCommand(text), true);
    assert.doesNotThrow(() => validateReloadPrompt(text));
  }
  for (const text of ["/reload", "/reload now", "/paseo-reload", "/paseo-reload now", "/remote-reload-extra", "please /remote-reload"]) {
    assert.equal(isRuntimeReloadCommand(text), false);
    assert.throws(() => validateReloadPrompt(text), /Usage: \/remote-reload/);
  }
  assert.equal(isRuntimeReloadCommand("/remote-reload now"), true);
  assert.throws(() => validateReloadPrompt("/remote-reload now"), /without arguments/);
  assert.throws(() => validateReloadPrompt("/remote-reload", [{}]), /attachments/);
});

test("reload refuses active turns, queued work, compaction, UI requests and duplicate reloads", () => {
  const idle = { isIdle: () => true, hasPendingMessages: () => false };
  assert.doesNotThrow(() => requireIdleReload(idle));
  assert.throws(() => requireIdleReload(null), /must be idle/);
  assert.throws(() => requireIdleReload({ ...idle, isIdle: () => false }), /must be idle/);
  assert.throws(() => requireIdleReload({ ...idle, hasPendingMessages: () => true }), /must be idle/);
  assert.throws(() => requireIdleReload(idle, { compacting: true }), /must be idle/);
  assert.throws(() => requireIdleReload(idle, { pendingUi: true }), /must be idle/);
  assert.throws(() => requireIdleReload(idle, { pendingRpc: true }), /must be idle/);
  assert.throws(() => requireIdleReload(idle, { reloading: true }), /already in progress/);
});
