# Activity → native context/usage

## Latest UI refinements

Native formatting now uses unprefixed plan window labels and host-rendered relative reset times. Duplicate app reset windows are omitted; distinct app resets use native windows with percentages intentionally absent. The account footer is just the email. Formatting-only deployment succeeded at `/nix/store/qfplcih60mf4d5is2ahgpr9h6nhc068y-nixos-system-matebook-26.05.20260916.4c78701`.

Subsequent usage ordering and conditional Work sizing deployment succeeded at `/nix/store/kgag9jv1s2yfdszssf0y66bqb9lb87ql-nixos-system-matebook-26.05.20260916.4c78701`, job `job-0c1fd45cdc7514375b4a54e8`. Output was read and job reaped; normal Nix checks/smoke restored. An earlier superseded build was cancelled before deployment and reaped.

- `pi-usage-card-order.patch`: daemon emits agent-context reports together in deterministic source/account order; web render ordering is also deterministic. OpenAI stays above Prompt cache. Global usage streaming is unchanged.
- `pi-plugin-popover-width.patch`: optional presentation-only desktop width, with viewport clamping and mobile defaults preserved. Work requests 880px only for populated Jobs/Agents views, including explicitly selected completed records. Empty views and Goals/Worktrees retain their previous sizing. Width changes do not replace behavior or close the popup.
- Refresh the desktop Paseo client for the host layout changes; no Pi restart is required. Device appearance remains for user review. No suites were run; changes remain unpublished.

The user also asked about worktrees for multi-repository container directories. Recommendation: discover/group child repositories and session-owned repositories, not create a dummy parent Git repository. The initial UI refinements did not implement discovery. It was subsequently implemented and deployed at `/nix/store/gm79v1i3p57407xj10xarqznj3glcn39-nixos-system-matebook-26.05.20260916.4c78701`; see `pi-agent-extensions/issues/workspace-repositories.md`. It requires loading the updated Pi workflow service via full restart/resume; post-restart UI confirmation is still pending.

## Current state: Codex-only usage

Usage is reported only for Pi sessions on `openai-codex/` models, from the session's selected Codex login. The built-in `openai` provider is no longer managed: it has no named accounts, session selection or usage source here. The earlier experimental path that read `openai` usage through a separate Codex login, its opt-in settings file and its native-registration proof have been removed from the bridge and from Pi.

## Earlier investigation history

## Scope and constraints

User requested removal of Activity from normal UI, cache metrics in native context-window/usage details, and correction of stale account identity. Expected account: `theofilos.augoustis@gmail.com`; previously displayed: `katsiaryna.kryvaltsevich@gmail.com`.

The user resumed the paused task with “Continue”. No tests, smoke scripts, typechecks or extra check suites. The user later explicitly authorized read-only profile/usage diagnosis (no model calls, credential refresh or account switching). Production build/deploy is authorized for review. Keep this entire review batch uncommitted/unpushed. Do not switch accounts, mutate credentials, replay prompts, or reload the active Pi turn automatically.

## Source findings

Upstream source: `/nix/store/8lqqjlr5a01j5yddzj74vgp97kr293d6-source`.

- Builtin `codex-usage-source` used global Pi `auth.json` for a Pi/OpenAI session, ignoring named session selection.
- Native usage discovery retained the old mapping while session key, provider and model were unchanged; account changes did not invalidate it.
- Native reports have a five-minute fetch cache. Local cache metrics need a separate freshness locator.
- Merely matching a profile name to a daemon-side file does not prove it is the runtime's selected account. The runtime now publishes a safe account/user-identity hash for an actually applied named OAuth grant, distinguishing different users sharing a team account.

These were the initial source findings. The later authorized live diagnosis below corrected the assumption that this user's session used a named account.

## Implementation

### Bridge

- `plugin/index.client.tsx` no longer registers Activity. Old dashboard source/backend data remain dormant; no replacement prompt-history UI was added.
- `plugin/server/cache-usage.ts` registers native **Prompt cache** details: latest/session hit rate, cached/fresh input tokens, optional cache-write tokens. No fake quota windows or estimated dollar savings.
- Cache locators bind agent, session and runtime epoch and use a five-second sample. Reads recheck the private descriptor and validate the snapshot. No provider request is made for cache metrics.
- Cache accounts are `sessionOnly`, so the global account list is not filled with one card per conversation.
- `plugin/server/session-account-usage.ts` registers native quota for the verified selected account. (Since superseded: it now covers only `openai-codex/` models.)
- It verifies live account-controls state, privately reads a bounded no-follow account-store file, and requires its decoded account identity to match the runtime's `usage.accountKey`. Profile names are never confused with provider account IDs.
- Private credential/runtime fingerprints select stable random locators. Public usage inputs contain only agent ID and random handle. Credentials/capabilities/fingerprints never appear in reports or inputs.
- Identity and exact local grant are rechecked around the read-only quota request. Requests have a timeout, reject redirects, bound the response, and use the selected account header. No OAuth refresh or writes.
- Window labels come from reported duration through native helpers; absent durations are not guessed. Additional/model-specific limits, code-review limits and credits are preserved. Mapping retains Paseo Apache-2.0 attribution.
- Built-in/default login, API keys, pending/disconnected bindings and older runtimes without identity proof report unavailable, never another login's quota. This limitation is intentional; no verified default-credential interface exists yet.
- `plugin/index.server.ts` registers both sources; `plugin/shared/account-controls.ts` accepts the optional proof. Minimum Paseo is 0.11.4 plus the downstream session-usage patch.

### Pi core

- `shared/account-controls.ts`: optional `usage.accountKey`.
- `openai-accounts/account-controls.ts`: publishes SHA-256 of the provider account and user identity only for an active, non-pending named OAuth grant whose exact credential is locally applied. It is not a credential hash. Conflicting account identities fail closed.
- No changes to selection, credential storage or provider execution.
- **Pi reload after deployment is required for this identity proof.** Without it, account usage is unavailable rather than wrong.

### Nix/Paseo

`packages/paseo/pi-session-usage-identity.patch`, registered in `default.nix`:

- Injects authoritative `PASEO_AGENT_ID` into session usage scope.
- Re-discovers Pi mappings and guards against older overlapping discoveries/session transitions.
- Stops builtin session-Pi/global-auth fallback; preserves other providers and global discovery.
- Adds generic optional `UsageAccount.sessionOnly` and excludes those records from the global merged list.
- Refreshes native context usage every five seconds while mounted; unchanged verified quota locators retain the normal provider-report cache.

The initial helper draft was replaced with a mechanically generated upstream diff. Parent source review replaced the initial selected-account helper implementation and added the missing Pi-side identity proof.

## Deployment status

Production review build and switch succeeded. The initial deployment (`job-4637582e541bbf98292e7cb9`) was followed by a successful deployment of the account/user identity refinement and full quota mapping (`job-7d7ce96cee17b41e9185666d`). Both outputs were read and both jobs reaped.

The initial feature deployment was `/nix/store/fjl3advpzjpk8xkg3rbcf5z9sa5rzj70-nixos-system-matebook-26.05.20260916.4c78701`. The corrected unsupported-login status is now deployed as:
`/nix/store/yfv31rf11idnzmbsisb1p07fk0kvddpj-nixos-system-matebook-26.05.20260916.4c78701`.

Checks and installed smoke were omitted for these user-authorized review builds. `doCheck = true` is now restored in both `nix-config/packages/paseo/default.nix` and `packages/paseo-tmux-bridge/default.nix`, and the installed daemon smoke invocation is restored. No tests or live quota probes were run. Existing test expectations for the removed Activity UI and builtin Pi-global-login fallback were not validated in this review batch.

For compatible named-account quota, the live session must publish the identity proof. **This user's actual default login is not such an account; further reloads will not enable its quota.** Reopening context/usage picks up the corrected message; no Pi reload is needed for this message-only correction. Mobile presentation remains unverified; do not infer live correctness from build success.

## Authorized live diagnosis after the reload report

The user reported that binding validation still failed after reload, then explicitly allowed read-only API diagnosis.

- Live parent `f8c615d5-4caa-4923-81f7-3293e34e10b1` snapshot: `currentAccountId:null`, `defaultSelected:true`, `usage.status:local-binding-confirmed`, `effectiveCredential:chatgpt-grant-configured`. No named-account proof is expected. The earlier named-account assumption was wrong for this session.
- Native builtin `readHarness` hardcodes `openai-codex` for Pi. The legacy credential's email claim matches the older account. It is not the active provider key `openai`.
- The current `openai` grant uses Pi 1.0's newer ChatGPT OAuth (`chatgpt.tokens.use.direct`). Its JWT has encrypted auth metadata rather than readable account/email fields. SDK code intentionally discards the ID token.
- OpenID discovery advertises `https://auth.openai.com/api/accounts/oauth/userinfo`. With the current grant it returned HTTP 200 containing only `sub`, not email.
- The existing `https://chatgpt.com/backend-api/wham/usage` endpoint returned HTTP 401, error code `no_matching_rule`, with the same current grant. No compatible replacement usage endpoint has been established; this is not evidence that no other endpoint exists.
- The expected email was therefore **not verified**. No token values or full auth records were output, no account was switched, and no credential was refreshed or written. A temporary local adapter kept Authorization values out of tool arguments; it was shut down/reaped and its script removed.

Correction: distinguish unsupported default OAuth, API-key quota, missing identity proof, and genuine fetch failures. Do not advise reload as a remedy for an unsupported login. Keep cache metrics and refuse legacy-account substitution. Actual quota support for the current newer login remains incomplete, pending a compatible provider interface.

The correction's production build/switch (`job-82b217aa49cc0b7de63e64cd`) succeeded; output read and job reaped. Normal Nix checks/smoke were restored afterward. No test suites ran. Changes remain unpublished.

```sh
cd /home/taugoust/Workspace/nix-config
sudo -n nixos-rebuild switch --flake .#matebook --no-write-lock-file \
  --override-input pi-agent-extensions git+file:///home/taugoust/Workspace/pi-agent-extensions \
  --override-input paseo-bridge-pi git+file:///home/taugoust/Workspace/paseo-bridge-pi
```

Last previously successful deployment:
`/nix/store/ip74hv8lyg858hhd1ij9m48nf8haipp8-nixos-system-matebook-26.05.20260916.4c78701`.

All implementation helpers from this resumed task have been read and reaped. Format job was read/reaped. New files are staged only for Git-flake inclusion, not committed. Live account identity and UI behavior remain for user review; production build success is not evidence of those behaviors.
