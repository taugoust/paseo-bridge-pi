import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { cp, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
const require = createRequire(import.meta.url),
	root = fileURLToPath(new URL("../", import.meta.url));
const nodes = (x) =>
	!x || typeof x !== "object"
		? []
		: [x, ...[x.props?.children].flat(Infinity).flatMap(nodes)];
const text = (x) =>
	typeof x === "number"
		? String(x)
		: typeof x === "string"
			? x
			: !x || typeof x !== "object"
				? ""
				: [x.props?.children].flat(Infinity).map(text).join(" ");
test("explicit dormant Activity retains meters and isolation without retired workspace Accounts", {
	skip: !process.env.PASEO_PLUGIN_COMPILER,
}, async () => {
	const { compilePlugin } = await import(
		pathToFileURL(resolve(process.env.PASEO_PLUGIN_COMPILER))
	);
	// Compile the real dormant modules in an explicit temporary plugin, preserving
	// the compiler's client/shared boundary rather than re-enabling shipped UI.
	const fixture = await mkdtemp(resolve(tmpdir(), "paseo-observability-"));
	let clientBundle;
	try {
		await cp(resolve(root, "client"), resolve(fixture, "client"), { recursive: true });
		await cp(resolve(root, "shared"), resolve(fixture, "shared"), { recursive: true });
		await writeFile(resolve(fixture, "index.client.tsx"), await readFile(resolve(root, "test/fixtures/observability-legacy.client.tsx")));
		({ clientBundle } = await compilePlugin({ client: resolve(fixture, "index.client.tsx") }));
	} finally { await rm(fixture, { recursive: true, force: true }); }
	let panel,
		observers = [],
		agentSubscriptions = [],
		signals = [],
		accountSubscription,
		subscriptionCount = 0,
		signal,
		pill,
		header,
		headers = [],
		removed = false,
		hook = 0,
		refreshes = 0;
	const states = [],
		effects = [],
		queries = [],
		calls = [];
	const identity = {
		available: true,
		sessionId: "session",
		runtimeEpoch: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
	};
	let status = { data: identity };
	const accountSnapshot = { protocol: 1, serviceEpoch: "service-1", selectionRevision: 0, sessionId: "session", providerId: "openai-codex", accounts: [{ id: "named-1", label: "Work", authKind: "oauth" }], currentAccountId: null, defaultSelected: true, activationStatus: "active", busy: false, canSwitch: true, usage: { effectiveCredential: "unknown", status: "unknown", remoteEntitlement: "not-queried", settingsUrl: "https://chatgpt.com/settings/usage" } };
	let accountStatus = { data: { available: true, sessionId: "session", runtimeEpoch: identity.runtimeEpoch, snapshot: accountSnapshot, reason: null }, isError: false }, switchCalls = [], switchResult = { ok: true, requestId: "00000000-0000-4000-8000-000000000001", snapshot: accountSnapshot }, switchReject = false, updatedAt = 100, openedUrls = [], statusResponseGates = [];
	const snap = (feature, data) => ({
		data: {
			protocol: 1,
			state: "available",
			sessionId: "session",
			feature,
			lastUpdated: null,
			stale: false,
			data,
		},
	});
	const results = {
		progress: snap("progress", {
			steps: [
				{ text: "Shipped", status: "completed" },
				{ text: "Approve review", status: "blocked" },
				{ text: "Implement UI", status: "in_progress" },
				{ text: "Follow up", status: "pending" },
				{ text: "Later", status: "pending" },
			],
		}),
		stamp: snap("stamp", {
			records: [
				{
					id: "r",
					role: "assistant",
					timestamp: 1,
					completedAt: 1001,
					provider: "openai",
					model: "gpt-6-astra",
					thinking: "low",
					outcome: "stop",
					usage: { input: 1234, output: 10, estimatedCost: 0.1 },
				},
			],
		}),
		cache: snap("cache", {
			streaming: false,
			requestNumber: 1,
			latest: {
				provider: "openai",
				model: "gpt-6-astra",
				hitRatePercent: 75,
				input: 250,
				cacheRead: 750,
				cacheWrite: 0,
			},
			comparison: {
				requestStartGapMs: 2000,
				rebilledTokens: 0,
				estimatedMissPremium: 0,
			},
			session: {
				requestCount: 2,
				promptTokens: 2000,
				hitRatePercent: 75,
				promptCost: 0.1,
				estimatedSavings: 0.02,
			},
			trend: [70, 75],
		}),
	};
	const jsx = (type, props, key) => {
		assert.ok(
			typeof type === "string" || typeof type === "function",
			`Missing host component ${type}`,
		);
		return typeof type === "function" ? type(props) : { type, props, key };
	};
	const load = (name) => {
		if (name === "@getpaseo/plugin") return { defineRpc: (x) => x };
		if (name === "@getpaseo/plugin/client")
			return {
				useRpc: (contract) => async (input) => {
					contract.input.parse(input);
					calls.push({ contract, input });
					if (contract.name === "account_controls_status") { const data=accountStatus.data; const gate=statusResponseGates.shift(); if(gate) await gate.wait; return data; }
					if (contract.name === "account_controls_switch") { switchCalls.push(input); if (switchReject) throw new Error("socket timed out"); return switchResult; }
					return {};
				},
			};
		if (name === "@getpaseo/plugin/client/ui")
			return {
				SettingsSection: (props) => ({
					type: "SettingsSection",
					props: {
						...props,
						children: [props.title, props.trailing, props.children],
					},
				}),
				SettingsCard: (props) => ({ type: "SettingsCard", props }),
				SettingsSelect: (props) => ({ type: "SettingsSelect", props }),
			};
		if (name === "@getpaseo/plugin/client/react-native")
			return { ScrollView: "ScrollView" };
		if (name === "react-native")
			return { Text: "Text", View: "View", Pressable: "Pressable", Linking: { openURL: async url => openedUrls.push(url) } };
		if (name === "react/jsx-runtime")
			return { jsx, jsxs: jsx, Fragment: "Fragment" };
		if (name === "react")
			return {
				useEffect: (effect) => { const cleanup = effect(); if (typeof cleanup === "function") effects.push(cleanup); },
				useState: (initial) => {
					const index = hook++;
					if (!(index in states)) states[index] = initial;
					return [states[index], (value) => (states[index] = typeof value === "function" ? value(states[index]) : value)];
				},
			};
		if (name === "@tanstack/react-query")
			return {
				useQuery: (options) => {
					queries.push(options);
					if (options.queryKey[0] === "pi-account-controls") void options.queryFn();
					return {
						isPending: false,
						isError: false,
						refetch: async () => {
							refreshes++;
							if(options.queryKey[0]==="pi-account-controls") {
								const data=await options.queryFn(); updatedAt++;
								return {data,isError:accountStatus.isError,dataUpdatedAt:updatedAt};
							}
							return { data: options.queryKey[0] === "pi-activity-identity" ? status.data : results[options.queryKey.at(-1)]?.data, isError: false, dataUpdatedAt: updatedAt };
						},
						dataUpdatedAt: updatedAt,
						...(options.queryKey[0]==="pi-account-controls"?{isError:accountStatus.isError}:{}),
						...(options.queryKey[0] === "pi-activity-identity"
							? status
							: options.queryKey[0] === "pi-account-controls" ? accountStatus : results[options.queryKey.at(-1)]),
					};
				},
			};
		return require(name);
	};
	const contribute = (0, eval)(clientBundle)(load).default;
	const stop = contribute({
		rpc: async () => ({ available: false }),
		paseo: {
			config: { get: async () => ({ config: { plugins: { "paseo-accounts": { enabled: false } } } }) },
			agents: {
				list: async (o) => {
					signal = o.signal;
					signals.push(o.signal);
					return { subscription: { subscribe: (x) => { agentSubscriptions.push(x); /* Exact-chat/background registration is covered separately; do not mistake its subscription for the dormant workspace picker. */ if (o.includeBackground) return; subscriptionCount++; if (subscriptionCount <= 2) observers.push(x); else accountSubscription = x; } } };
				},
			},
		},
		addScreen: () => () => {},
		openScreen() {},
		addWorkspacePanel: (p) => {
			if (p.id === "pi-activity") panel = p;
			return () => { if (p.id === "pi-activity") removed = true; };
		},
		addHeaderButton: (p) => { header = { ...p, remove() { this.removed = true; }, update() {} }; headers.push(header); return header; },
		addComposerPill: (p) => {
			const registered = { ...p, remove() { this.removed = true; }, update() {} };
			if (p.id === "pi-activity" && p.agentId === "agent") pill = registered;
			return registered;
		},
		openPanel() {},
	});
	const colors = {
		foreground: "#fff",
		foregroundMuted: "#aaa",
		statusDanger: "#f00",
		statusWarning: "#fa0",
		statusSuccess: "#0f0",
		accent: "#08f",
		surface0: "#111",
		surface1: "#222",
		surface2: "#333",
		border: "#444",
	};
	const props = {
		agentId: "agent",
		workspaceId: "workspace",
		host: { id: "host" },
		theme: { colors },
	};
	const render = () => {
		queries.length = 0;
		hook = 0;
		return panel.Component(props);
	};
	const press = (tree, label) => {
		const node = nodes(tree).find(
			(n) => n.type === "Pressable" && n.props.accessibilityLabel === label,
		);
		assert.ok(node, label);
		node.props.onPress();
	};
	try {
		await new Promise((r) => setImmediate(r));
		for (const observer of observers) observer.snapshot({ entries: [
			{ agent: { id: "agent", workspaceId: "workspace", provider: "pi" } },
			{ agent: { id: "second-agent", name: "Second", workspaceId: "workspace", provider: "pi" } },
		] });
		assert.equal(pill.id, "pi-activity");
		assert.equal(pill.agentId, "agent");
		assert.equal(headers.length, 0, "retired workspace Accounts never registers, even with paseo-accounts disabled");
		let tree = render();
		assert.equal(
			nodes(tree).filter((n) => n.type === "SettingsSection").length,
			3,
		);
		assert.equal(queries.length, 4);
		assert.match(text(tree), /Approve review/);
		assert.match(text(tree), /Observed cache accounting/);
		assert.match(text(tree), /gpt-6-astra/);
		assert.match(text(tree), /1\s*\/\s*5\s*complete/);
		assert.doesNotMatch(text(tree), /Input tokens/);
		assert.equal(
			nodes(tree).filter((n) => n.props?.accessibilityRole === "tab").length,
			0,
		);
		const meters = nodes(tree).filter(
			(n) => n.props?.accessibilityRole === "progressbar",
		);
		assert.deepEqual(
			meters.map((n) => n.props.accessibilityValue.now),
			[20, 75],
		);
		assert.ok(
			text(tree).indexOf("Implement UI") < text(tree).indexOf("Approve review"),
		);
		press(tree, "Cache details");
		tree = render();
		assert.match(text(tree), /Session requests/);
		assert.match(text(tree), /Request gap/);
		press(tree, "Response details r");
		tree = render();
		assert.match(text(tree), /Input tokens/);
		assert.match(text(tree), /1,234/);
		assert.doesNotMatch(text(tree), /Shipped/);
		press(tree, "Show all 5 steps");
		tree = render();
		assert.match(text(tree), /Shipped/);
		press(tree, "Refresh");
		assert.equal(refreshes, 4);
		for (const query of queries.slice(1,4)) {
			assert.equal(query.queryKey[1], "host");
			await query.queryFn();
		}
		assert.deepEqual(
			calls.map((c) => c.input.feature),
			["progress", "cache", "stamp"],
		);
		assert.doesNotMatch(text(tree), /Account|Usage/);
		assert.equal(nodes(tree).filter((n) => n.type === "SettingsSection").map(n => n.props.title).join(","), "Progress,Cache,Recent responses");

		assert.ok(calls.filter(c=>c.input.feature).every((c) => c.input.expectedSessionId === "session"));
		results.progress.isError = true;
		tree = render();
		assert.doesNotMatch(text(tree), /Approve review/);
		assert.match(text(tree), /gpt-6-astra/);
		delete results.progress.isError;
		results.cache = snap("cache", {
			...results.cache.data.data,
			latest: null,
			comparison: null,
			trend: [],
			session: { ...results.cache.data.data.session, hitRatePercent: null },
		});
		tree = render();
		const unknown = nodes(tree).find(
			(n) => n.props?.accessibilityLabel === "Cache hit rate",
		);
		assert.equal(unknown.props.accessibilityValue.now, undefined);
		assert.equal(unknown.props.accessibilityValue.text, "Unavailable");
		status = {
			data: {
				...identity,
				sessionId: "new-session",
				runtimeEpoch: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
			},
		};
		tree = render();
		assert.doesNotMatch(text(tree), /Approve review|gpt-6-astra/);
		assert.ok(nodes(tree).some((n) => n.key?.includes("new-session:bbbbbbbb")));
		status = { data: identity, isError: true };
		tree = render();
		assert.doesNotMatch(text(tree), /Approve review|gpt-6-astra/);
		assert.ok(queries.slice(1).every((q) => q.enabled === false));
		assert.doesNotMatch(text(tree), /not a|not independent/);
		// Guarded switching for the retained chat contribution is covered by
		// compiled-chat-accounts; the workspace picker no longer exists.
		assert.ok(!calls.some(c => c.contract.name.startsWith("account_controls_")));
	} finally {
		for (const cleanup of effects.splice(0)) cleanup();
		stop();
	}
	assert.equal(removed, true);
	assert.ok(signals.slice(0, 5).every(item => item.aborted));
	assert.equal(pill.removed, true);
	assert.equal(header, undefined);
});

test("shipped contribution omits retired Activity and delegates Accounts while keeping Work as the workspace destination", { skip: !process.env.PASEO_PLUGIN_COMPILER }, async () => {
	const { compilePlugin } = await import(pathToFileURL(resolve(process.env.PASEO_PLUGIN_COMPILER)));
	const { clientBundle } = await compilePlugin({ client: resolve(root, "index.client.tsx") });
	const observers = [], panels = [], pills = [], headers = [], calls = [], opened = [];
	const load = name => {
		if (name === "@getpaseo/plugin") return { defineRpc: x => x, defineSettings: x => x };
		if (["react", "react/jsx-runtime", "react-native", "@getpaseo/plugin/client", "@getpaseo/plugin/client/ui", "@getpaseo/plugin/client/react-native", "@tanstack/react-query"].includes(name)) return {};
		return require(name);
	};
	const stop = (0, eval)(clientBundle)(load).default({
		paseo: { config: { get: async () => ({ config: { plugins: { "paseo-accounts": { enabled: true } } } }) }, agents: { list: async () => ({ subscription: { subscribe: observer => observers.push(observer) } }) } },
		rpc: async (contract, input) => { calls.push({ name: contract.name, input }); return { available: false }; },
		addScreen: () => () => {},
		addWorkspacePanel: panel => { panels.push(panel); return () => {}; },
		addHeaderButton: header => { headers.push(header); return { update() {}, remove() {} }; },
		addComposerPill: pill => { pills.push(pill); return { update() {}, remove() {} }; },
		openPanel: (id, target) => opened.push({ id, target }),
	});
	try {
		await new Promise(resolve => setImmediate(resolve));
		observers.forEach(observer => observer.snapshot({ entries: [{ agent: { id: "a", workspaceId: "w", provider: "pi" } }] }));
		assert.ok(!panels.some(p => p.id === "pi-activity"));
		assert.ok(!pills.some(p => p.id === "pi-activity"));
		assert.ok(!headers.some(p => p.id === "pi-accounts"), "external Accounts owns this control when enabled");
		assert.ok(!calls.some(c => /observability|account_controls/.test(c.name)), "retired Activity and delegated Accounts do not query in the background");
		const work = pills.find(p => p.id === "work");
		assert.equal(work.button.behavior.kind, "action");
		work.button.behavior.onPress();
		assert.deepEqual(opened, [{ id: "work", target: { workspaceId: "w", location: "workspace" } }]);
		assert.equal(panels.find(p => p.id === "work").context, "workspace");
	} finally { stop(); }
});
