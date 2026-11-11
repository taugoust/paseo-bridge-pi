# Composer ownership and tool-text provenance

## Status

Implemented and source-reviewed; coordinated deployment and extensive live acceptance are pending.

## Scope

Exactly one account control per current/new Pi chat, alongside Work and btw. The bridge owns Pi's exact-session account action; the `paseo-accounts` plugin must yield only its competing Pi composer pill when the bridge is enabled. Its management, usage and non-Pi controls remain available. Background chats remain background.

Share one installation-local, paginated background-inclusive agent directory across contributions. Preserve updates/removals racing pagination, retain controls during temporary discovery failures, retry safely, and balance overlapping installation/disposal leases. Detached account popovers cannot query a replaced session.

Normalize typed tool-result envelopes before producer truncation. Preserve literal string output, clean terminal controls before clipping, and carry explicit `resultFormat: "text"` through retained/live transport to prevent the UI from interpreting literal JSON as an envelope. Existing unmarked producers retain bounded legacy compatibility. Partial legacy JSON is never guessed or reconstructed.

## Evidence before deployment

- Independent gpt-6-astra source review approved the directory, ownership, lifecycle and text-provenance changes.
- Actual installed Paseo compiler: 23 account/Work/btw/security/usage tests passed, zero skips.
- Nix pure helpers: 135 passed, zero skips.
- Producer Nix runtime: 143 passed, zero skips, plus real reload fixtures.
- Baseline authenticated web evidence demonstrates both `Codex account · this chat` and `Account: Codex` on compact layouts. The `paseo-accounts` ownership patch is required; bridge changes alone do not fix that duplication.

Final release evidence must include repeated navigation/reload checks across parent and background children, exact served bundle provenance and ownership-safe live account/naming/tool tests. Web evidence must not be described as native iPad execution.
