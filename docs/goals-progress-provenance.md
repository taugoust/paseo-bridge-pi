# Goals ticket UI: provenance and integration

## Copied source and license

The Goals ticket presentation is copied and adapted from **Progress**, by Steve
Castaneda, in <https://github.com/stevecastaneda/paseo-plugins/tree/7aa34cc6c6ee66f38bfc8f4ff8c62b8c0692097e/progress>.
Reference revision: `7aa34cc6c6ee66f38bfc8f4ff8c62b8c0692097e`.
The complete required copyright and MIT permission notice is retained in
[`plugin/licenses/progress-MIT.txt`](../plugin/licenses/progress-MIT.txt).

| Progress source | Local adaptation |
| --- | --- |
| `client/tabs.tsx` (`TabStrip`, `Tab`) | `plugin/client/goal-ticket-ui.tsx`: bottom-rule tabs, hover/press tint, count badges; four fixed Goals tabs; narrow layouts omit icons/counts; public ARIA aliases supplement native accessibility props on the installed web host. |
| `client/row.tsx` (`PressableRow`, tint logic) | `goal-ticket-ui.tsx`: shared row feedback for goal list, assigned agent and questionnaire options. |
| `client/status-badge.tsx` | `goal-ticket-ui.tsx`: badge geometry and typography, mapped to actual delegated lifecycle states rather than ticket estimates. |
| `client/panel.tsx` (`TicketRow`, `ProgressBar`, `Segment`) and `client/time-bar.tsx` | `goal-ticket-ui.tsx`: compact goal rows and thin segmented bar; equal checklist segments, explicit task states, counts instead of percentages/time estimates; no shimmer or time-based inference. |
| `client/ticket-dialog.tsx` (`TicketStoryView`, `TimelineRow`, activity rows) | `plugin/client/delegated-goals.tsx` and `goal-ticket-ui.tsx`: summary/status/activity/bar/agent hierarchy followed by content tabs and actual timestamped rows. Detail stays in the Work workspace panel, not a modal. |
| `client/ticket-dialog.tsx` (`AgentRow`) | `plugin/client/goal-agent.tsx`: compact assigned-agent line; exact dedicated-child inventory correlation and existing route-time authorization replace upstream agent-ID-only navigation. |
| `client/write-up.tsx` (`WriteUp` inset and text styles) | `delegated-goals.tsx`: actual objective/checklist and create/edit form in the quiet inset. The optional, explicitly registered source/review subsystem now previews bounded text and PNG or opens HTTPS links; it does not copy upstream HTML/video/host-launch galleries. |
| `client/questions.tsx` (`QuestionView`, `QuestionDetail`, answer presentation) | `plugin/client/goal-questions.tsx`: prompt/options/description/selected-answer hierarchy. **Direct authenticated questionnaire answers replace Copy-to-chat**. |

Also inspected upstream `index.client.tsx`, `client/dialog-stack.tsx`,
`client/narrow.tsx`, and `shared/ticket-story.ts`, plus reference images
`images/1-panel.png`, `2-ticket.png`, and `3-question.png`.

Deliberately not copied: Explorer registration, modal navigation stack, attachment
and deliverable galleries, plugin installer, CLI/progress-file producer, inferred
by-time associations, estimates, elapsed-time forecasts or animation. The existing
Work Jobs/Agents/Worktrees/Goals navigation, source binding, history, compact
selection, draft persistence and lifecycle protections remain bridge-owned.

## Authoritative data boundary

`plugin/shared/workflows.ts` mirrors the coordinated producer's optional
`entry.story` contract from `pi-agent-extensions/workflows/goal-story.ts`:

- `version: 1`, `timeline` and `activity`, at most 200 records each.
- Durable record IDs (at most 128 characters), Unix-millisecond `at`, and explicit
  producer text (at most 4000 characters). Timeline has an enumerated lifecycle
  or task kind, optional task ID and explicit task status for transition colors.
  Completed indicators/segments use green, active work blue, blockers coral;
  task history is never classified by parsing its prose.
- Optional `questions`, at most 100. Each record has durable ID, revision,
  worker epoch, timestamp, status, the existing **questionnaire-only** request
  DTO, and optional recorded answer/answer time.
- Optional `coverage` marks actual timeline/activity/question eviction. Missing
  coverage is unknown, not proof of a complete archive. Timeline and settled
  history use bounded disclosure; pending questionnaires remain reachable.
- Missing story means no recorded history, not reconstructed events. No current
  chat prose, file timestamps, tool-call stream, cwd or task-name matching is used.

Question controls send `goals.answer` with the existing workflow session/service/
runtime/request identity, goal ID, opened entry revision, question ID/revision,
worker epoch and questionnaire answer. The producer must validate the exact
outstanding request and child, persist receipts and reject stale/replayed answers.
Pending questionnaire wording is deliberately neutral: this surface is not a
worker-to-human escalation inbox. The existing authenticated answer route remains
available; coordinator-first structured guidance is a separate integration, and
`notify_parent` delivery is not a questionnaire resolution receipt.
No permission approval DTO is accepted by this action. The UI retains rejected
answer drafts; a changed entry requires explicit review before resubmission.

Unassigned, Assigned (parent session), and Delegated (dedicated child) remain
separate groups in the same ticket list/detail UI, including completed history.
Assigned records are a read-only presentation of the existing snapshot, not a
migration into the child registry. Missing history, questions, and historical
usage remain unavailable rather than being invented. Launch models come from the
authenticated child launcher and are labeled as launch metadata, never guessed from
the parent/default model. Observation health and engine blocker/wake evidence remain
separate from goal lifecycle, checklist progress, and child navigation authority.

`capabilities.goalReview` enables explicit `goals.reference` registration and the
read-only `workflows_review` bridge RPC. Both require the existing session/runtime
binding and exact goal revision; the producer also checks the registered reference's
goal/task/child/attempt and the retained native task's read policy/workspace root.
Only UTF-8 text (32 KiB), bounded PNG (256 KiB, 16 million pixels) and HTTPS links are
supported. Symlinks/traversal, changed/deleted files and arbitrary preview paths are
rejected. Markup is selectable source text, never executed. Registration does not
change a terminal outcome. User-initiated JSON export uses the existing copy surface,
not automatic repo writes. Producer and bridge pins must be updated together for
these additive strict-schema fields; older producers omit unavailable metadata. Execution controls and
verified child links remain exclusive to the registry's dedicated-child path.
`goalAgentRoute` requires a complete, fresh inventory, exact task **and** child,
matching parent session, job/group and attempt, current runtime and native
agent/workspace hints. Navigation still calls the existing authenticated
`harness_subagent_route` and discards late responses after identity changes.
Canonical native names are validated using the existing bridge helper; known
names are retained within that exact binding without retaining a running claim.
No unavailable-chat explanation or disabled decorative Open chat is displayed.

## Runtime compatibility and validation

Adaptation uses public React Native primitives, `Icon`/`Modal` from
`@getpaseo/plugin/client/ui`, `TextInput` from its `react-native` export, and public
`useRpc`/`useAgent`. It does not import app stores, routes or private components.
The candidate was compiled with the installed Paseo **0.13.2** compiler and
substituted only in isolated Chromium browser contexts on the real installed web
host. Both complete bundles also compile with the immutable Paseo **0.14.0**
candidate, and 21 focused compiled UI/bridge tests pass with that compiler. No
native client update or deployment is required by these components.

Tests cover lifecycle/terminal/budget guards, exact assignment routing and late
responses, list selection and remounts, task counts/segment order/colors,
all three limit inputs and inheritance, stale revisions, the four tabs and
questionnaire identity/answer validation. Browser validation artifacts are local
under `.dev/` and are intentionally not release files. Rich lifecycle/story/
question scenarios are intercepted browser fixtures, **not claims that the
currently installed runtime already produces the new story contract**.
