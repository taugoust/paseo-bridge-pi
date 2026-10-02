# Fork subprocess inherits ambiguous Paseo daemon selectors

## Status

Resolved.

## Problem

Forking a conversation opened a new tab with `could not list Paseo agents: TARGET_AMBIGUOUS` when both `PASEO_HOST` and `PASEO_HOME` were inherited. Passing a host argument alone did not remove the conflicting home environment. Archive inspection had the same inherited-target problem.

## Resolution

`2b15199` shares target selection between agent listing and archive inspection. An explicit host is passed through and the conflicting home variable is removed only from the child environment. Home-only and default selection remain supported; the parent environment is unchanged.

Validation: typecheck and 108 tests passed (9 existing opt-in tests skipped). Hermetic subprocess tests cover both-selector and home-only environments; the installed CLI was also checked against the reported ambiguity. No service deployment or restart was performed.
