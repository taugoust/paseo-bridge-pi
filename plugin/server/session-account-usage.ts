// Quota response mapping adapted from Paseo's codex-usage-source (Apache-2.0).
// See ../client/PASEO-LICENSE. Session binding and transport guards are bridge-specific.
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { AccountFileRejected, readPrivateAccountJson as readPrivateJson } from "./private-account-json";
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
import { ACCOUNT_PROVIDER_ID, accountControlsSnapshotSchema } from "../shared/account-controls";
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

const PROVIDER = ACCOUNT_PROVIDER_ID;
async function readCredential(dir: string, name: string) {
	const store = await readPrivateJson(dir, "pi-accounts.json");
	if (
		store?.version !== 1 ||
		!Object.hasOwn(store?.providers?.[PROVIDER]?.accounts ?? {}, name)
	)
		throw new Error("Missing selected account");
	return credentialSchema.parse(store.providers[PROVIDER].accounts[name]);
}
async function readDefaultCredential(dir: string) {
	const auth = await readPrivateJson(dir, "auth.json");
	return credentialSchema.parse(auth[PROVIDER]);
}

type UnavailableReason = "account-file" | "account-service" | "binding-changed";
class UsageUnavailable extends Error {
	readonly reason: UnavailableReason;
	constructor(reason: UnavailableReason) {
		super(reason);
		this.reason = reason;
	}
}

async function selection(agentId: string) {
	const descriptor = await readAccountControlsDescriptor(agentId);
	if (!validateAccountControlsDescriptor(descriptor, agentId))
		throw new UsageUnavailable("account-service");
	const snapshot = accountControlsSnapshotSchema.parse(
		await callAccountControls(descriptor, {
			operation: "snapshot",
			sessionId: descriptor.sessionId,
			providerId: PROVIDER,
		}).catch(() => {
			throw new UsageUnavailable("account-service");
		}),
	);
	const current = await readAccountControlsDescriptor(agentId);
	if (
		!validateAccountControlsDescriptor(current, agentId) ||
		JSON.stringify(current) !== JSON.stringify(descriptor) ||
		snapshot.sessionId !== descriptor.sessionId ||
		snapshot.serviceEpoch !== descriptor.serviceEpoch
	)
		throw new UsageUnavailable("binding-changed");
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
				(item) => item.id === snapshot.currentAccountId && item.authKind === "oauth",
			);
	if (!snapshot.defaultSelected && !account)
		throw new Error("Selected Codex account unavailable");
	return { descriptor, snapshot, account };
}

async function codexBinding(agentId: string, dir: string) {
	const before = await selection(agentId);
	const load = async () =>
		before.snapshot.defaultSelected
			? readDefaultCredential(dir)
			: readCredential(dir, before.account!.id);
	const credential = await load();
	const after = await selection(agentId);
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
		throw new UsageUnavailable("binding-changed");
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
	const key = hash(JSON.stringify([PROVIDER, accountId, subject]));
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
	};
}

type Locator = {
	handle: string;
	dir: string;
	fingerprint: string;
	touched: number;
	verified: boolean;
	reason?: UnavailableReason;
};
const missing = (reason?: UnavailableReason) =>
	unavailable({
		kind: "no_quota",
		detail:
			reason === "account-file"
				? "The selected account's local authentication file was rejected or could not be read safely. No fallback login was used."
				: reason === "account-service"
					? "The current Pi account service is unavailable. No fallback login was used."
					: reason === "binding-changed"
						? "The selected account binding changed. Refresh usage for the current selection."
						: "The selected Pi account binding could not be verified. No other login's usage is substituted.",
	});

/**
 * Read-only quota for the session-selected Codex account. Only Pi sessions on
 * openai-codex/ models are reported; other providers, including the built-in
 * openai provider, get no source. Never refreshes or switches credentials.
 */
export function registerSessionAccountUsage(server: PluginServerContext) {
	const locators = new Map<string, Locator>();
	server.registerUsageSource({
		id: "pi-selected-codex",
		label: "Codex",
		input: inputSchema,
		async discover(scope) {
			if (
				scope.kind !== "session" ||
				scope.provider !== "pi" ||
				!scope.model?.startsWith(`${PROVIDER}/`)
			)
				return [];
			const agentId = scope.env.PASEO_AGENT_ID;
			if (!agentId) return [];
			const dir =
				scope.env.PI_CODING_AGENT_DIR ||
				join(scope.env.HOME || homedir(), ".pi", "agent");
			for (const [id, item] of locators)
				if (Date.now() - item.touched > 30 * 60_000) locators.delete(id);
			let found: Awaited<ReturnType<typeof codexBinding>> | undefined;
			let reason: UnavailableReason | undefined;
			try {
				found = await codexBinding(agentId, dir);
			} catch (error) {
				if (error instanceof UsageUnavailable) reason = error.reason;
				else if (error instanceof AccountFileRejected) reason = "account-file";
			}
			const fingerprint =
				found?.fingerprint ?? `unavailable:${dir}:${reason ?? "binding"}`;
			const previous = locators.get(agentId);
			const locator: Locator =
				previous?.fingerprint === fingerprint
					? previous
					: {
							handle: randomUUID(),
							dir,
							fingerprint,
							touched: Date.now(),
							verified: Boolean(found),
							reason,
						};
			locator.touched = Date.now();
			locators.delete(agentId);
			locators.set(agentId, locator);
			while (locators.size > 1000)
				locators.delete(locators.keys().next().value!);
			return [
				{
					key: found?.key ?? hash(`unavailable\0${agentId}`),
					...(found ? { label: found.label } : {}),
					harness: "Pi",
					sessionOnly: !found,
					input: { agentId, handle: locator.handle },
				},
			];
		},
		async fetch(raw): Promise<UsageReport> {
			try {
				const input = inputSchema.parse(raw);
				const locator = locators.get(input.agentId);
				if (!locator || locator.handle !== input.handle) return missing();
				if (!locator.verified) return missing(locator.reason);
				const check = async () => {
					const current = await codexBinding(input.agentId, locator.dir);
					if (
						locators.get(input.agentId) !== locator ||
						current.fingerprint !== locator.fingerprint
					)
						throw new UsageUnavailable("binding-changed");
					return current;
				};
				const current = await check();
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
				return error instanceof AccountFileRejected
					? missing("account-file")
					: error instanceof UsageUnavailable
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
