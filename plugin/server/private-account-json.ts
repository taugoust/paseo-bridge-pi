import { constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Stats } from "node:fs";

export class AccountFileRejected extends Error {
	constructor() { super("Selected account file rejected"); }
}
const fail = (): never => { throw new AccountFileRejected(); };
const same = (a: Stats, b: Stats, content = false) =>
	a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid &&
	(!content || (a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs));
const inStore = (path: string) => path.startsWith("/nix/store/");

/** Trusted-local, read-only resolution; never returns paths or OS errors to clients.
 * User-owned links and immutable Nix-store links may lead to a private user file.
 * Root-owned system directory links are also allowed (e.g. macOS /var).
 * Every traversed directory must resist replacement by another user. A root-owned
 * sticky directory is allowed for private temporary directories. Same-UID hostile
 * code is outside this boundary; Node does not offer an openat directory-fd walk.
 */
export async function readPrivateAccountJson(
	dir: string,
	file: "auth.json" | "pi-accounts.json" | "pi-usage.json",
): Promise<any> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		if (!isAbsolute(dir) || !process.getuid) fail();
		const uid = process.getuid();
		const directory = await lstat(dir);
		if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid || (directory.mode & 0o022)) fail();
		const snapshots = new Map<string, { stat: Stats; target?: string }>();
		const remember = (path: string, stat: Stats, target?: string) => {
			const prior = snapshots.get(path);
			if (prior && (!same(prior.stat, stat, !stat.isDirectory()) || prior.target !== target)) fail();
			snapshots.set(path, { stat, target });
		};
		let path = "/", links = 0;
		let parts = join(dir, file).split("/").filter(Boolean);
		remember("/", await lstat("/"));
		while (parts.length) {
			const part = parts.shift()!;
			if (part === ".") continue;
			if (part === "..") { path = dirname(path); continue; }
			const next = join(path, part);
			const stat = await lstat(next);
			if (stat.isSymbolicLink()) {
				if (++links > 32 || (stat.uid !== uid && !(stat.uid === 0 && (inStore(next) || parts.length > 0)))) fail();
				const target = await readlink(next);
				remember(next, stat, target);
				parts = [...target.split("/").filter(Boolean), ...parts];
				if (isAbsolute(target)) path = "/";
				continue;
			}
			if (parts.length) {
				const stickyRoot = stat.uid === 0 && Boolean(stat.mode & 0o1000);
				if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0) || ((stat.mode & 0o022) && !stickyRoot)) fail();
			}
			remember(next, stat);
			path = next;
		}
		const settings = file === "pi-usage.json";
		const expectedOwner = settings && inStore(path) ? 0 : uid;
		const valid = (stat: Stats) => stat.isFile() && stat.uid === expectedOwner &&
			!(stat.mode & (settings ? 0o022 : 0o077)) && stat.size <= 1024 * 1024;
		const final = snapshots.get(path)?.stat;
		if (!final || !valid(final)) fail();
		// Nonblocking also makes a file-to-FIFO replacement fail closed, not hang.
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = await handle.stat();
		if (!valid(opened) || !same(final, opened, true)) fail();
		const verify = async () => {
			for (const [name, previous] of snapshots) {
				const current = await lstat(name);
				if (!same(previous.stat, current, !current.isDirectory()) ||
					(previous.target !== undefined && await readlink(name) !== previous.target)) fail();
			}
			if (!same(opened, await handle!.stat(), true)) fail();
		};
		await verify();
		const buffer = Buffer.alloc(1024 * 1024 + 1);
		let size = 0;
		while (size < buffer.length) {
			const chunk = await handle.read(buffer, size, buffer.length - size, size);
			if (!chunk.bytesRead) break;
			size += chunk.bytesRead;
		}
		if (size > 1024 * 1024) fail();
		await verify();
		return JSON.parse(buffer.subarray(0, size).toString("utf8"));
	} catch {
		throw new AccountFileRejected();
	} finally {
		await handle?.close();
	}
}
