import test from "node:test";
import assert from "node:assert/strict";
import { mayApplyAsyncResult } from "../shared/lifecycle.ts";

test("late status results cannot update removed/replaced agents or cleaned up contributions", () => {
  const entry = {};
  assert.equal(mayApplyAsyncResult({ stopped: false, aborted: false, sequence: 2, currentSequence: 2, current: entry, expected: entry }), true);
  assert.equal(mayApplyAsyncResult({ stopped: true, aborted: true, sequence: 2, currentSequence: 2, current: entry, expected: entry }), false);
  assert.equal(mayApplyAsyncResult({ stopped: false, aborted: false, sequence: 1, currentSequence: 2, current: entry, expected: entry }), false);
  assert.equal(mayApplyAsyncResult({ stopped: false, aborted: false, sequence: 2, currentSequence: 2, current: undefined, expected: entry }), false);
  assert.equal(mayApplyAsyncResult({ stopped: false, aborted: false, sequence: 2, currentSequence: 2, current: {}, expected: entry }), false);
});
