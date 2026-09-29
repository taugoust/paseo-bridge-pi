# Paseo Permission Gate

A Paseo 0.10 plugin that exposes an agent-specific composer pill for explicitly enabling or disabling permission prompts. Install from this repository with:

```sh
paseo plugin install github:taugoust/paseo-bridge-pi --path plugin
```

The pill is registered against each non-archived Pi agent's `agentId` and workspace. The daemon and Pi must run as the same Unix user; Windows daemon hosts are not supported. Changes apply to the selected agent and its children; underlying authorization and sandbox policy remain mandatory. Its label reports `On`, `Off`, `unavailable`, or a checking state. The popover reads current state, disables controls when state is stale/unavailable or an operation is busy, and sends explicit `enabled: true` or `enabled: false` requests. Status failures never imply a mode. No model prompt, chat message, abort, or slash command is used.

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
