import assert from "node:assert/strict";
import test from "node:test";

import { createProviderReconnectLoop } from "../extension/provider-reconnect.ts";

test("retries provider reloads until the RPC client reconnects", async () => {
  let needsReconnect = true;
  let reloads = 0;
  const errors: unknown[] = [];
  const loop = createProviderReconnectLoop({
    shouldReconnect: () => needsReconnect,
    reload: async () => {
      reloads += 1;
      if (reloads === 1) throw new Error("daemon unavailable");
    },
    onError: (error) => errors.push(error),
    delaysMs: [60_000],
  });

  loop.trigger();
  await loop.runNow();
  assert.equal(reloads, 1);
  assert.equal(errors.length, 1);

  await loop.runNow();
  assert.equal(reloads, 2);

  needsReconnect = false;
  loop.connected();
  await loop.runNow();
  assert.equal(reloads, 2);
  loop.stop();
});

test("stop prevents a pending reconnect attempt", async () => {
  let reloads = 0;
  const loop = createProviderReconnectLoop({
    shouldReconnect: () => true,
    reload: async () => {
      reloads += 1;
    },
    delaysMs: [60_000],
  });

  loop.trigger();
  loop.stop();
  await loop.runNow();
  assert.equal(reloads, 0);
});
