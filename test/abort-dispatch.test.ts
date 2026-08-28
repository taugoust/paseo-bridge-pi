import assert from "node:assert/strict";
import test from "node:test";

import { abortAndWaitForIdle } from "../extension/abort-dispatch.ts";

test("acknowledges an abort that is already settled", async () => {
  let aborted = false;
  const context = {
    abort() {
      aborted = true;
    },
    isIdle() {
      return aborted;
    },
  };

  await abortAndWaitForIdle(context);
  assert.equal(aborted, true);
});

test("waits for Pi to become idle after fire-and-forget abort", async () => {
  let idle = false;
  let polls = 0;
  const context = {
    abort() {},
    isIdle() {
      polls += 1;
      return idle;
    },
  };

  await abortAndWaitForIdle(context, {
    timeoutMs: 100,
    pollMs: 1,
    sleep: async () => {
      idle = true;
    },
  });

  assert.ok(polls >= 2);
});

test("fails instead of falsely acknowledging an unsettled abort", async () => {
  const context = {
    abort() {},
    isIdle() {
      return false;
    },
  };

  await assert.rejects(
    abortAndWaitForIdle(context, { timeoutMs: 0 }),
    /Pi did not become idle after cancellation/,
  );
});
