import test from "node:test";
import assert from "node:assert/strict";
import { gateControlsDisabled, gateLabel } from "../shared/ui-state.ts";

const ready = { available: true, enabled: false, pending: false, fetching: false, stale: false, error: false };

test("pill reports prompt state without suggesting authorization is bypassed", () => {
  assert.equal(gateLabel({ available: true, enabled: true }), "Prompts · On");
  assert.equal(gateLabel({ available: true, enabled: false }), "Prompts · Off");
  assert.equal(gateLabel({ available: false, enabled: null }), "Prompts · unavailable");
  assert.equal(gateLabel(), "Prompts · …");
});

test("stale, failed, unavailable, pending and reconnect-refresh states fail closed", () => {
  assert.equal(gateControlsDisabled(ready), false);
  for (const key of ["pending", "fetching", "stale", "error"] as const) {
    assert.equal(gateControlsDisabled({ ...ready, [key]: true }), true, key);
  }
  assert.equal(gateControlsDisabled({ ...ready, available: false, enabled: null }), true);
  assert.equal(gateControlsDisabled({ ...ready, fetching: true }), true, "reconnect refresh");
});
