# Paseo Pi controls

A Paseo 0.10 plugin with agent-specific permission controls, a temporary interactive foreground-task composer popover, and read-only Jobs / Pi subagents views. Install from this repository with:

```sh
paseo plugin install github:taugoust/paseo-bridge-pi --path plugin
```

The pill is registered against each non-archived Pi agent's `agentId` and workspace. The daemon and Pi must run as the same Unix user; Windows daemon hosts are not supported. Changes apply to the selected agent and its children; underlying authorization and sandbox policy remain mandatory. Its label reports `On`, `Off`, `unavailable`, or a checking state. The popover reads current state, disables controls when state is stale/unavailable or an operation is busy, and sends explicit `enabled: true` or `enabled: false` requests. Status failures never imply a mode. No model prompt, chat message, abort, or slash command is used.

## Interactive foreground tasks

The **Foreground** composer pill opens a temporary, agent-bound popover (anchored surface on wide layouts; bottom sheet on compact layouts). Its closed-state label reports running work, pending questions/permissions, or finished tasks. It lists foreground helpers owned directly by the selected parent Pi session, streams their conversation, and supports explicit user prompts, individual permission/questionnaire answers, and Stop. Closing or dismissing the surface only hides it; it does not stop the helper. Unsent prompt drafts and questionnaire selections are retained client-side across close/reopen for that host, agent, parent session, and task.

Foreground control requires the companion `pi-agent-extensions` runtime to publish `__paeForegroundTasksV1` protocol 1. Control uses its own private socket and capability descriptor; it is not added to the read-only Jobs/Subagents transport or permission-mode operator. Requests bind the Paseo agent, parent session, bridge runtime epoch, service epoch, and task/worker epoch. Request IDs are stable across uncertain outcomes; nothing is automatically replayed or approved. Stale worker interactions are disabled. Background workers may start foreground helpers, but those helpers do not delegate, so the view is the parent's direct task list rather than a recursive tree. No tmux object, Paseo agent, workspace tab, or nested Modal is created for this UI.

## Read-only Jobs and Pi subagents

The **Jobs** and **Pi subagents** pills open agent-bound panels. These request data only while open, refresh every five seconds, and offer manual refresh. The first version shows up to 50 direct session-owned jobs or native tasks, not a recursive tree.

- Jobs: status, elapsed time, observation-only labels, and bounded output.
- Native subagents: status, attempt, bounded answer-only report, and **Open child chat** only when the backend verifies an exact live Paseo runtime match.
- Retained data is labeled as a snapshot, with its update time when known. Reloading or replacing the Pi session invalidates an old detail selection.
- No cancel, reap, resume, messaging, or notification-consumption actions are exposed. Job output does not mark a completion notification read.

Both the bridge and `pi-agent-extensions` must include the version-1 read-only harness API and be loaded in the Pi session. This read-only interface does not require permission-gate authority. Unsupported backends (including AgentSH-backed task snapshots in this first version) show an explanation rather than pretending their task list is empty. To inspect a child's local jobs, open that child's Pi chat and its Jobs view.

## Trust scope

The plugin is designed for the trusted-local Paseo model, including ordinary guard-only Pi sessions. The operator capability and descriptor remain in daemon-side plugin code and are never returned to the frontend. The descriptor is read from `~/.pi/paseo-bridge/operators/<sha256(agentId)>.json`; the private local socket receives the v1 `permission_gate_mode` protocol and binds requests/responses to agent, session, and runtime epoch. Filesystem owner/mode checks are defense in depth, not protection against malicious same-UID shell code in an unsafe Pi session. Do not treat this as a sandbox bypass or as protection from malicious same-user processes.

The plugin uses only Paseo host libraries at runtime and has no preparation/build step or added runtime dependencies. Pure wire, socket, UI-state, and lifecycle tests can be run with:

```sh
node --experimental-strip-types --test plugin/test/*.test.ts
```

Compile using the installed Paseo 0.10 host compiler (no package installation):

```sh
PASEO_PLUGIN_COMPILER=/path/to/paseo/packages/server/dist/server/server/plugins/compiler.js \
  node plugin/test/compile.mjs
PASEO_PLUGIN_COMPILER=/path/to/paseo/packages/server/dist/server/server/plugins/compiler.js \
  node --experimental-strip-types --test plugin/test/compiled-*.test.mjs
```

The tests verify closed-state task attention, explicit permission/questionnaire decisions, stale worker disabling, retained drafts/answers, close/reopen mutation locking, and private transport identity races. Compiled-bundle tests exercise the Paseo SDK plugin backend against the real private bridge socket. An opt-in integration test launches real `HeadlessForegroundManager` workers under Pi's RPC runtime and drives permission, questionnaire, fresh prompt, and Stop through that socket using a temporary deterministic provider (no model/network calls):

```sh
PAE_FOREGROUND_RUNTIME_TEST=1 \
PI_AGENT_EXTENSIONS_SOURCE=/path/to/pi-agent-extensions \
PI_TUI_TEST_PI=/nix/store/.../raw-pi/bin/pi \
PASEO_PLUGIN_COMPILER=/path/to/paseo/packages/server/dist/server/server/plugins/compiler.js \
  node --experimental-strip-types --test plugin/test/compiled-foreground-tasks-real-runtime.test.mjs
```

Set `PI_TUI_TEST_PI` to the raw immutable Pi executable, not an AgentSH/permission-gate wrapper. The test never inherits or reuses `PI_TUI_WORKER_LAUNCHER`; it explicitly binds the selected raw test Pi to the native `none` launch mode. The test creates no tmux panes, Paseo agents, workspaces, or persistent configuration. Its external runtime source is read-only.

Validation passes with Paseo 0.10. Mobile/desktop visual confirmation after installation remains pending. Full plugin TypeScript declaration checking is not yet configured (the installed server SDK omits frontend type dependencies). Bridge TypeScript checking is covered by the root `npm run typecheck`.
