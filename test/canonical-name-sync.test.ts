import assert from "node:assert/strict";
import { test } from "node:test";
import { CanonicalNameSync } from "../extension/canonical-name-sync.ts";

function fixture(deferred = false) {
  let record = { displayName: "Parser Review", revision: 1 };
  let current = true;
  const writes: { name: string; updateAgent: boolean }[] = [];
  const warnings: string[] = [];
  const releases: (() => void)[] = [];
  const sync = new CanonicalNameSync({
    authority: { get: () => record, rename: (name, revision) => {
      assert.equal(revision, record.revision);
      record = { displayName: name.replace(/\s+/gu, " "), revision: revision + 1 };
      return record;
    } },
    isCurrent: () => current,
    write: async (name, updateAgent) => { writes.push({ name, updateAgent }); if (deferred) await new Promise<void>(resolve => releases.push(resolve)); },
    warn: message => warnings.push(message),
  });
  return { sync, writes, warnings, releases, get: () => record,
    local(name: string) { record = { displayName: name, revision: record.revision + 1 }; sync.changed(); },
    stale() { current = false; },
  };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("existing native user rename wins initial observation and echoes do not create another revision", async () => {
  const f = fixture();
  f.sync.observe("User Parser Name");
  await f.sync.settled();
  assert.deepEqual(f.get(), { displayName: "User Parser Name", revision: 2 });
  assert.deepEqual(f.writes, [{ name: "User Parser Name", updateAgent: false }]);
  f.local("Pi Parser Name");
  await f.sync.settled();
  assert.equal(f.writes.at(-1)?.name, "Pi Parser Name");
  const revision = f.get().revision;
  f.sync.observe("Pi Parser Name");
  await f.sync.settled();
  assert.equal(f.get().revision, revision);
  assert.equal(f.writes.length, 2);
});

test("a delayed reconnect baseline never overwrites a newer local rename made during admission", async () => {
  const f = fixture();
  f.local("New Local Name");
  f.sync.observe("Parser Review");
  await f.sync.settled();
  assert.deepEqual(f.get(), { displayName: "New Local Name", revision: 2 });
  assert.deepEqual(f.writes, [{ name: "New Local Name", updateAgent: true }]);
  f.sync.observe("New Local Name"); await f.sync.settled();
  assert.equal(f.get().revision, 2);
});

test("status-only native snapshots are not new renames while a Pi title write is pending", async () => {
  const f = fixture(true);
  f.sync.observe("Parser Review"); f.releases.shift()!(); await f.sync.settled();
  f.local("New Pi Name");
  const revision = f.get().revision;
  f.sync.observe("Parser Review"); // Same title, merely another status snapshot.
  assert.equal(f.get().displayName, "New Pi Name");
  assert.equal(f.get().revision, revision);
  f.sync.observe("New Pi Name");
  f.releases.shift()!(); await f.sync.settled();
  assert.equal(f.get().displayName, "New Pi Name");
  assert.equal(f.get().revision, revision);
});

test("serialized stale asynchronous writes converge to latest observed external rename, not their acknowledgments", async () => {
  const f = fixture(true);
  f.sync.observe("Parser Review");
  f.releases.shift()!(); await f.sync.settled();
  f.local("First Pi Name");
  f.local("Second Pi Name");
  f.sync.observe("Human Latest Name");
  assert.equal(f.get().displayName, "Second Pi Name"); // Rename waits behind the in-flight write.
  f.sync.observe("First Pi Name"); // Own delayed echo, not a human rename.
  assert.equal(f.get().displayName, "Second Pi Name");
  f.releases.shift()!(); await tick();
  assert.equal(f.writes.at(-1)?.name, "Human Latest Name");
  assert.equal(f.writes.some(write => write.name === "Second Pi Name"), false);
  f.sync.observe("Human Latest Name");
  f.releases.shift()!(); await f.sync.settled();
  assert.equal(f.get().displayName, "Human Latest Name");
  assert.equal(f.get().revision, 4);
});

test("invalid external names visibly restore one canonical name without a revision or feedback loop", async () => {
  const f = fixture();
  f.sync.observe("one two three four five"); await f.sync.settled();
  assert.equal(f.get().revision, 1);
  assert.equal(f.warnings.length, 1);
  assert.equal(f.writes[0].name, "Parser Review");
  f.sync.observe("Parser Review"); await f.sync.settled();
  f.sync.observe("one two three four five"); await f.sync.settled();
  assert.equal(f.warnings.length, 1);
  assert.equal(f.get().displayName, "Parser Review");
  f.sync.observe("Parser Review"); await f.sync.settled();
  assert.equal(f.writes.length, 2);
});

test("late sequence/generation events and stale runtime callbacks cannot rename another session", async () => {
  const f = fixture();
  f.sync.observe("New Name", { generation: "a", seq: 3 }); await f.sync.settled();
  f.sync.observe("Older Name", { generation: "a", seq: 2 });
  assert.equal(f.get().displayName, "New Name");
  f.sync.observe("Reconnect Name", { generation: "b", seq: 1 }); await f.sync.settled();
  f.sync.observe("Old Generation", { generation: "a", seq: 4 });
  assert.equal(f.get().displayName, "Reconnect Name");
  f.stale(); f.sync.observe("Wrong Runtime"); f.local("Local Only");
  await f.sync.settled();
  assert.equal(f.writes.at(-1)?.name, "Reconnect Name");
});

test("unavailable native writes retry without an acknowledgement rename or warning flood", async () => {
  let attempts = 0, warnings = 0;
  const record = { displayName: "Canonical Name", revision: 1 };
  const sync = new CanonicalNameSync({ authority: { get: () => record, rename: () => { throw new Error("No external rename expected"); } },
    isCurrent: () => true, write: async () => { if (++attempts < 3) throw new Error("workspace unavailable"); }, warn: () => warnings++ });
  sync.observe(null); await sync.settled();
  sync.changed(); await sync.settled();
  assert.equal(warnings, 1);
  sync.changed(); await sync.settled();
  assert.equal(attempts, 3);
  assert.equal(record.revision, 1);
  sync.close();
});

test("reconnect snapshots adopt latest observed native name without duplicate chat creation", async () => {
  const first = fixture();
  first.sync.observe("Parser Review"); await first.sync.settled();
  first.sync.close();
  first.sync.observe("Stale Closed Name");
  assert.equal(first.get().displayName, "Parser Review");
  const next = fixture();
  next.sync.observe("Offline User Rename"); await next.sync.settled();
  assert.equal(next.get().displayName, "Offline User Rename");
  assert.deepEqual(next.writes, [{ name: "Offline User Rename", updateAgent: false }]);
});

function asyncFixture() {
  let record = { displayName: "Initial Name", revision: 1 };
  let current = true;
  const calls: { name: string; revision: number; resolve(): void; reject(): void }[] = [];
  const writes: string[] = [], warnings: string[] = [];
  const sync = new CanonicalNameSync({
    authority: { get: () => record, rename: (name, revision) => new Promise((resolve, reject) => {
      calls.push({ name, revision, resolve() {
        if (revision !== record.revision) { reject(new Error("revision mismatch")); return; }
        record = { displayName: name, revision: revision + 1 }; resolve(record);
      }, reject() { reject(new Error("rename unavailable")); } });
    }) }, isCurrent: () => current,
    write: async name => { writes.push(name); }, warn: message => warnings.push(message),
  });
  return { sync, calls, writes, warnings, get: () => record, stale() { current = false; },
    local() { record = { displayName: "Local Edit", revision: record.revision + 1 }; } };
}

test("async rename is awaited and later observations serialize using fresh CAS revisions", async () => {
  const f = asyncFixture();
  f.sync.observe("First Name", { generation: "a", seq: 1 });
  f.sync.observe("Newest Name", { generation: "a", seq: 3 });
  f.sync.observe("Old Name", { generation: "a", seq: 2 });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.writes, []);
  f.calls[0].resolve(); await tick();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].name, "Newest Name");
  assert.equal(f.calls[1].revision, 2); assert.deepEqual(f.writes, []);
  f.calls[1].resolve(); await f.sync.settled();
  assert.deepEqual(f.writes, ["Newest Name"]); assert.equal(f.get().revision, 3);
});

test("a newer observation reverting to the old canonical name is not lost during await", async () => {
  const f = asyncFixture(); f.sync.observe("First Name"); f.sync.observe("Initial Name");
  f.calls[0].resolve(); await tick();
  assert.equal(f.calls[1].name, "Initial Name");
  f.calls[1].resolve(); await f.sync.settled(); assert.deepEqual(f.writes, ["Initial Name"]);
});

test("async rejection restores canonical title, consumes rejection, and permits subsequent rename", async () => {
  const f = asyncFixture(); f.sync.observe("Rejected Name");
  f.calls[0].reject(); await f.sync.settled();
  assert.equal(f.warnings.length, 1); assert.deepEqual(f.writes, ["Initial Name"]);
  f.sync.observe("Next Name"); f.calls[1].resolve(); await f.sync.settled();
  assert.equal(f.get().displayName, "Next Name");
});

test("async authority CAS rejection preserves an intervening local edit", async () => {
  const f = asyncFixture(); f.sync.observe("External Name"); f.local();
  f.calls[0].resolve(); await f.sync.settled();
  assert.equal(f.get().displayName, "Local Edit"); assert.deepEqual(f.writes, ["Local Edit"]);
  assert.equal(f.warnings.length, 1);
});

for (const closed of [false, true]) test(`post-await ${closed ? "close" : "session"} guard suppresses writes and warnings`, async () => {
  for (const reject of [false, true]) {
    const f = asyncFixture(); f.sync.observe("External Name");
    if (closed) f.sync.close(); else f.stale();
    if (reject) f.calls[0].reject(); else f.calls[0].resolve();
    await f.sync.settled(); assert.deepEqual(f.writes, []); assert.deepEqual(f.warnings, []);
  }
});

test("retired generation completion/rejection never projects or warns over a new generation", async () => {
  const f = asyncFixture(); f.sync.observe("Old Generation", { generation: "a", seq: 8 });
  f.sync.observe("New Generation", { generation: "b", seq: 1 });
  f.sync.observe("Retired Name", { generation: "a", seq: 9 });
  f.calls[0].reject(); await tick();
  assert.equal(f.calls[1].name, "New Generation"); assert.deepEqual(f.warnings, []);
  f.calls[1].resolve(); await f.sync.settled(); assert.deepEqual(f.writes, ["New Generation"]);
});

test("a rename queued behind a rejected native write is not lost", async () => {
  let record = { displayName: "Initial Name", revision: 1 };
  let rejectWrite!: (error: Error) => void;
  let attempts = 0;
  const sync = new CanonicalNameSync({ authority: { get: () => record, async rename(name, revision) {
    record = { displayName: name, revision: revision + 1 }; return record;
  } }, isCurrent: () => true, write: async () => {
    if (++attempts === 1) await new Promise<void>((_, reject) => { rejectWrite = reject; });
  }, warn: () => {} });
  sync.observe("Initial Name"); sync.observe("Queued Name");
  rejectWrite(new Error("transport unavailable")); await sync.settled();
  assert.equal(record.displayName, "Queued Name"); assert.equal(attempts, 2);
});

test("synchronous authority notifications do not reenter the rename drain", async () => {
  let record = { displayName: "Initial Name", revision: 1 };
  const writes: string[] = [];
  let calls = 0;
  let sync: CanonicalNameSync;
  sync = new CanonicalNameSync({ authority: { get: () => record, rename(name, revision) {
    calls++;
    sync.changed(); // Real authority emits a local notification from rename.
    record = { displayName: name, revision: revision + 1 };
    return record;
  } }, isCurrent: () => true, write: async name => { writes.push(name); }, warn: () => {} });
  sync.observe("External Name"); await sync.settled();
  assert.equal(calls, 1); assert.deepEqual(writes, ["External Name"]);
});

test("observation arriving in drain completion microtask is not stranded", async () => {
  const f = fixture(); f.sync.observe("Parser Review");
  queueMicrotask(() => f.sync.observe("Microtask Name"));
  await f.sync.settled(); assert.equal(f.get().displayName, "Microtask Name");
  assert.equal(f.writes.at(-1)?.name, "Microtask Name");
});
