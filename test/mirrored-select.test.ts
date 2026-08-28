import assert from "node:assert/strict";
import test from "node:test";

import { coordinateMirroredSelect } from "../extension/mirrored-select.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("remote selection wins and dismisses the terminal prompt", async () => {
  const remote = deferred<string | undefined>();
  let localAborted = false;
  const result = coordinateMirroredSelect({
    remoteResult: remote.promise,
    localSelect: (signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        localAborted = true;
        resolve(undefined);
      }, { once: true });
    }),
    resolveLocal: async () => assert.fail("terminal response must not be submitted"),
    finishRemote: () => assert.fail("already-resolved Paseo prompt must not be finished twice"),
  });

  remote.resolve("Allow once");
  assert.equal(await result, "Allow once");
  assert.equal(localAborted, true);
});

test("terminal selection resolves Paseo and uses the daemon-authoritative answer", async () => {
  const remote = deferred<string | undefined>();
  let submitted: string | undefined;
  let finished: string | undefined;
  const result = await coordinateMirroredSelect({
    remoteResult: remote.promise,
    localSelect: async () => "Allow for session",
    resolveLocal: async (value) => {
      submitted = value;
      return {
        resolution: {
          behavior: "allow",
          updatedInput: { answers: { Response: "Allow for session" } },
        },
      };
    },
    finishRemote: (value) => { finished = value; },
  });

  assert.equal(result, "Allow for session");
  assert.equal(submitted, "Allow for session");
  assert.equal(finished, "Allow for session");
});

test("a concurrent Paseo response remains authoritative", async () => {
  const remote = deferred<string | undefined>();
  const daemon = deferred<unknown>();
  const resultPromise = coordinateMirroredSelect({
    remoteResult: remote.promise,
    localSelect: async () => "Allow once",
    resolveLocal: () => daemon.promise,
    finishRemote: () => assert.fail("losing terminal response must not finish Paseo"),
  });

  await Promise.resolve();
  remote.resolve("Deny once");
  assert.equal(await resultPromise, "Deny once");
});

test("daemon denial turns a terminal cancellation into an authoritative cancellation", async () => {
  const result = await coordinateMirroredSelect({
    remoteResult: new Promise<string | undefined>(() => {}),
    localSelect: async () => undefined,
    resolveLocal: async () => ({ resolution: { behavior: "deny" } }),
    finishRemote: () => {},
  });
  assert.equal(result, undefined);
});
