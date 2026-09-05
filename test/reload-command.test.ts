import assert from "node:assert/strict";
import test from "node:test";
import { isRuntimeReloadCommand, requireIdleReload, validateReloadPrompt } from "../extension/reload-command.ts";

test("reload aliases are exact commands, never arbitrary prompt prefixes", () => {
  for (const text of ["/reload", "/paseo-reload", " /reload \n"]) {
    assert.equal(isRuntimeReloadCommand(text), true);
    assert.doesNotThrow(() => validateReloadPrompt(text));
  }
  for (const text of ["/reload-extra", "please /reload", "/paseo-reload-other"]) assert.equal(isRuntimeReloadCommand(text), false);
  assert.throws(() => validateReloadPrompt("/reload now"), /without arguments/);
  assert.throws(() => validateReloadPrompt("/reload", [{}]), /attachments/);
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
