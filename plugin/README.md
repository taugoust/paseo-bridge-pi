# Paseo Pi controls

A Paseo 0.10 plugin with agent-specific composer controls for permission prompts and read-only Jobs / Pi subagents views. Install from this repository with:

```sh
paseo plugin install github:taugoust/paseo-bridge-pi --path plugin
```

The pill is registered against each non-archived Pi agent's `agentId` and workspace. The daemon and Pi must run as the same Unix user; Windows daemon hosts are not supported. Changes apply to the selected agent and its children; underlying authorization and sandbox policy remain mandatory. Its label reports `On`, `Off`, `unavailable`, or a checking state. The popover reads current state, disables controls when state is stale/unavailable or an operation is busy, and sends explicit `enabled: true` or `enabled: false` requests. Status failures never imply a mode. No model prompt, chat message, abort, or slash command is used.

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

The tests verify that stale/failed/unavailable state disables mutations; the composer pill itself stays available to reopen the popover and retry. Compiled-bundle tests exercise contribution registration and the plugin backend against the real bridge transport, without model calls or a live daemon.

Validation passes with Paseo 0.10. Mobile/desktop visual confirmation after installation remains pending. Full plugin TypeScript declaration checking is not yet configured (the installed server SDK omits frontend type dependencies). Bridge TypeScript checking is covered by the root `npm run typecheck`.
