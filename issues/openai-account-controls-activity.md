# Native OpenAI account controls and usage behavior

## Status
Superseded: account controls and usage now cover only the `openai-codex` provider. The built-in `openai` provider has no managed accounts.

Phase 2 implementation is deployed and tested. Accounts controls are native header controls, not part of Activity. Visibility of the Accounts header button on the user's device remains unresolved and is not device-verified. Native Usage behavior is unchanged.

Implement OpenAI/ChatGPT account identity and official usage navigation through native account controls. Initial UI supports Pi's built-in login and existing named accounts only; users add named accounts through Pi `/accounts`. Never copy existing credentials into named storage or accept remote secret entry. Do not estimate quotas or modify `/fast`.

Account mutations require explicit native confirmation and use a separate capability-authenticated private bridge socket, bound to agent, session, runtime epoch, and account-service epoch. Requests carry request IDs and selection revisions; ambiguous outcomes are not automatically retried. Switching is disabled while busy or stale. The readonly harness endpoint remains unchanged and no model prompt is dispatched.

The native account popup displays account/auth controls. Numerical token/cache metrics remain in the separate Cache section; native Usage behavior is unchanged.

## Validation
Bridge regression tests and typecheck passed. Compiled UI tests cover confirmation/cancel, double-confirm suppression, preflight close/reopen, busy/stale state, safe activation errors and uncertain-outcome reconciliation. Contract tests use the real core snapshot shape. The opt-in `compiled-account-runtime.test.mjs` joins the actual Pi SDK account service, compiled plugin backend and private transport using fake credentials and blocked networking; switching preserves model context and makes no model call. Installed UI/transport match local source and the plugin is running. Real account/login has not been performed. User-visible Accounts header-button availability on device remains unresolved; no device verification is claimed.
