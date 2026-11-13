import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const compilerPath = process.env.PASEO_PLUGIN_COMPILER;
assert.ok(compilerPath, "PASEO_PLUGIN_COMPILER is required; Worktree tests must execute");
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);

test("compiled Worktrees: explicit scope, branch identity, independent path links and unchanged removal gates", async () => {
  const { compilePlugin } = await import(pathToFileURL(resolve(compilerPath)));
  const { clientBundle } = await compilePlugin({ client: resolve(root, "index.client.tsx") });
  const jsx = (type, props) => typeof type === "function" ? type(props) : { type, props };
  const colors = { foreground: "#fff", foregroundMuted: "#aaa", statusDanger: "#f00", surface0: "#111", surface1: "#222", surface2: "#333", border: "#444", accent: "#0af", statusWarning: "#fa0", statusSuccess: "#0f0", accentForeground: "#000" };
  let sessionId = "session-a", snapshot, queryPromise, hookIndex = 0;
  const commands = [], hookStates = [], opened = [];
  const data = () => ({ available: true, enabled: true, sessionId, runtimeEpoch: "runtime", snapshot: { ...snapshot, serviceEpoch: "service" } });
  const load = name => {
    if (name === "@getpaseo/plugin") return { defineRpc: x => x, defineSettings: x => x };
    if (name === "zod") { const schema = new Proxy({}, { get: () => () => schema }); return { z: new Proxy({}, { get: () => () => schema }) }; }
    if (name === "@getpaseo/plugin/client/ui") return { SettingsCard: "SettingsCard", SettingsSection: "SettingsSection", SettingsSelect: "SettingsSelect", SettingsAction: "SettingsAction" };
    if (name === "@getpaseo/plugin/client") return { useRpc: contract => contract.name === "workflows_status" ? async () => data() : async value => { commands.push(value); return { accepted: true, openedWorkspaceId: "exact-workspace", snapshot }; } };
    if (name === "@getpaseo/plugin/client/react-native") return { ScrollView: "ScrollView", TextInput: "TextInput", Icon: "Icon" };
    if (name === "react-native") return { View: "View", Text: "Text", Pressable: "Pressable" };
    if (name === "react") return { useEffect() {}, useRef: initial => ({ current: initial }), useState: initial => { const i = hookIndex++; hookStates[i] ??= typeof initial === "function" ? initial() : initial; return [hookStates[i], next => { hookStates[i] = typeof next === "function" ? next(hookStates[i]) : next; }]; } };
    if (name === "react/jsx-runtime") return { jsx, jsxs: jsx };
    if (name === "@tanstack/react-query") return { useQuery: options => { queryPromise ??= options.queryFn(); return { data: data(), isError: false, isFetching: false, refetch: async () => {} }; }, useMutation: () => ({ mutate() {} }) };
    return require(name);
  };
  let worktrees;
  const cleanup = (0, eval)(clientBundle)(load).default({
    paseo: { config: { get: async () => ({ config: {} }) }, agents: { list: async () => ({ subscription: { subscribe() {} } }) } },
    rpc: async () => ({}), addWorkspacePanel: value => { if (value.id === "pi-worktrees") worktrees = value; return () => {}; }, addScreen: () => () => {}, addComposerPill: () => ({ update() {}, remove() {} }),
  });
  const textOf = n => typeof n === "number" ? String(n) : typeof n === "string" ? n : Array.isArray(n) ? n.map(textOf).join("") : n && typeof n === "object" ? textOf(n.props?.children) : "";
  async function render() {
    hookIndex = 0;
    const tree = worktrees.Component({ host: { id: "host" }, agentId: "agent", workspaceId: "workspace", theme: { colors }, layout: { platform: "web", compact: false }, navigation: { openWorkspace: input => opened.push(input) } });
    await queryPromise; queryPromise = undefined;
    const nodes = [];
    const visit = n => { if (!n || typeof n !== "object") return; nodes.push(n); for (const c of [n.props?.children].flat(Infinity)) visit(c); };
    visit(tree); return nodes;
  }
  const press = (nodes, label) => nodes.find(n => n.type === "Pressable" && textOf(n) === label);
  const descendants = n => [n.props?.children].flat(Infinity).flatMap(function all(c) { return !c || typeof c !== "object" ? [] : [c, ...[c.props?.children].flat(Infinity).flatMap(all)]; });
  // Worktree rows, not other disclosures such as the inventory warning's Show.
  const rows = nodes => nodes.filter(n => n.type === "Pressable" && n.props.accessibilityHint === "Show checkout details, agent and removal options");
  const row = nodes => rows(nodes)[0];
  const chevron = row => descendants(row).find(n => n.type === "Icon" && /^Chevron/.test(n.props.name))?.props.name;
  const headers = nodes => nodes.filter(n => n.props?.accessibilityRole === "header").map(textOf);
  const headerIcons = nodes => nodes.filter(n => n.props?.accessibilityRole === "header").map(n => descendants(n).find(c => c.type === "Icon")?.props.name);
  const link = nodes => nodes.find(n => n.props?.accessibilityRole === "link");
  const diffStat = nodes => nodes.find(n => n.type === "Text" && / additions, \d+ deletions$/.test(n.props.accessibilityLabel ?? ""));
  const scopeLabels = ["This chat", "By goal", "All"];
  const makeTree = (path, createdInSession, repositoryPath = "/repo", extra = {}) => ({ path, createdInSession, repositoryPath, repositoryLabel: repositoryPath, branch: "pi/branch", head: "abcdef", main: false, current: false, locked: false, stale: false, detached: false, changedFiles: 0, ...extra });
  const idle = { protocol: 1, sessionId, serviceEpoch: "service", cwd: "/repo", model: null, busy: false, idle: true, notice: null, operationId: null, operationAction: null, protectedPaths: [], dialog: null, worktreeError: null, worktreeLoading: false, worktreeRepositoryCount: 1, worktreeContainer: false, goal: null, completedGoals: [], lastCompletion: null, worktree: null, worktrees: [] };
  try {
    snapshot = { ...idle, worktrees: [makeTree("/repo/other", false), makeTree("/second/ours", true, "/second"), makeTree("/second/also-ours", true, "/second"), makeTree("/repo/ours", true)] };
    let nodes = await render();
    press(nodes, "Connect current session")?.props.onPress();
    nodes = await render();
    assert.equal(rows(nodes).length, 3);
    assert.ok(nodes.some(n => n.type === "Text" && textOf(n) === "3 worktrees"), "a quiet count leads the header");
    assert.deepEqual(headers(nodes), ["/second", "/repo"], "repositories are plain labels without counts");
    assert.deepEqual(headerIcons(nodes), ["FolderGit2", "FolderGit2"]);
    assert.ok(!nodes.some(n => n.props?.style?.fontWeight === "600"), "no bold band headers or titles");
    const lists = nodes.filter(n => n.type === "View" && n.props.style?.borderWidth === 1 && n.props.style?.borderRadius === 8 && n.props.style?.backgroundColor === colors.surface1);
    assert.equal(lists.length, 2, "one bordered list per repository");
    assert.equal(rows(descendants(lists[0])).length, 2, "a repository's worktrees share one list");
    assert.equal(descendants(lists[0]).filter(n => n.type === "View" && n.props.style?.borderTopWidth === 1).length, 1, "rows are divided by a single rule");
    assert.equal(link(nodes), undefined, "absolute paths are tucked into details, not repeated in every collapsed row");
    assert.ok(nodes.some(n => n.props.style?.maxWidth === 960), "desktop list width is bounded");
    assert.equal(press(nodes, "This chat").props.accessibilityState.selected, true);
    const scope = nodes.filter(n => n.type === "Pressable" && scopeLabels.includes(textOf(n)));
    assert.deepEqual(scope.map(textOf), scopeLabels);
    assert.ok(scope.every(n => descendants(n).find(c => c.type === "Text").props.style.fontSize === 12), "the scope switch uses small text");
    const original = snapshot;
    const associated = (id, text) => ({ sessionId, id, text });
    snapshot = { ...idle, worktrees: [
      makeTree("/repo/unassigned", true),
      makeTree("/repo/coordinator", true, "/repo", { worktreeGoal: associated("a", "Goal A") }),
      makeTree("/second/descendant", false, "/second", { goalScopeSessionId: sessionId, worktreeGoal: associated("a", "Goal A") }),
      makeTree("/repo/another", true, "/repo", { worktreeGoal: associated("b", "Goal B") }),
      makeTree("/repo/foreign", false, "/repo", { goalScopeSessionId: "foreign", worktreeGoal: associated("a", "Goal A") }),
      makeTree("/repo/legacy", undefined),
    ] };
    press(nodes, "By goal").props.onPress(); nodes = await render();
    assert.equal(press(nodes, "By goal").props.accessibilityState.selected, true);
    assert.equal(press(nodes, "This chat").props.accessibilityState.selected, false);
    assert.deepEqual(headers(nodes), ["Goal A", "Goal B", "No goal"], "goals first, No goal last");
    assert.deepEqual(headerIcons(nodes), ["Target", "Target", "Target"]);
    assert.equal(rows(nodes).length, 4);
    assert.ok(rows(nodes).some(n => textOf(n).includes("/second")), "repository context is visible on Goal rows");
    press(nodes, "This chat").props.onPress(); nodes = await render();
    assert.deepEqual(headers(nodes), ["/repo"]);
    press(nodes, "All").props.onPress(); nodes = await render();
    assert.equal(rows(nodes).length, 6);
    press(nodes, "By goal").props.onPress(); snapshot.worktrees = []; nodes = await render();
    assert.ok(nodes.some(n => n.type === "Text" && textOf(n) === "No worktrees from this chat's goals"));
    assert.ok(nodes.some(n => n.type === "Text" && textOf(n) === "Workers and goals that get their own checkout show up here."));
    press(nodes, "Show all worktrees").props.onPress(); nodes = await render();
    assert.equal(press(nodes, "All").props.accessibilityState.selected, true, "the empty-state link switches scope to All");
    assert.ok(nodes.some(n => n.type === "Text" && textOf(n) === "No additional worktrees"));
    assert.equal(press(nodes, "Show all worktrees"), undefined, "no link when already showing All");
    press(nodes, "This chat").props.onPress(); snapshot = original;
    snapshot.worktreeError = "Permission denied [synthetic]";
    nodes = await render();
    assert.ok(nodes.some(n => n.type === "Text" && textOf(n) === "Some worktrees couldn't be listed and were skipped."), "a partial inventory says so");
    assert.ok(!nodes.some(n => textOf(n) === snapshot.worktreeError), "the raw error waits behind Show");
    assert.equal(press(nodes, "Show").props.accessibilityState.expanded, false);
    press(nodes, "Show").props.onPress(); nodes = await render();
    assert.ok(nodes.some(n => n.type === "Text" && textOf(n) === snapshot.worktreeError && n.props.selectable), "the exact error stays available and selectable");
    assert.equal(rows(nodes).length, 3, "listed worktrees remain alongside the warning");
    press(nodes, "All").props.onPress(); nodes = await render();
    assert.equal(rows(nodes).length, 4);
    press(nodes, "This chat").props.onPress(); nodes = await render();
    assert.equal(rows(nodes).length, 3);
    snapshot = { ...idle, worktrees: [makeTree("/repo/legacy", undefined)] };
    nodes = await render(); assert.ok(nodes.some(n => n.type === "Text" && textOf(n) === "No worktrees from this chat"));
    press(nodes, "All").props.onPress(); nodes = await render(); assert.ok(row(nodes));
    sessionId = "session-b"; snapshot = { ...idle, sessionId, worktrees: [makeTree("/repo/not-ours", false), makeTree("/repo/new-ours", true, "/repo", { ownerTitle: "RAW TASK INSTRUCTIONS DO NOT DISPLAY" })] };
    await render(); nodes = await render();
    assert.equal(press(nodes, "This chat").props.accessibilityState.selected, true);
    assert.equal(row(nodes).props.accessibilityLabel, "pi/branch");
    assert.equal(chevron(row(nodes)), "ChevronDown", "a collapsed row shows a down chevron");
    assert.equal(descendants(row(nodes)).find(n => n.type === "Icon").props.name, "GitBranch", "rows lead with a branch icon");
    assert.ok(textOf(row(nodes)).includes("Clean"));
    assert.ok(!nodes.some(n => textOf(n).includes("RAW TASK")));
    assert.equal(row(nodes).props.accessibilityState.expanded, false);
    press(nodes, "By goal").props.onPress(); nodes = await render();
    assert.deepEqual(headers(nodes), ["No goal"]);
    row(nodes).props.onPress(); nodes = await render();
    assert.ok(nodes.some(n => n.type === "Text" && textOf(n) === "Path"), "expanded rows list labelled facts");
    const factRow = nodes => nodes.find(n => n.type === "View" && descendants(n)[0]?.type === "Text" && textOf(descendants(n)[0]) === "Branch");
    assert.equal(factRow(nodes).props.style.flexDirection, "row", "wide lists put the label beside the value");
    const list = nodes.find(n => n.type === "View" && n.props.style?.maxWidth === 960);
    list.props.onLayout({ nativeEvent: { layout: { width: 400 } } }); nodes = await render();
    assert.equal(factRow(nodes).props.style.flexDirection, "column", "narrow lists stack the label above the value");
    nodes.find(n => n.type === "View" && n.props.style?.maxWidth === 960).props.onLayout({ nativeEvent: { layout: { width: 900 } } }); nodes = await render();
    const copy = nodes.find(n => n.type === "Pressable" && n.props.accessibilityLabel === "Copy path");
    assert.ok(copy, "a copy icon sits next to the path");
    assert.equal(descendants(copy).find(n => n.type === "Icon").props.name, "Copy");
    // The path itself opens the workspace through the guarded worktree.open action.
    assert.equal(textOf(link(nodes)), "/repo/new-ours");
    assert.equal(link(nodes).props.disabled, false);
    const before = commands.length;
    link(nodes).props.onPress(); await new Promise(r => setImmediate(r)); nodes = await render();
    assert.equal(row(nodes).props.accessibilityState.expanded, true, "path action does not toggle details");
    assert.equal(commands.length, before + 1);
    assert.equal(commands.at(-1).request.operation, "start");
    assert.equal(commands.at(-1).request.action, "worktree.open");
    assert.equal(commands.at(-1).request.path, "/repo/new-ours");
    assert.deepEqual(opened.at(-1), { workspaceId: "exact-workspace", serverId: "host" });
    let prevented = 0, stopped = 0;
    link(nodes).props.onKeyDown({ key: "Enter", preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
    await new Promise(r => setImmediate(r)); nodes = await render();
    assert.equal(prevented, 1); assert.equal(stopped, 1);
    assert.equal(row(nodes).props.accessibilityState.expanded, true, "keyboard directory activation must not toggle details");
    assert.equal(commands.at(-1).request.path, "/repo/new-ours");
    // Open workspace is the same action as the path.
    const openButton = press(nodes, "Open workspace");
    assert.equal(openButton.props.disabled, false);
    const openedBefore = opened.length;
    openButton.props.onPress(); await new Promise(r => setImmediate(r)); nodes = await render();
    assert.deepEqual({ ...commands.at(-1).request, requestId: undefined }, { ...commands.at(-2).request, requestId: undefined }, "button and path send the same request");
    assert.equal(opened.length, openedBefore + 1);
    assert.deepEqual(opened.at(-1), { workspaceId: "exact-workspace", serverId: "host" });
    // Diff stats are plain text inside the row, never their own button.
    snapshot.worktrees[1].diffStat = { additions: 71234, deletions: 34 };
    nodes = await render();
    const stat = diffStat(nodes);
    assert.equal(stat.type, "Text");
    assert.equal(textOf(stat), "+71.2k  −34", "compact numbers");
    assert.equal(stat.props.accessibilityLabel, "71234 additions, 34 deletions");
    assert.deepEqual(nodes.filter(n => n.type === "Pressable" && descendants(n).includes(stat)), [row(nodes)], "only the row toggle contains the stat");
    assert.ok(!descendants(stat).some(n => n.type === "Pressable" || n.props?.onPress), "the stat has no press handler");
    assert.ok(!nodes.some(n => /^Open changes for/.test(n.props?.accessibilityLabel ?? "")), "the separate +/- pill is gone");
    const statCommands = commands.length;
    row(nodes).props.onPress(); nodes = await render();
    assert.equal(commands.length, statCommands, "pressing the row only toggles details");
    assert.equal(row(nodes).props.accessibilityState.expanded, false);
    row(nodes).props.onPress(); nodes = await render();
    snapshot.worktrees[1].diffStat = { additions: 0, deletions: 0 }; nodes = await render();
    assert.equal(textOf(diffStat(nodes)), "+0  −0", "native-reported zero counts remain useful, not hidden");
    snapshot.worktrees[1].diffStat = null; nodes = await render();
    assert.equal(diffStat(nodes), undefined, "unavailable stats aren't invented from changedFiles");
    assert.ok(!nodes.some(n => n.type === "Text" && /Open changes|Native line counts unavailable|Line counts need native comparison data|Open a workspace, then select native Changes/.test(textOf(n))), "backend limitations and redundant two-step instructions are not inline copy");
    assert.equal(row(nodes).props.accessibilityState.expanded, true);
    assert.equal(nodes.filter(n => n.type === "Text" && textOf(n).includes("/repo/new-ours")).length, 1);
    assert.ok(nodes.some(n => textOf(n) === "Clean, nothing uncommitted"));
    assert.equal(press(nodes, "Remove…").props.disabled, false);
    // Opening stays guarded: stale metadata or a busy session disables both the path and the button.
    for (const extra of [{ stale: true }]) {
      snapshot.worktrees = [makeTree("/repo/new-ours", true, "/repo", extra)]; nodes = await render();
      assert.equal(link(nodes).props.disabled, true, JSON.stringify(extra));
      assert.equal(press(nodes, "Open workspace").props.disabled, true, JSON.stringify(extra));
      const count = commands.length;
      link(nodes).props.onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {} });
      assert.equal(commands.length, count, "a disabled path ignores Enter");
    }
    snapshot = { ...idle, busy: true, sessionId, worktrees: [makeTree("/repo/new-ours", true)] }; nodes = await render();
    assert.equal(link(nodes).props.disabled, true, "busy");
    assert.equal(press(nodes, "Open workspace").props.disabled, true, "busy");
    for (const extra of [{ inUse: true }, { current: true }, { main: true }, { locked: true }, { stale: true }, { changedFiles: null }, { changedFiles: 2 }]) {
      snapshot = { ...idle, sessionId, worktrees: [makeTree("/repo/new-ours", true, "/repo", extra)] }; nodes = await render();
      assert.equal(press(nodes, "Remove…").props.disabled, true, JSON.stringify(extra));
    }
    assert.ok(nodes.some(n => n.type === "Text" && textOf(n) === "Uncommitted changes must be preserved"), "the removal block is explained");
    assert.ok(textOf(row(nodes)).includes("2 changed files"));
    snapshot.worktrees = [makeTree("/repo/new-ours", true, "/repo", { locked: true })]; nodes = await render();
    assert.equal(descendants(row(nodes)).find(n => n.type === "Icon").props.color, colors.statusWarning, "locked rows keep the warning colour");
    for (const extra of [{ busy: true }, { idle: false }, { goal: { id: "goal", status: "active", title: "Goal", tasks: [] } }]) {
      snapshot = { ...idle, ...extra, sessionId, worktrees: [makeTree("/repo/new-ours", true)] }; nodes = await render();
      assert.equal(press(nodes, "Remove…").props.disabled, true, JSON.stringify(extra));
    }
    for (const [extra, title] of [[{ branch: null, detached: true }, "Detached HEAD"], [{ branch: null, detached: false }, "Branch unavailable"]]) {
      snapshot = { ...idle, sessionId, worktrees: [makeTree("/repo/new-ours", true, "/repo", extra)] }; nodes = await render();
      assert.equal(row(nodes).props.accessibilityLabel, title);
      assert.equal(row(nodes).props.accessibilityState.expanded, true);
      assert.equal(chevron(row(nodes)), "ChevronUp", "an expanded row shows an up chevron");
    }
    row(nodes).props.onPress();
    snapshot.worktrees[0].recordedOwner = { ownerSessionId: sessionId, taskId: "task", childId: "child", canonicalDisplayName: "Workspace Activity Spinner" };
    nodes = await render();
    assert.equal(row(nodes).props.accessibilityLabel, "Workspace Activity Spinner", "validated canonical name is promoted into the collapsed row");
    assert.equal(chevron(row(nodes)), "ChevronDown");
    assert.match(textOf(row(nodes)), /Branch unavailable · \/repo · clean$/, "Git identity remains alongside canonical owner name");
    snapshot.worktrees[0].recordedOwner.canonicalDisplayName = "This is an old untrusted task prompt with too many words";
    nodes = await render();
    assert.equal(row(nodes).props.accessibilityLabel, "Branch unavailable", "never promote raw task descriptions");
    assert.equal(commands.filter(c => c.request.action === "worktree.remove").length, 0, "no destructive action executed by tests");
  } finally { cleanup(); }
});
