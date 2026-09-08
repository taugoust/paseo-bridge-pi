# paseo-bridge-pi

Start `pi` in a terminal and have that live session automatically appear in
[Paseo](https://paseo.sh) — readable and steerable from your phone — while the
TUI stays fully usable at your desk. No changes to Paseo required.

## Install

1. Install the pi extension:

   ```
   pi install git:github.com/caesay/paseo-bridge-pi
   ```

2. Inside pi, set up the Paseo side (points Paseo's pi provider at the bridge
   shim):

   ```
   /paseo-bridge install
   ```

3. Restart the Paseo daemon (`paseo restart`, or restart the desktop app).

That's it. Every new terminal pi session now shows up in Paseo automatically
(auto-connect is on by default). Make sure the `paseo` CLI is reachable:
either on `PATH`, or set `PASEO_CLI` to its full path (the desktop app
bundles it at `.../Paseo/resources/bin/paseo.cmd` on Windows).

## Slash commands

| Command | Effect |
|---|---|
| `/paseo-bridge install` | Register the shim as Paseo's pi provider command (`~/.paseo/config.json`). |
| `/paseo-bridge uninstall` | Remove the shim registration (only if it points at this package). |
| `/paseo-bridge auto on\|off` | Whether new TUI sessions connect to Paseo automatically (default: on). |
| `/paseo-bridge connect` | Connect the current session to Paseo now. |
| `/paseo-bridge disconnect` | Stop bridging the current session. |
| `/paseo-bridge status` | Show shim / auto-connect / session state. |
| `/reload` | Pi's built-in terminal-only reload; unsupported through the Paseo bridge. |
| `/remote-reload` | Reload Pi extensions and resources while idle, from Paseo or native RPC when this extension is loaded. |

## What you get

- Terminal sessions appear in Paseo within seconds, with live streaming
  tokens; prompts sent from the app run in the TUI (which stays usable).
- Extension slash commands, skill commands, and prompt templates sent from
  Paseo are dispatched by pi instead of becoming literal user prompts.
- Model and effort changes sync both ways.
- Foreground Pi `subagent` fan-outs appear as one structured Paseo task card per
  child. Each card keeps a stable identity across live updates/history replay.
  Task ID, attempt, and delivery outcome metadata are preserved separately from
  execution success; partial reports say **Needs continuation**, not delivered.
  With the matching Paseo server mapper patch, these labels appear in card titles
  and job/watch operations render readable text instead of nested JSON.
- With the task-enabled Pi harness installed, `/tasks`, `/watches`, and
  `/background-jobs` expose human controls through the existing mirrored choice
  UI. Background launches retain their real group/job handles; the task dashboard
  groups attempts, builds and alerts without fabricating separate provider sessions.
- After your first message, a session title is generated with the current
  model and applied to the Paseo agent, the workspace (prefixed `[TUI]`), and
  pi's session list.
- Closing the TUI mid-conversation leaves a helpful error in Paseo with the
  exact `pi --session <id>` command to resume, and Paseo's Fork keeps working.
- Reopening a session in a terminal reattaches the existing Paseo agent
  instead of creating a duplicate. If the Paseo daemon restarts while the TUI
  remains alive, the extension reloads that agent with bounded backoff until
  its provider reconnects.
- Paseo cancellation remains compatible with terminal-attached sessions even
  though Pi's extension API cannot clear queued messages directly: the bridge
  returns Pi's native `Unknown command: clear_queue` response so Paseo 0.7.2's
  documented fallback proceeds to `abort`.

## Reloading Pi from Paseo

Send `/remote-reload` without arguments or attachments. The old `/paseo-reload`
alias has been removed. Pi's built-in `/reload` remains terminal-only: the bridge
does not register it, and rejects it from Paseo with an unsupported-command error
instead of reloading or sending a model prompt. `/remote-reload` also works in
native RPC sessions when this extension is loaded. The bridge
rejects reload while the parent is running, compacting, has queued messages, or
has a pending UI/control request. It does not abort the parent or cancel its
background work to make reload possible.

For terminal-attached sessions, the prompt response acknowledges acceptance;
`Pi runtime reloaded` confirms that the replacement extension has started. The
existing RPC socket is retained and rebound to the new extension context, so the
shim does not mistake reload for Pi exiting. Requests arriving during the reload
gap receive an explicit retry error. If the controller disconnects independently,
normal provider reconnection still applies. A retained bridge that is not adopted
within 90 seconds is closed rather than left suspended indefinitely.

This reloads extensions, skills, prompts, themes, and context files—not the Pi
executable or the Paseo daemon. Existing child processes retain the code and
settings they launched with; extensions supporting same-session hot reload keep
their background jobs. This bridge version must already be loaded before the
remote command is available, so the first upgrade still needs a terminal reload
or a fresh Pi session. No terminal keystrokes or model prompts are used to emulate
built-in commands.

## How it works

Two components:

1. **Extension** (`extension/index.ts`) — loaded by every terminal pi. On
   session start it opens a named pipe (Windows) / unix socket keyed on the
   session file path, speaks pi's RPC JSONL dialect over it, and registers the
   session with the Paseo daemon via `paseo import`. It also keeps Paseo's
   view in sync (model/effort/titles) over the daemon's WS API.
2. **Shim** (`shim/pi-paseo-shim.js`) — configured as Paseo's pi provider
   command. When Paseo resumes a session, the shim checks whether that session
   has a live TUI (bridge pipe present). If yes, it pumps bytes between
   Paseo's stdio and the pipe. If no, it spawns the real `pi` with unchanged
   arguments, so Paseo-native sessions behave exactly as before. If the TUI
   dies while attached, the shim stays alive and answers further requests
   with a resume hint instead of a bare error.

The TUI process remains the **only writer** of the session `.jsonl` file.

```
TERMINAL                                    PASEO DAEMON
────────                                    ────────────
pi (TUI)                                    paseo import --provider pi <session-file>
 └─ paseo-bridge-pi (extension)                      │
     ├─ pipe: \\.\pipe\pi-paseo-bridge-<hash>        ▼
     │        (or $XDG_RUNTIME_DIR/pi-paseo/*.sock)  spawns provider command
     ├─ speaks pi RPC JSONL over it                  │
     └─ runs `paseo import` on session_start    pi-paseo-shim
                                                     ├─ session file from argv --session
         ◄───────── pipe/socket ───────────────────  ├─ pipe alive? bridge stdio<->pipe
                                                     └─ no pipe?   spawn real pi
```

## Uninstall

Inside pi:

```
/paseo-bridge uninstall
pi remove git:github.com/caesay/paseo-bridge-pi
```

Then restart the Paseo daemon.

## Development install

Working from a checkout instead of a pi package:

```
git clone https://github.com/caesay/paseo-bridge-pi
cd paseo-bridge-pi
npm install
npm run dev-install    # registers the checkout's extension path + shim
```

`npm run dev-uninstall` reverses it. Both registrations reference the
checkout by absolute path, so re-run it if you move the checkout. This is
for development only — the supported install is the pi package flow above.

## Environment variables

| Variable | Effect |
|---|---|
| `PI_PASEO_BRIDGE=off` | Disable the extension entirely. |
| `PI_PASEO_BRIDGE_NO_IMPORT=1` | Open the bridge pipe but skip `paseo import` (session won't auto-appear). |
| `PI_PASEO_BRIDGE_NO_TITLE=1` | Skip LLM title generation after the first user message. |
| `PI_PASEO_BRIDGE_DEBUG=1` | Log to `~/.pi/paseo-bridge/debug.log`. |
| `PI_PASEO_BRIDGE_FORCE=1` | Activate even when pi is not in TUI mode (testing only). |
| `PASEO_CLI` | Path to the paseo CLI used for registration. |
| `PASEO_HOST` | Forwarded to `paseo import --host`. |
| `PASEO_TMUX_TOPOLOGY=1` | Linux: import into the deterministic workspace for the current native tmux window using `--workspace-id`. |
| `PI_REAL_BIN` | Shim: path to the real pi binary (or its `cli.js`). |
| `PI_PASEO_TUI_BIN` | Supervised interactive `pi` launcher used for forks whose source session is supervised. |
| `PI_PASEO_UNSAFE_TUI_BIN` | Interactive `pi-unsafe` launcher used for forks whose source session is unsafe. When neither TUI launcher is configured, Paseo keeps its native text-history fork behavior. |
| `PI_PASEO_FORK_START_TIMEOUT_MS` | Bounded TUI bridge startup allowance in milliseconds (default `120000`, range `1000`–`600000`) for large session files. |

## Paseo forks in tmux

When a TUI launcher is configured, the provider shim recognizes the chat-history attachment on the first prompt of a Paseo fork. It resolves that history against a live attached Pi session, creates a real Pi JSONL branch at the selected assistant response (or the current native branch for whole-agent histories ending in tools), and replaces the temporary RPC backend with an interactive TUI. The source runtime record selects the matching trust mode: a supervised `pi` source launches supervised `pi`, while a `pi-unsafe` source launches `pi-unsafe`. During that conversion the shim removes Paseo's generated RPC-only integration extension; the package bridge remains loaded and prevents internal capture markers from appearing as TUI notifications.

- **Fork in new tab** creates a pane in the source agent's tmux window because Paseo assigns both agents to the same workspace.
- **Fork in new workspace** creates a window in the source agent's tmux session because Paseo assigns a different workspace.
- **Closing the fork tab** archives the Paseo agent. The shim then kills only a pane whose fork ownership, agent ID, pane ID, and live Pi PID still match. Paseo daemon downtime or restart leaves the pane running and reconnectable.

The fork is created when the draft is submitted, not when the Fork menu item is clicked. The bridge removes Paseo's text history from the forwarded prompt because the native Pi branch already contains that context. An attachment-only submission creates an idle fork; a submitted message starts the new branch with that message.

Source and boundary resolution is deliberately fail-closed. The source title, cwd, and terminal assistant text must resolve to exactly one bridged session entry. Histories ending at an assistant response retain that exact checkpoint, even if the source has progressed. Whole-agent histories with trailing tool entries use that exact assistant text as an anchor: it must be unique and an ancestor of the **current native branch at submission**. The bridge reads the running session's cursor through a separate read-only socket (without disconnecting Paseo), then snapshots its JSONL ancestry; it never selects the last historical entry or an unrelated branch. Later source activity is not included. Older source bridges without the snapshot endpoint must be updated before these forks can resolve.

If the native context ends midway through a tool-call batch, the snapshot rolls back only that unfinished assistant batch and its partial results, preserving earlier completed tool turns. The shim reports this trim on stderr. No tool results are invented and no source tools are restarted. Invalid tool context, missing anchors, and ambiguous or stale matches return an error rather than guessing. The source session is never rewritten. Conversation state is forked, but both agents continue to share the current filesystem.

## Harness-owned interactive children

A harness-owned child uses the normal **interactive Pi TUI bridge**, not a second
RPC Pi or a terminal-console agent. The harness's control extension uses its own
socket; Paseo retains the bridge's single controller socket. Completing a turn
leaves the TUI alive and idle. Harness children are excluded from the legacy
fork-archive pane cleanup: hiding, archiving, or disconnecting Paseo must not reap
them. Explicit pane reaping remains the harness's responsibility.

Trusted launchers may supply `PI_HARNESS_RUNTIME_ID`,
`PI_HARNESS_PARENT_SESSION_ID`, `PI_HARNESS_TASK_ID`, `PI_HARNESS_GROUP_ID`,
`PI_HARNESS_CHILD_ID`, `PI_HARNESS_ATTEMPT`, and `PI_HARNESS_CONTROL_SOCKET`.
The bridge publishes only these allowlisted harness fields (never control tokens)
in its private version-2 runtime records. Records also carry a Linux boot/start
identity when available and resolved `tmuxSocket`, `tmuxSessionId`,
`tmuxWindowId`, and `tmuxPane` IDs. A pane tagged `@pi_infrastructure 1` is not
imported. Every two seconds the bridge checks placement: clearing that tag imports
the existing TUI automatically, and moving the pane refreshes its native IDs.
Staging launchers must not set `PI_PASEO_BRIDGE_NO_IMPORT`, which remains an
unconditional operator override.

On Linux with `PASEO_TMUX_TOPOLOGY=1`, every import resolves the live pane's
canonical socket path, server incarnation, and window ID and sends
`--workspace-id wks_tmux_<hash>`. The hash is the first 24 hex characters of
SHA-256 over `JSON.stringify([socket, serverId, windowId])`, matching the server.
Inherited `PI_PASEO_TMUX_TARGET` is not used for import placement after moving a
pane. Workspace/projection rejections retry up to five times with bounded backoff,
even if the pane does not move again; each retry resolves live placement anew.
Missing native identity fails closed instead of importing into an inferred
workspace. Successful-but-ambiguous responses are not retried automatically.
Immediately after import/adoption, the Linux bridge tags the actual pane with
`@paseo_agent_id`, `@paseo_pi_agent_pid`, and `@paseo_pi_agent_start_token`
(`bootId:startTicks`) together, allowing the server to suppress a duplicate
terminal entry and relocate the same agent when its pane moves. Normal Pi exit
clears these tags only if the entire owner tuple still matches, leaving a returned
shell visible and preserving any successor Pi's tags. It does not kill the shell
or pane. Reload retains the tags; explicit-reap registry tombstones remain intact.

The shim discovers recorded bridge endpoints and refuses to spawn another Pi
when a matching runtime process may still be alive, even if its socket is
unavailable. It does not delete sockets on connection failure. Old records
without process-start identity and stale managed ownership are treated
conservatively. This protects shim fallback; it is not a system-wide session lock
against independently launched Pi processes. Ordinary `session_shutdown` removes
the registry entry; completion, disconnect, generic quit, and failure do not
create reaped tombstones.

For an irrevocably sealed explicit reap, the trusted harness control extension
emits `pi.events.emit("harness-runtime-reaping", { runtimeId, childId, workerEpoch })`
before shutdown. The bridge matches runtime/child IDs against its captured trusted
`PI_HARNESS_*` launch identity and validates the public worker epoch. It preserves
an atomic registry tombstone with `lifecycle: "reaped"`, `workerEpoch`, and
`reapSealedAt`, even after `session_shutdown`. No model message is injected.
Existing bridge commands and subsequent shim reconnections receive an explicit
reaped-runtime error instead of attaching or starting a replacement Pi. A reload
or placement refresh cannot erase the tombstone. The harness still owns graceful
Pi shutdown and verified pane removal: this retirement marker is not independent
proof that those resources have already exited. Continuation requires a new
runtime/session, not automatic revival of the retired one.

### Server-directed topology

The provider may supply `PI_PASEO_TMUX_TARGET` as JSON:

```json
{"version":1,"tmuxSocket":"/run/user/1000/tmux.sock","tmuxServerId":"123:456:789","tmuxSessionId":"$1","tmuxWindowId":"@2","projectId":"project-id","workspaceId":"workspace-id"}
```

The server owns project → tmux session and workspace → tmux window mappings.
Before allocating a pane, the shim verifies the tmux server's PID/start-time/socket
inode identity and verifies that the exact window belongs to the exact session.
Current incarnation validation uses Linux `/proc` and fails closed elsewhere.
Placement never uses cwd or tmux display names. Both root agents and history forks
allocate a pane in the supplied window, overriding legacy source-window placement.
After allocation, Linux launches best-effort tile the new pane's window so repeated
splits do not continually halve the same pane. A layout failure does not invalidate
or kill an otherwise successfully launched TUI.

Roots require `PI_PASEO_ROOT_TUI_KIND=unsafe` and
`PI_PASEO_UNSAFE_TUI_BIN` pointing to the trusted fresh interactive launcher.
With a topology target there is **no raw RPC fallback**. Provider metadata comes
from an actual idle bootstrap TUI. If the first prompt contains a native fork,
the shim verifies and closes that unused bootstrap pane, waits for its Pi process
to exit, then starts the real branch with the source-trust-matched launcher. No
source session is rewritten, and attachment-only forks stay idle. The launcher
receives the existing Paseo agent ID, so no second terminal agent is imported.

Topology allocation uses exclusive per-agent launch claims. A launcher crash or
uncertain startup leaves a claim in `~/.pi/paseo-bridge/launches`; do not remove it
until the pane/process is reconciled. A successful bridge connection releases the
claim. Provider disconnect or daemon restart does not close the underlying TUI.

## Quiet supervisor activity

Runs initiated by hidden custom messages (including harness state updates) are
projected as background activity, not new foreground start/finish cycles. Tool,
reasoning, and text updates still stream, but a silent internal finish cannot
trigger Paseo's stale-last-message completion notification. A real user message
or a new visible final reply promotes the run to a foreground turn. Terminal
errors remain visible; permission requests use their unchanged immediate path.

The bridge waits for Pi's `agent_settled` boundary before emitting one compatible
completion event, avoiding premature completion during retries. Actual
`get_state.isStreaming` and prompt dispatch are unchanged. Paseo's foreground
badge does not track otherwise-silent internal supervision cycles. No Paseo
provider or notification-policy patch is required for this behavior.

## Known limitations (v1)

- Built-in interactive-only commands are not part of pi's RPC command list and
  do not execute as commands when sent as prompts. The bridge explicitly rejects
  `/reload`; use `/remote-reload` for remote reloads. Use Paseo's native controls for model and thinking changes; extension
  commands such as `/slow-mode` do work.
- Extension UI dialogs (`ask_user` etc.) render in the TUI only; they are not
  forwarded to Paseo.
- Timeline rewind from Paseo is rejected for terminal-attached sessions
  (use Fork instead).
- Paseo's MCP tool injection (`pi-mcp-adapter`) does not apply to adopted
  sessions.
- Bridge-projected subagents use Paseo's existing structured task cards rather
  than its native provider-subagent track. Populating that track would require
  a Paseo provider change; the bridge intentionally does not modify Paseo.
- Relay / pairing-URL daemon setups (`PASEO_HOST` with a URL) skip the WS
  state sync; import still works via the CLI.
- If the TUI exits and Paseo later resumes the session itself, do not start a
  second TUI on the same session file while that Paseo agent is running — the
  two processes would both own the session file.

## Verification

Run unit tests with `npm test` and type checking with `npm run typecheck` using
the development tools supplied by your environment. Setting `TEST_PI_BIN` to an
installed Pi executable also enables the real-process reload tests (no model
calls or running user sessions are involved). They verify both native RPC and
terminal-bridge dispatch, single acknowledgement, stable process/socket identity,
and continued RPC operation after repeated reloads.

- During a remote-driven turn, exactly one process (the TUI) has the session
  `.jsonl` open for writing.
- With the shim installed but no terminal session running, launching a pi
  agent from Paseo behaves exactly as stock.
