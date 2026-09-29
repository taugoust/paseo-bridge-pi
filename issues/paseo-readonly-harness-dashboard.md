# Read-only jobs and subagents in Paseo

## Scope

Add agent-specific Jobs and Pi subagents panels to the existing plugin. User chose read-only views: list/status, bounded job output, native task reports, and verified child-chat navigation. No chat commands, cancellation, cleanup, resume, messaging, or notification acknowledgement.

## Boundaries

A separate, private read-only bridge endpoint works independently of permission-gate authority. Requests bind the exact selected Paseo agent, Pi session, and bridge runtime epoch. Detail requests require the identity confirmed by the status response. The harness exports allowlisted session-owned DTOs; private manifests, capability values, environment, and arbitrary file paths are not exposed to clients. The approved same-UID local-trust limitation remains unchanged.

Lists show up to 50 direct session-owned jobs/native tasks. Output/report text is bounded. Retained task snapshots are labeled stale rather than represented as fresh observation. Unsupported backends are explicit. Child navigation requires an unambiguous live runtime identity match; missing/reaped children are not guessed.

## Status

Implementation and validation in progress. Deployment is separate. The requested publication sequence is commit, pull latest changes, enable the plugin in the shared DOS configuration, validate, and push updated pins.
