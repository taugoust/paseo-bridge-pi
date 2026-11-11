# Unified native-style Activity dashboard

## Status
Implemented and automated validation passed. Deployment and native iOS visual verification pending.

## User decision
Replace the three feature tabs with one centralized Activity dashboard. Also show progress using Paseo's native conversation task cards.

## Implementation
- Use public Paseo SettingsSection/SettingsCard surfaces with themed React Native controls.
- Show Progress, Cache, and Recent responses together; independently fetch all sections with host/agent/workspace/session/runtime-bound query keys.
- Progress has an accessible completed/total meter and prioritizes active/blocked steps, with expansion for the remaining steps.
- Cache has an accessible hit-rate meter, compact estimates, and expandable detailed metrics/trends. Unknown accounting is displayed as unavailable, never a fabricated zero.
- Responses have compact time/model/duration/cost rows, expandable token details, and optional tool timing. Session/runtime changes remount section state; unavailable queries hide old content.
- Retain one Activity pill and one Refresh action. No extra model requests, mutations, or configuration changes.
- The matching nix-config Paseo patch maps successful update_progress v5 results into native todo timeline items for live and persisted history. Blocked steps remain incomplete with an explicit label.

## Validation
Plugin suite: 26 passed, 1 optional real-worker test skipped, using the rebuilt Paseo 0.11.4 host compiler. Bridge suite: 133 passed, 9 optional skipped; bridge typecheck passed. Compiled dashboard tests cover native host component exports, all sections at once, meters and unknown state, expansion controls, shared refresh, per-feature errors, session isolation, and cleanup.

Native iOS layout, scrolling, text scaling, colors, expansion, and conversation task cards require device verification after activation. No deployment performed as part of implementation.
