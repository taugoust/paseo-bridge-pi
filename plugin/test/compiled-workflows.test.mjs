import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { once } from "node:events";
import { createBtwEndpoint } from "../../extension/btw-operator.js";
import { writeWorkflowsDescriptor } from "../../extension/workflows-operator.js";
const require = createRequire(import.meta.url),
	root = fileURLToPath(new URL("../", import.meta.url)),
	exec = promisify(execFile);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const nodes = (x) =>
	!x || typeof x !== "object"
		? []
		: [x, ...[x.props?.children].flat(Infinity).flatMap(nodes)];
const text = (x) =>
	typeof x === "string"
		? x
		: !x || typeof x !== "object"
			? ""
			: [x.props?.children].flat(Infinity).map(text).join("");
test("compiled Workflows controls use the private engine, explicit confirmations, workspace navigation and stale-safe locks", {
	skip:
		!process.env.PASEO_PLUGIN_COMPILER ||
		!process.env.PI_AGENT_EXTENSIONS_SOURCE,
}, async () => {
	const source = process.env.PI_AGENT_EXTENSIONS_SOURCE,
		{ createJiti } = await import(
			pathToFileURL(
				join(
					source,
					"node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs",
				),
			)
		);
	const { createWorkflowService } = await createJiti(import.meta.url).import(
		join(source, "workflows/service.ts"),
	);
	const dir = await mkdtemp(join(tmpdir(), "workflow-ui-")),
		cwd = join(dir, "repo");
	await mkdir(cwd);
	const git = (...args) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	git("init", "--initial-branch=main");
	git("config", "user.name", "UI test");
	git("config", "user.email", "ui@example.invalid");
	await writeFile(join(cwd, "seed"), "fixture");
	git("add", ".");
	git("-c", "commit.gpgsign=false", "commit", "-m", "Fixture");
	let paidIntents = 0,
		stops = 0;
	const runtime = {
		settings: { continuationLimits: { automaticTurns: 3, noProgressTurns: 2 } },
		activeGoal: undefined,
		snapshotSettingsApplicationState: () => ({}),
	};
	const commands = {
		async startGoal(text, tokenBudget) {
			paidIntents++;
			runtime.activeGoal = {
				id: randomUUID(),
				text,
				tokenBudget,
				status: "active",
				tokensUsed: 0,
				automaticModelTurns: 0,
				toolFreeRepeatCount: 0,
				iteration: 0,
			};
		},
		pauseGoal() {
			stops++;
			runtime.activeGoal.status = "paused";
		},
	};
	const ctx = {
		cwd,
		model: { provider: "openai", id: "gpt-6-luna" },
		modelRegistry: { find: () => ({}) },
		sessionManager: {
			getSessionId: () => "session",
			getLeafId: () => null,
			getBranch: () => [],
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		ui: { setStatus() {}, notify() {} },
	};
	const pi = {
		exec: async (command, args, options) => {
			try {
				const result = await exec(command, args, {
					cwd: options.cwd,
					signal: options.signal,
					timeout: options.timeout,
				});
				return { ...result, code: 0, killed: false };
			} catch (error) {
				return {
					stdout: error.stdout ?? "",
					stderr: error.stderr ?? "",
					code: typeof error.code === "number" ? error.code : 1,
					killed: !!error.killed,
				};
			}
		},
	};
	const service = createWorkflowService(pi, ctx, runtime, commands, {
		get: () => ({ effectiveRoot: join(dir, "trees") }),
	});
	const identity = {
		agentId: "agent",
		sessionId: service.sessionId,
		serviceEpoch: service.serviceEpoch,
		runtimeEpoch: randomUUID(),
		capability: "a".repeat(64),
	};
	const pipe = join(dir, "bridge"),
		endpoint = createBtwEndpoint(
			pipe,
			() => ({
				btwIdentity: () => identity,
				btw: (request) => service.handle(request),
			}),
			"workflows",
			".workflows",
		);
	let stop = () => {};
	try {
		const probe = connect(`${pipe}.workflows`);
		await once(probe, "connect");
		probe.destroy();
		writeWorkflowsDescriptor(join(dir, ".pi", "paseo-bridge"), {
			version: 1,
			socketPath: `${pipe}.workflows`,
			...identity,
		});
		const { compilePlugin } = await import(
				pathToFileURL(resolve(process.env.PASEO_PLUGIN_COMPILER))
			),
			{ clientBundle, serverBundle } = await compilePlugin({
				client: resolve(root, "index.client.tsx"),
				server: resolve(root, "index.server.ts"),
			});
		const handlers = new Map();
		(0, eval)(serverBundle)((name) =>
			name === "@getpaseo/plugin"
				? { defineRpc: (x) => x, defineSettings: (x) => x }
				: name === "node:os"
					? { ...require(name), homedir: () => dir }
					: require(name),
		).default({
			handle: (contract, handler) =>
				handlers.set(contract.name, { contract, handler }),
			registerSettings() {},
			registerUsageSource: () => () => {},
			before: () => () => {},
		});
		let wrongWorkspace = false,
			loseReply = false;
		const opened = [],
			navigated = [],
			requests = [],
			pending = [];
		const handlerContext = {
			paseo: {
				agents: {
					ref: () => ({
						refresh: async () => ({
							agent: {
								id: "agent",
								workspaceId: wrongWorkspace ? "other" : "workspace",
								provider: "pi",
							},
						}),
					}),
				},
				workspaces: {
					ref: () => ({ refresh: async () => ({ projectId: "project" }) }),
					create: async (input) => {
						opened.push(input);
						return { id: "new-workspace" };
					},
				},
			},
		};
		async function rpc(contract, input) {
			const row = handlers.get(contract.name);
			row.contract.input.parse(input);
			requests.push({ name: contract.name, input });
			let done;
			if (contract.name === "workflows_control")
				pending.push(new Promise((resolve) => (done = resolve)));
			try {
				const result = await row.handler(input, handlerContext);
				row.contract.output.parse(result);
				if (loseReply && contract.name === "workflows_control")
					throw Error("lost reply");
				return result;
			} finally {
				done?.();
			}
		}
		let hook = 0,
			options,
			data,
			isError = false;
		const states = [],
			effects = [],
			observers = [],
			panels = new Map(),
			pills = [];
		const query = {
			get data() {
				return data;
			},
			get isPending() {
				return !data;
			},
			get isError() {
				return isError;
			},
			isFetching: false,
			refetch: async () => {
				try {
					data = await options.queryFn();
					isError = false;
				} catch {
					isError = true;
				}
				return { data, isError };
			},
		};
		const jsx = (type, props, key) => {
			assert.ok(
				typeof type === "string" || typeof type === "function",
				`Missing UI export ${type}`,
			);
			return typeof type === "function" ? type(props) : { type, props, key };
		};
		const useState = (initial) => {
			const i = hook++;
			if (!(i in states))
				states[i] = typeof initial === "function" ? initial() : initial;
			return [
				states[i],
				(value) =>
					(states[i] = typeof value === "function" ? value(states[i]) : value),
			];
		};
		const load = (name) => {
			if (name === "@getpaseo/plugin") return { defineRpc: (x) => x, defineSettings: (x) => x };
			if (name === "@getpaseo/plugin/client")
				return { useRpc: (contract) => (input) => rpc(contract, input) };
			if (name === "@getpaseo/plugin/client/react-native")
				return { ScrollView: "ScrollView", TextInput: "TextInput" };
			if (name === "@getpaseo/plugin/client/ui")
				return {
					SettingsCard: "SettingsCard",
					SettingsSection: "SettingsSection",
					SettingsSelect: "SettingsSelect",
				};
			if (name === "react-native")
				return { View: "View", Text: "Text", Pressable: "Pressable" };
			if (name === "react/jsx-runtime")
				return { jsx, jsxs: jsx, Fragment: "Fragment" };
			if (name === "react")
				return {
					useState,
					useRef: (value) => useState(() => ({ current: value }))[0],
					useEffect: (effect) => {
						const cleanup = effect();
						if (cleanup) effects.push(cleanup);
					},
				};
			if (name === "@tanstack/react-query")
				return {
					useQuery: (o) => {
						options = o;
						return query;
					},
				};
			return require(name);
		};
		stop = (0, eval)(clientBundle)(load).default({
			rpc: async () => ({ available: false }),
			paseo: {
				config: { get: async () => ({ config: { plugins: { "paseo-accounts": { enabled: true } } } }) },
				agents: {
					list: async () => ({
						subscription: { subscribe: (s) => observers.push(s) },
					}),
				},
			},
			addScreen: () => () => {},
			openScreen() {},
			addWorkspacePanel: (p) => {
				panels.set(p.id, p);
				return () => panels.delete(p.id);
			},
			addComposerPill: (p) => {
				const value = {
					...p,
					removed: false,
					remove() {
						this.removed = true;
					},
					update() {},
				};
				pills.push(value);
				return value;
			},
			addHeaderButton: () => ({ remove() {}, update() {} }),
			openPanel() {},
		});
		await tick();
		for (const observer of observers)
			observer.snapshot({
				entries: [
					{ agent: { id: "agent", workspaceId: "workspace", provider: "pi" } },
				],
			});
		assert.ok(pills.some((p) => p.id === "pi-workflows"));
		const props = {
			agentId: "agent",
			workspaceId: "workspace",
			host: { id: "host" },
			navigation: { openWorkspace: (input) => navigated.push(input) },
			theme: {
				colors: {
					foreground: "#fff",
					foregroundMuted: "#aaa",
					accent: "#08f",
					surface0: "#111",
					surface2: "#222",
					border: "#444",
					statusWarning: "#fa0",
					statusSuccess: "#0f0",
				},
			},
		};
		const render = () => {
			hook = 0;
			return panels.get("pi-workflows").Component(props);
		};
		const idle = async () => {
			const deadline = Date.now() + 10000;
			while (states[0]?.pending && Date.now() < deadline) await tick();
			assert.equal(states[0]?.pending, false);
		};
		const button = (tree, label) => {
			const node = nodes(tree).find(
				(n) => n.type === "Pressable" && text(n) === label,
			);
			assert.ok(node, label);
			return node;
		};
		let tree = render();
		await query.refetch();
		tree = render();
		nodes(tree)
			.find((n) => n.props?.accessibilityLabel === "Goal objective")
			.props.onChangeText("Native goal preview");
		tree = render();
		const start = button(tree, "Start Goal");
		start.props.onPress();
		start.props.onPress();
		await pending.at(-1);
		await idle();
		await query.refetch();
		tree = render();
		assert.equal(paidIntents, 0);
		assert.equal(
			requests.filter((r) => r.name === "workflows_control").length,
			1,
			"synchronous lock prevents duplicate start",
		);
		assert.match(text(tree), /paid model calls/);
		button(tree, "Confirm").props.onPress();
		await pending.at(-1);
		await idle();
		await query.refetch();
		tree = render();
		assert.equal(paidIntents, 1);
		assert.match(text(tree), /Native goal preview/);
		loseReply = true;
		button(tree, "Pause Goal").props.onPress();
		await pending.at(-1);
		await idle();
		await query.refetch();
		tree = render();
		assert.equal(stops, 1);
		assert.match(text(tree), /lost reply/, "the actual reason is shown");
		for (const cleanup of effects.splice(0)) cleanup();
		states.length = 0;
		loseReply = false;
		await query.refetch();
		tree = render();
		assert.equal(button(tree, "I reviewed the refreshed status"), undefined);
		assert.equal(
			button(tree, "Resume Goal").props.disabled,
			false,
			"controls unlock once the refreshed state is in",
		);
		assert.equal(paidIntents, 1, "no automatic retry");
		// Inventory is asynchronous and never blocks Goal controls.
		const inventoryDeadline = Date.now() + 10000;
		while (!data.snapshot.worktrees.length && Date.now() < inventoryDeadline) {
			await tick();
			await query.refetch();
		}
		tree = render();
		button(tree, "Open new workspace").props.onPress();
		await pending.at(-1);
		await idle();
		assert.equal(opened[0].source.path, cwd);
		assert.equal(opened[0].source.projectId, "project");
		assert.match(opened[0].idempotencyKey, /^pi-worktree:/);
		assert.equal(navigated[0].workspaceId, "new-workspace");
		assert.equal(paidIntents, 1, "opening a workspace starts no model");
		const previous = requests.find((r) => r.name === "workflows_control").input;
		wrongWorkspace = true;
		await assert.rejects(
			rpc(handlers.get("workflows_control").contract, previous),
			/workspace/,
		);
		assert.equal(paidIntents, 1);
		wrongWorkspace = false;
		await assert.rejects(
			rpc(handlers.get("workflows_control").contract, {
				...previous,
				expectedRuntimeEpoch: randomUUID(),
			}),
			/changed/,
		);
		stop();
		stop = () => {};
		assert.ok(pills.every((p) => p.removed));
		assert.equal(panels.size, 0);
	} finally {
		stop();
		service.dispose();
		endpoint.close();
		await rm(dir, { recursive: true, force: true });
	}
});
