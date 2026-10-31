// Quota response mapping adapted from Paseo's codex-usage-source (Apache-2.0).
// See ../client/PASEO-LICENSE. Session binding and transport guards are bridge-specific.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { z } from "zod";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { quotaWindowDescriptors } from "@getpaseo/plugin/shared";
import {
	toneFromUsedPct,
	balanceToneFromRemaining,
	unavailable,
	windowFromReportedDuration,
	type UsageReport,
} from "@getpaseo/plugin/server/usage";
import { fetchCompanionUsage } from "./companion-usage";
import { accountControlsSnapshotSchema } from "../shared/account-controls";
import {
	callAccountControls,
	readAccountControlsDescriptor,
	validateAccountControlsDescriptor,
} from "./account-controls-transport";

const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const inputSchema = z
	.object({ agentId: z.string().min(1).max(256), handle: z.string().uuid() })
	.strict();
const windowSchema = z.object({
	used_percent: z.coerce.number().finite().nonnegative().nullish(),
	reset_at: z.coerce.number().finite().nonnegative().nullish(),
	limit_window_seconds: z.coerce.number().finite().nullish(),
});
const rateLimitSchema = z.object({
	primary_window: windowSchema.nullish(),
	secondary_window: windowSchema.nullish(),
});
const responseSchema = z.object({
	plan_type: z.string().max(256).optional(),
	rate_limit: rateLimitSchema.nullish(),
	additional_rate_limits: z
		.array(
			z.object({
				limit_name: z.string().max(256).optional(),
				metered_feature: z.string().max(256).optional(),
				rate_limit: rateLimitSchema.nullish(),
			}),
		)
		.max(100)
		.nullish(),
	code_review_rate_limit: rateLimitSchema.nullish(),
	credits: z
		.object({ balance: z.coerce.number().finite().optional() })
		.nullish(),
});
function usageWindows(
	rate: z.infer<typeof rateLimitSchema> | null | undefined,
	scope?: { id: string; label: string },
) {
	return quotaWindowDescriptors(rate, {
		scope,
		summary: !scope,
	}).map((window) =>
		windowFromReportedDuration({
			...window,
			tone: toneFromUsedPct(window.utilizationPct),
		}),
	);
}
const credentialSchema = z.object({
	type: z.literal("oauth").optional().default("oauth"),
	access: z.string().min(1).max(65536),
	expires: z.number().finite(),
	accountId: z.string().min(1).max(256).optional(),
});
const text = (value: unknown): string | undefined =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= 256 &&
	!/[\p{Cc}\p{Cf}]/u.test(value)
		? value
		: undefined;

async function readPrivateJson(
	dir: string,
	file: "auth.json" | "pi-accounts.json" | "pi-usage.json",
) {
	if (!isAbsolute(dir)) throw new Error("Invalid account directory");
	const directory = await lstat(dir);
	// Readable directory names are harmless; other users must not be able to replace files.
	if (
		!directory.isDirectory() ||
		directory.isSymbolicLink() ||
		directory.mode & 0o022 ||
		(process.getuid && directory.uid !== process.getuid())
	)
		throw new Error("Unsafe account directory");
	const settings = file === "pi-usage.json";
	const path = settings ? await realpath(join(dir, file)) : join(dir, file);
	const nixSettings = settings && path.startsWith("/nix/store/");
	const handle = await open(
		path,
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
	);
	try {
		const stat = await handle.stat();
		const max = 1024 * 1024;
		if (
			!stat.isFile() ||
			stat.mode & (settings ? 0o022 : 0o077) ||
			stat.size > max ||
			(process.getuid && stat.uid !== (nixSettings ? 0 : process.getuid()))
		)
			throw new Error("Unsafe account store");
		const buffer = Buffer.alloc(max + 1);
		let size = 0;
		while (size < buffer.length) {
			const read = await handle.read(buffer, size, buffer.length - size, size);
			if (!read.bytesRead) break;
			size += read.bytesRead;
		}
		if (size > max) throw new Error("Oversized account store");
		return JSON.parse(buffer.subarray(0, size).toString("utf8"));
	} finally {
		await handle.close();
	}
}

async function readCredential(
	dir: string,
	provider: "openai" | "openai-codex",
	name: string,
) {
	const store = await readPrivateJson(dir, "pi-accounts.json");
	if (
		store?.version !== 1 ||
		!Object.hasOwn(store?.providers?.[provider]?.accounts ?? {}, name)
	)
		throw new Error("Missing selected account");
	return credentialSchema.parse(store.providers[provider].accounts[name]);
}
async function readDefaultCredential(
	dir: string,
	provider: "openai" | "openai-codex",
) {
	const auth = await readPrivateJson(dir, "auth.json");
	return credentialSchema.parse(auth[provider]);
}

type UnavailableReason =
	| "default-oauth"
	| "api-key"
	| "identity"
	| "companion-disabled";
class UsageUnavailable extends Error {
	readonly reason: UnavailableReason;
	constructor(reason: UnavailableReason) {
		super(reason);
		this.reason = reason;
	}
}

function parseAccountControlsUsageSnapshot(value: unknown) {
	// The private service snapshot also carries session-routing metadata; it is
	// not part of the public account/usage contract parsed by this consumer.
	if (!value || typeof value !== "object" || Array.isArray(value))
		return accountControlsSnapshotSchema.parse(value);
	const { sessionRouting: _routing, guardedDefaultSwitchVersion: _guardedSwitch, ...snapshot } = value as Record<
		string,
		unknown
	>;
	return accountControlsSnapshotSchema.parse(snapshot);
}

async function selection(agentId: string, provider: "openai" | "openai-codex" = "openai") {
	const descriptor = await readAccountControlsDescriptor(agentId);
	if (!validateAccountControlsDescriptor(descriptor, agentId))
		throw new Error("Selection unavailable");
	const snapshot = parseAccountControlsUsageSnapshot(
		await callAccountControls(descriptor, {
			operation: "snapshot",
			sessionId: descriptor.sessionId,
			...(provider === "openai-codex" ? { providerId: provider } : {}),
		}),
	);
	const current = await readAccountControlsDescriptor(agentId);
	if (
		!validateAccountControlsDescriptor(current, agentId) ||
		JSON.stringify(current) !== JSON.stringify(descriptor) ||
		snapshot.sessionId !== descriptor.sessionId ||
		snapshot.serviceEpoch !== descriptor.serviceEpoch
	)
		throw new Error("Selection changed");
	if (
		(snapshot.providerId ?? "openai") !== provider ||
		(provider === "openai-codex" &&
			!snapshot.supportedProviders?.includes("openai-codex"))
	)
		throw new Error("Provider selection unavailable");
	if (provider === "openai-codex") {
		if (
			snapshot.usage.status !== "local-binding-confirmed" ||
			!snapshot.usage.accountKey ||
			(snapshot.defaultSelected
				? snapshot.usage.effectiveCredential !== "chatgpt-grant-configured"
				: snapshot.usage.effectiveCredential !== "chatgpt-grant-matched-refreshed" ||
					!snapshot.currentAccountId ||
					snapshot.activationStatus !== "active")
		)
			throw new Error("No verified Codex OAuth binding");
		const account = snapshot.defaultSelected
			? undefined
			: snapshot.accounts.find(
					(item) =>
						item.id === snapshot.currentAccountId && item.authKind === "oauth",
					);
		if (!snapshot.defaultSelected && !account)
			throw new Error("Selected Codex account unavailable");
		return { descriptor, snapshot, account };
	}
	if (
		snapshot.usage.nativeRegistrationKey &&
		snapshot.usage.status === "local-binding-confirmed" &&
		(snapshot.defaultSelected || snapshot.activationStatus === "active")
	) {
		return {
			descriptor,
			snapshot,
			account: snapshot.accounts.find(
				(item) =>
					item.id === snapshot.currentAccountId && item.authKind === "oauth",
			),
		};
	}
	if (
		snapshot.defaultSelected &&
		snapshot.usage.status === "local-binding-confirmed" &&
		snapshot.usage.effectiveCredential === "chatgpt-grant-configured"
	)
		throw new UsageUnavailable(
			snapshot.usage.nativeRegistrationVersion === 1
				? "identity"
				: "default-oauth",
		);
	if (snapshot.usage.effectiveCredential === "api-key-configured")
		throw new UsageUnavailable("api-key");
	if (
		snapshot.usage.status === "local-binding-confirmed" &&
		!snapshot.usage.accountKey
	)
		throw new UsageUnavailable("identity");
	if (
		snapshot.defaultSelected ||
		!snapshot.currentAccountId ||
		snapshot.activationStatus !== "active" ||
		snapshot.usage.status !== "local-binding-confirmed" ||
		snapshot.usage.effectiveCredential !== "chatgpt-grant-matched-refreshed" ||
		!snapshot.usage.accountKey
	)
		throw new Error("No verified named OAuth binding");
	const account = snapshot.accounts.find(
		(item) =>
			item.id === snapshot.currentAccountId && item.authKind === "oauth",
	);
	if (!account) throw new Error("Selected account unavailable");
	return { descriptor, snapshot, account };
}

async function binding(agentId: string, dir: string) {
	const before = await selection(agentId);
	if (before.snapshot.usage.nativeRegistrationKey)
		return companionBinding(agentId, dir, before);
	if (!before.account) throw new Error("Selected account unavailable");
	const credential = await readCredential(dir, "openai", before.account.id);
	const after = await selection(agentId);
	const again = await readCredential(dir, "openai", before.account.id);
	if (
		JSON.stringify(before.descriptor) !== JSON.stringify(after.descriptor) ||
		before.snapshot.selectionRevision !== after.snapshot.selectionRevision ||
		before.account.id !== after.account?.id ||
		credential.access !== again.access ||
		credential.expires !== again.expires ||
		credential.accountId !== again.accountId
	)
		throw new Error("Binding changed");
	const claims = JSON.parse(
		Buffer.from(credential.access.split(".")[1] ?? "", "base64url").toString(
			"utf8",
		),
	);
	const claimId =
		text(claims?.["https://api.openai.com/auth"]?.chatgpt_account_id) ??
		text(claims?.chatgpt_account_id);
	if (claimId && credential.accountId && claimId !== credential.accountId)
		throw new Error("Conflicting account identity");
	const accountId = claimId ?? credential.accountId;
	const subject = text(
		claims?.sub ?? claims?.["https://api.openai.com/auth"]?.chatgpt_user_id,
	);
	const accountKey = hash(JSON.stringify(["openai", accountId, subject]));
	if (
		!accountId ||
		!subject ||
		before.snapshot.usage.accountKey !== accountKey ||
		after.snapshot.usage.accountKey !== before.snapshot.usage.accountKey
	)
		throw new Error("Account identity unavailable");
	const label =
		text(claims?.["https://api.openai.com/profile"]?.email) ??
		text(claims?.email) ??
		before.account.label;
	// Credential-derived fingerprint stays private; public locators contain only a random handle.
	const fingerprint = hash(
		JSON.stringify([
			dir,
			before.descriptor,
			before.snapshot.selectionRevision,
			before.account.id,
			credential,
		]),
	);
	return {
		credential,
		accountId,
		label,
		fingerprint,
		key: accountKey,
		clientId: undefined as string | undefined,
	};
}

const nativeSchema = credentialSchema.extend({
	clientId: z.string().min(1).max(512),
	scopes: z
		.array(z.string())
		.refine((scopes) => scopes.includes("chatgpt.tokens.use.direct")),
});
async function companionBinding(
	agentId: string,
	dir: string,
	before: Awaited<ReturnType<typeof selection>>,
) {
	let settings;
	try {
		settings = await readPrivateJson(dir, "pi-usage.json");
	} catch {
		throw new UsageUnavailable("companion-disabled");
	}
	if (settings.openaiUseCodexUsage !== true)
		throw new UsageUnavailable("companion-disabled");
	const load = async () => {
		const auth = await readPrivateJson(dir, "auth.json");
		const rawNative = before.snapshot.defaultSelected
			? auth.openai
			: (await readPrivateJson(dir, "pi-accounts.json"))?.providers?.openai
					?.accounts?.[before.snapshot.currentAccountId!];
		const native = nativeSchema.parse(rawNative);
		const credential = credentialSchema.parse(auth["openai-codex"]);
		const nativeClaims = JSON.parse(
			Buffer.from(native.access.split(".")[1] ?? "", "base64url").toString(
				"utf8",
			),
		);
		const subject = text(nativeClaims?.sub);
		if (
			!subject ||
			hash(JSON.stringify(["openai-native", native.clientId, subject])) !==
				before.snapshot.usage.nativeRegistrationKey
		)
			throw new Error("Native registration changed");
		const claims = JSON.parse(
			Buffer.from(credential.access.split(".")[1] ?? "", "base64url").toString(
				"utf8",
			),
		);
		const accountId = text(
			claims?.["https://api.openai.com/auth"]?.chatgpt_account_id,
		);
		if (!accountId || credential.accountId !== accountId)
			throw new Error("Invalid companion account");
		if (native.expires <= Date.now() || credential.expires <= Date.now())
			throw new Error("Companion or native login expired");
		return {
			native,
			credential,
			accountId,
			label:
				text(claims?.["https://api.openai.com/profile"]?.email) ??
				text(claims?.email),
		};
	};
	const first = await load();
	const after = await selection(agentId);
	const second = await load();
	if (
		JSON.stringify(before.descriptor) !== JSON.stringify(after.descriptor) ||
		before.snapshot.selectionRevision !== after.snapshot.selectionRevision ||
		before.snapshot.currentAccountId !== after.snapshot.currentAccountId ||
		before.snapshot.usage.nativeRegistrationKey !==
			after.snapshot.usage.nativeRegistrationKey ||
		JSON.stringify(first) !== JSON.stringify(second) ||
		(await readPrivateJson(dir, "pi-usage.json")).openaiUseCodexUsage !== true
	)
		throw new Error("Companion binding changed");
	return {
		credential: first.credential,
		accountId: first.accountId,
		label: first.label ?? "Codex companion",
		clientId: first.native.clientId,
		key: hash(
			JSON.stringify([
				"openai-companion",
				before.snapshot.usage.nativeRegistrationKey,
				first.accountId,
			]),
		),
		fingerprint: hash(
			JSON.stringify([
				dir,
				before.descriptor,
				before.snapshot.selectionRevision,
				first,
			]),
		),
	};
}

async function codexBinding(agentId: string, dir: string) {
	const before = await selection(agentId, "openai-codex");
	const load = async () =>
		before.snapshot.defaultSelected
			? readDefaultCredential(dir, "openai-codex")
			: readCredential(dir, "openai-codex", before.account!.id);
	const credential = await load();
	const after = await selection(agentId, "openai-codex");
	const again = await load();
	if (
		JSON.stringify(before.descriptor) !== JSON.stringify(after.descriptor) ||
		before.snapshot.selectionRevision !== after.snapshot.selectionRevision ||
		before.snapshot.currentAccountId !== after.snapshot.currentAccountId ||
		before.snapshot.defaultSelected !== after.snapshot.defaultSelected ||
		credential.access !== again.access ||
		credential.expires !== again.expires ||
		credential.accountId !== again.accountId
	)
		throw new Error("Codex binding changed");
	const claims = JSON.parse(
		Buffer.from(credential.access.split(".")[1] ?? "", "base64url").toString(
			"utf8",
		),
	);
	const claimId =
		text(claims?.["https://api.openai.com/auth"]?.chatgpt_account_id) ??
		text(claims?.chatgpt_account_id);
	if (claimId && credential.accountId && claimId !== credential.accountId)
		throw new Error("Conflicting Codex account identity");
	const accountId = claimId ?? credential.accountId;
	const subject = text(
		claims?.sub ?? claims?.["https://api.openai.com/auth"]?.chatgpt_user_id,
	);
	const key = hash(JSON.stringify(["openai-codex", accountId, subject]));
	if (
		!accountId ||
		!subject ||
		before.snapshot.usage.accountKey !== key ||
		after.snapshot.usage.accountKey !== key
	)
		throw new Error("Codex account identity unavailable");
	return {
		credential,
		accountId,
		label:
			text(claims?.["https://api.openai.com/profile"]?.email) ??
			text(claims?.email) ??
			before.account?.label ??
			"Codex",
			fingerprint: hash(
				JSON.stringify([
					dir,
					before.descriptor,
					before.snapshot.selectionRevision,
					before.snapshot.currentAccountId,
					before.snapshot.defaultSelected,
					credential,
				]),
			),
		key,
		clientId: undefined as string | undefined,
	};
}

type Locator = {
	handle: string;
	dir: string;
	provider: "openai" | "openai-codex";
	fingerprint: string;
	touched: number;
	verified: boolean;
	reason?: UnavailableReason;
};
const missing = (reason?: UnavailableReason) =>
	unavailable({
		kind: "no_quota",
		detail:
			reason === "default-oauth"
				? "Reload Pi to publish the native registration proof required for companion usage."
				: reason === "companion-disabled"
					? "Companion usage is off. Enable openaiUseCodexUsage in pi-usage.json only for matching OpenAI/Codex accounts and workspaces."
					: reason === "api-key"
						? "Subscription quota is unavailable for an API-key login. Use OpenAI's usage settings for billing usage."
						: reason === "identity"
							? "The current model's native OpenAI registration could not be verified. Custom authentication/origins or an unavailable grant cannot use companion quotas."
							: "The current Pi account service or binding is unavailable. No other login's usage is substituted.",
	});

/** Read-only, session-selected OAuth quota. Never refreshes or switches credentials. */
export function registerSessionAccountUsage(server: PluginServerContext) {
	const locators = new Map<string, Locator>();
	const locatorKey = (agentId: string, provider: Locator["provider"]) =>
		JSON.stringify([agentId, provider]);
	server.registerUsageSource({
		id: "pi-selected-openai",
		label: "OpenAI / Codex",
		input: inputSchema,
		async discover(scope) {
			if (
				scope.kind !== "session" ||
				scope.provider !== "pi" ||
				!/^(openai|idle-guard|openai-codex)\//.test(scope.model ?? "")
			)
				return [];
			const agentId = scope.env.PASEO_AGENT_ID;
			if (!agentId) return [];
			const dir =
				scope.env.PI_CODING_AGENT_DIR ||
				join(scope.env.HOME || homedir(), ".pi", "agent");
			for (const [id, item] of locators)
				if (Date.now() - item.touched > 30 * 60_000) locators.delete(id);
			const provider = scope.model?.startsWith("openai-codex/")
				? "openai-codex"
				: "openai";
			let found: Awaited<ReturnType<typeof binding>> | Awaited<ReturnType<typeof codexBinding>> | undefined;
			let reason: UnavailableReason | undefined;
			try {
				found = provider === "openai-codex"
					? await codexBinding(agentId, dir)
					: await binding(agentId, dir);
			} catch (error) {
				if (error instanceof UsageUnavailable) reason = error.reason;
			}
			const fingerprint =
				found?.fingerprint ?? `unavailable:${dir}:${reason ?? "binding"}`;
			const key = locatorKey(agentId, provider);
			const previous = locators.get(key);
			const locator: Locator =
				previous?.fingerprint === fingerprint
					? previous
					: {
							handle: randomUUID(),
							dir,
							provider,
							fingerprint,
							touched: Date.now(),
							verified: Boolean(found),
							reason,
						};
			locator.touched = Date.now();
			locators.delete(key);
			locators.set(key, locator);
			while (locators.size > 1000)
				locators.delete(locators.keys().next().value!);
			return [
				{
					key: found?.key ?? hash(`unavailable\0${agentId}`),
					...(found ? { label: found.label } : {}),
					harness: "Pi",
					sessionOnly: !found || Boolean(found.clientId),
					input: { agentId, handle: locator.handle },
				},
			];
		},
		async fetch(raw): Promise<UsageReport> {
			try {
				const input = inputSchema.parse(raw);
				const locator = (["openai", "openai-codex"] as const)
					.map((provider) => locators.get(locatorKey(input.agentId, provider)))
					.find((item) => item?.handle === input.handle);
				if (!locator) return missing();
				if (!locator.verified) return missing(locator.reason);
				const check = async () => {
					const current =
						locator.provider === "openai-codex"
							? await codexBinding(input.agentId, locator.dir)
							: await binding(input.agentId, locator.dir);
					if (
						locators.get(locatorKey(input.agentId, locator.provider)) !== locator ||
						current.fingerprint !== locator.fingerprint
					)
						throw new Error("Binding changed");
					return current;
				};
				const current = await check();
				if (current.clientId)
					return await fetchCompanionUsage(
						{
							clientId: current.clientId,
							access: current.credential.access,
							accountId: current.accountId,
						},
						async () => {
							await check();
						},
					);
				if (current.credential.expires <= Date.now())
					return unavailable({
						kind: "expired",
						expiresAt: new Date(current.credential.expires).toISOString(),
						refreshedBy: "Pi account login",
					});
				const response = await fetch(
					"https://chatgpt.com/backend-api/wham/usage",
					{
						headers: {
							Authorization: `Bearer ${current.credential.access}`,
							Accept: "application/json",
							"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
							"ChatGPT-Account-Id": current.accountId,
						},
						redirect: "error",
						signal: AbortSignal.timeout(8000),
					},
				);
				await check();
				if (response.status === 401 || response.status === 403) {
					await response.body?.cancel();
					return unavailable({
						kind: "rejected",
						status: response.status,
						refreshedBy: "Pi account login",
					});
				}
				if (!response.ok) {
					await response.body?.cancel();
					throw new Error("Quota service unavailable");
				}
				const reader = response.body?.getReader();
				if (!reader) throw new Error("Missing quota response");
				const chunks: Uint8Array[] = [];
				let size = 0;
				try {
					while (true) {
						const chunk = await reader.read();
						if (chunk.done) break;
						size += chunk.value.length;
						if (size > 256 * 1024) throw new Error("Oversized quota response");
						chunks.push(chunk.value);
					}
				} finally {
					await reader.cancel().catch(() => {});
				}
				const body = responseSchema.parse(
					JSON.parse(Buffer.concat(chunks).toString("utf8")),
				);
				await check();
				const windows = [
					...usageWindows(body.rate_limit),
					...(body.additional_rate_limits ?? []).flatMap((limit) => {
						const identity = limit.metered_feature || limit.limit_name;
						return identity
							? usageWindows(limit.rate_limit, {
									id: `limit:${encodeURIComponent(identity)}`,
									label: limit.limit_name || identity,
								})
							: [];
					}),
					...usageWindows(body.code_review_rate_limit, {
						id: "code_review",
						label: "Code review",
					}),
				];
				const balance = body.credits?.balance;
				if (!windows.length && balance === undefined)
					return unavailable({
						kind: "no_quota",
						detail: "The selected account returned no quota information.",
					});
				return {
					status: "available",
					planLabel: body.plan_type,
					windows,
					balances:
						balance === undefined
							? []
							: [
									{
										id: "credits",
										label: "Credits",
										remaining: balance,
										unit: "credits",
										tone: balanceToneFromRemaining(balance),
									},
								],
				};
			} catch (error) {
				return error instanceof UsageUnavailable
					? missing(error.reason)
					: {
							status: "error",
							error:
								"Could not read usage for the selected Pi account. No fallback login was used.",
						};
			}
		},
	});
}
