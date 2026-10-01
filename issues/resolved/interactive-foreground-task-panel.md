# Interactive foreground-task panel

## Status

Resolved in `9a67610`. Companion runtime: `pi-agent-extensions` commit `0fc2261`. No existing worker or DOS deployment was changed.

## Goal

An agent-bound composer button opens a temporary Paseo popover/bottom sheet for headless foreground helpers. It must not create a tmux object, workspace tab, or separate Paseo agent. Users can inspect conversation, send instructions, answer questionnaires, decide individual permission requests, and stop a helper. Closing/reopening the view preserves the task and client drafts rather than cancelling work.

## Boundaries

- Use a separate authenticated private task-control endpoint; preserve read-only Jobs/Subagents APIs and the narrowly scoped permission-mode operator.
- Validate the current agent, workspace, parent session/service epoch, task/child identity, worker epoch and per-action idempotency key.
- Disable stale/unavailable controls. No implicit approval or automatic mutation replay on reconnect.
- Show running/input/approval/completed state from the button while the panel is closed.
- Retain accessible scrolling and keyboard behavior using supported Paseo plugin components only; no upstream/client-app changes.
- Validate against the real `pi-agent-extensions` foreground runtime, not only a fake core service.

## Validation

Bridge typecheck and 105 root tests passed; 17 plugin tests and Paseo 0.10 plugin compilation passed. All six compiled tests passed, including the real private-socket/backend integration with `HeadlessForegroundManager` and actual Pi RPC workers. Tests cover explicit permission/questionnaire answers, same-worker close/reopen, direct-user input provenance, Stop with retained history, stale identities, in-flight close/reopen, and drafts. No tmux placement was created for those helpers.

The temporary view uses the supported composer popover/bottom-sheet API, not a new workspace tab or agent. Native iOS/Android visual confirmation remains untested. Existing Jobs/Subagents panels remain read-only. The user authorized coordinated implementation, Nix pin updates, and isolated Matebook testing; existing workers and DOS deployments remain unchanged.
