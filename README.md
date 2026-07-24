# pi-paseo-bridge

Start `pi` in a terminal and have that live session automatically appear in
[Paseo](https://paseo.sh) — readable and steerable from your phone — while the
TUI stays fully usable at your desk. No changes to Paseo required.

## How it works

Two components:

1. **Extension** (`extension/index.ts`) — loaded by every terminal pi. On
   session start it opens a named pipe (Windows) / unix socket keyed on the
   session file path, speaks pi's RPC JSONL dialect over it, and registers the
   session with the Paseo daemon via `paseo import`.
2. **Shim** (`shim/pi-paseo-shim.js`) — configured as Paseo's pi provider
   command. When Paseo resumes a session, the shim checks whether that session
   has a live TUI (bridge pipe present). If yes, it pumps bytes between
   Paseo's stdio and the pipe. If no, it spawns the real `pi` with unchanged
   arguments, so Paseo-native sessions behave exactly as before.

The TUI process remains the **only writer** of the session `.jsonl` file.

```
TERMINAL                                    PASEO DAEMON
────────                                    ────────────
pi (TUI)                                    paseo import --provider pi <session-file>
 └─ pi-paseo-bridge (extension)                      │
     ├─ pipe: \\.\pipe\pi-paseo-bridge-<hash>        ▼
     │        (or $XDG_RUNTIME_DIR/pi-paseo/*.sock)  spawns provider command
     ├─ speaks pi RPC JSONL over it                  │
     └─ runs `paseo import` on session_start    pi-paseo-shim
                                                     ├─ session file from argv --session
         ◄───────── pipe/socket ───────────────────  ├─ pipe alive? bridge stdio<->pipe
                                                     └─ no pipe?   spawn real pi
```

## Install

1. **Extension** — copy (or symlink) the `extension/` directory into pi's
   global extensions directory:

   ```
   ~/.pi/agent/extensions/pi-paseo-bridge/index.ts
   ```

2. **Shim** — override Paseo's pi provider command in `~/.paseo/config.json`:

   ```json
   {
     "agents": {
       "providers": {
         "pi": { "command": ["node", "C:/path/to/shim/pi-paseo-shim.js"] }
       }
     }
   }
   ```

   Restart the Paseo daemon afterwards (`paseo restart`).

3. Make sure the `paseo` CLI is reachable: either on `PATH`, or set `PASEO_CLI`
   to its full path (the desktop app bundles it at
   `.../Paseo/resources/bin/paseo.cmd` on Windows).

To uninstall, remove the extension directory and the `command` override.

## Environment variables

| Variable | Effect |
|---|---|
| `PI_PASEO_BRIDGE=off` | Disable the extension entirely. |
| `PI_PASEO_BRIDGE_NO_IMPORT=1` | Open the bridge pipe but skip `paseo import` (session won't auto-appear). |
| `PI_PASEO_BRIDGE_DEBUG=1` | Log to `~/.pi/paseo-bridge/debug.log`. |
| `PI_PASEO_BRIDGE_FORCE=1` | Activate even when pi is not in TUI mode (testing only). |
| `PASEO_CLI` | Path to the paseo CLI used for registration. |
| `PASEO_HOST` | Forwarded to `paseo import --host`. |
| `PI_REAL_BIN` | Shim: path to the real pi binary (or its `cli.js`). |

## Known limitations (v1)

- Extension UI dialogs (`ask_user` etc.) render in the TUI only; they are not
  forwarded to Paseo.
- Timeline rewind from Paseo (`paseo_tree`) is rejected for terminal-attached
  sessions.
- Paseo's MCP tool injection (`pi-mcp-adapter`) does not apply to adopted
  sessions.
- If the TUI exits and Paseo later resumes the session itself, do not start a
  second TUI on the same session file while that Paseo agent is running — the
  two processes would both own the session file.

## Verification

- During a remote-driven turn, exactly one process (the TUI) has the session
  `.jsonl` open for writing.
- With the shim installed but no terminal session running, launching a pi
  agent from Paseo behaves exactly as stock.
