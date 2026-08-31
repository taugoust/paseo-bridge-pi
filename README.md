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

## What you get

- Terminal sessions appear in Paseo within seconds, with live streaming
  tokens; prompts sent from the app run in the TUI (which stays usable).
- Extension slash commands, skill commands, and prompt templates sent from
  Paseo are dispatched by pi instead of becoming literal user prompts.
- Model and effort changes sync both ways.
- Pi `subagent` fan-outs appear as one structured Paseo task card per child.
  Each card keeps a stable identity across live updates and history replay,
  shows that child's task/model and current output, and resolves independently.
- After your first message, a session title is generated with the current
  model and applied to the Paseo agent, the workspace (prefixed `[TUI]`), and
  pi's session list.
- Closing the TUI mid-conversation leaves a helpful error in Paseo with the
  exact `pi --session <id>` command to resume, and Paseo's Fork keeps working.
- Reopening a session in a terminal reattaches the existing Paseo agent
  instead of creating a duplicate.

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
| `PI_REAL_BIN` | Shim: path to the real pi binary (or its `cli.js`). |
| `PI_PASEO_TUI_BIN` | Supervised interactive `pi` launcher used for forks whose source session is supervised. |
| `PI_PASEO_UNSAFE_TUI_BIN` | Interactive `pi-unsafe` launcher used for forks whose source session is unsafe. When neither TUI launcher is configured, Paseo keeps its native text-history fork behavior. |
| `PI_PASEO_FORK_START_TIMEOUT_MS` | Bounded TUI bridge startup allowance in milliseconds (default `120000`, range `1000`–`600000`) for large session files. |

## Paseo forks in tmux

When a TUI launcher is configured, the provider shim recognizes the chat-history attachment on the first prompt of a Paseo fork. It resolves that history against a live attached Pi session, creates a real Pi JSONL branch at the selected assistant response, and replaces the temporary RPC backend with an interactive TUI. The source runtime record selects the matching trust mode: a supervised `pi` source launches supervised `pi`, while a `pi-unsafe` source launches `pi-unsafe`.

- **Fork in new tab** creates a pane in the source agent's tmux window because Paseo assigns both agents to the same workspace.
- **Fork in new workspace** creates a window in the source agent's tmux session because Paseo assigns a different workspace.

The fork is created when the draft is submitted, not when the Fork menu item is clicked. The bridge removes Paseo's text history from the forwarded prompt because the native Pi branch already contains that context. An attachment-only submission creates an idle fork; a submitted message starts the new branch with that message.

Source and boundary resolution is deliberately fail-closed. The source title, cwd, and selected assistant text must resolve to exactly one live bridged session entry. Ambiguous or stale matches return an error rather than falling back to a potentially incorrect branch. Conversation state is forked, but both agents continue to share the current filesystem.

## Known limitations (v1)

- Built-in interactive-only commands are not part of pi's RPC command list and
  cannot be dispatched as prompts. Use Paseo's native controls for model and
  thinking changes; extension commands such as `/slow-mode` do work.
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

- During a remote-driven turn, exactly one process (the TUI) has the session
  `.jsonl` open for writing.
- With the shim installed but no terminal session running, launching a pi
  agent from Paseo behaves exactly as stock.
