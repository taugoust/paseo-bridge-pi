import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountFileRejected, readPrivateAccountJson } from "../server/private-account-json.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
 const root = await mkdtemp(join(tmpdir(), "guarded-account-json-"));
 t.after(() => rm(root, { recursive: true, force: true }));
 const dir = join(root, "agent"), privateDir = join(root, "private");
 await mkdir(dir, { mode: 0o700 }); await mkdir(privateDir, { mode: 0o700 });
 const target = join(privateDir, "credential.json");
 await writeFile(target, JSON.stringify({ synthetic: true }), { mode: 0o600 });
 return { root, dir, target };
}

test("private files and relative/absolute managed link chains retain private final-file checks", async t => {
 const f = await fixture(t);
 for (const file of ["auth.json", "pi-accounts.json", "pi-usage.json"] as const) {
  await writeFile(join(f.dir, file), '{"synthetic":true}', { mode: 0o600 });
  assert.deepEqual(await readPrivateAccountJson(f.dir, file), { synthetic: true });
  await rm(join(f.dir, file));
  const link = join(f.root, file + "-managed"); await symlink(f.target, link);
  await symlink("../" + file + "-managed", join(f.dir, file));
  assert.deepEqual(await readPrivateAccountJson(f.dir, file), { synthetic: true });
 }
});

test("rejects unsafe target modes, writable ancestors, non-files, malformed and oversized JSON without path/content disclosure", async t => {
 const f = await fixture(t); await symlink(f.target, join(f.dir, "auth.json"));
 const rejected = async () => assert.rejects(readPrivateAccountJson(f.dir, "auth.json"), error => {
  assert.ok(error instanceof AccountFileRejected); assert.equal(error.message, "Selected account file rejected"); return true;
 });
 for (const mode of [0o644, 0o620, 0o666]) { await chmod(f.target, mode); await rejected(); }
 await chmod(f.target, 0o600);
 await chmod(join(f.root, "private"), 0o777); await rejected(); await chmod(join(f.root, "private"), 0o700);
 await writeFile(f.target, 'private-synthetic-marker'); await rejected();
 await writeFile(f.target, ' '.repeat(1024 * 1024 + 1)); await rejected();
 await rm(f.target); await mkdir(f.target); await rejected();
});

test("rejects dangling and looping links and an agent-directory symlink", async t => {
 const f = await fixture(t);
 await symlink("missing", join(f.dir, "auth.json")); await assert.rejects(readPrivateAccountJson(f.dir, "auth.json"), AccountFileRejected);
 await rm(join(f.dir, "auth.json")); await symlink("auth.json", join(f.dir, "auth.json")); await assert.rejects(readPrivateAccountJson(f.dir, "auth.json"), AccountFileRejected);
 await symlink(f.dir, join(f.root, "alias")); await assert.rejects(readPrivateAccountJson(join(f.root, "alias"), "auth.json"), AccountFileRejected);
 await assert.rejects(readPrivateAccountJson(join(f.root, "alias") + "/", "auth.json"), AccountFileRejected);
 await assert.rejects(readPrivateAccountJson(f.dir + "/../agent", "auth.json"), AccountFileRejected);
 await assert.rejects(readPrivateAccountJson(f.dir + "/./", "auth.json"), AccountFileRejected);
 await rm(join(f.dir, "auth.json")); await symlink(f.target + "/", join(f.dir, "auth.json"));
 await assert.rejects(readPrivateAccountJson(f.dir, "auth.json"), AccountFileRejected);
});
