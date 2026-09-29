# Paseo Permission Gate prompt-mode control

## Status

Bridge API and optional `plugin/` composer control implemented and tested; pending deployment and live app visual confirmation.

## Validation

- Bridge suite: 100 passed, 9 opt-in integration tests skipped in the default run.
- New no-model real-Pi operator integration: passed separately with Pi 0.85.0.
- Plugin: 11 tests passed, including compiled client lifecycle and compiled server/real bridge interoperability using Paseo 0.10's compiler.
- Bridge TypeScript check and whitespace check passed.
- Full plugin declaration typecheck is not configured; frontend dependencies are absent from the installed server SDK. Actual bundles compile and their non-visual runtime paths are tested.
- No launcher, gate implementation, AgentSH policy, or live service changes were needed under the approved local-trust scope.

## Contract

The Paseo bridge serves a dedicated `${bridgeSocket}.operator` endpoint while a controller is attached. Its private descriptor is stored at `~/.pi/paseo-bridge/operators/<sha256(agentId)>.json` (lowercase hex SHA-256 of the UTF-8 agent ID), mode 0600 under a mode-0700 owner-checked directory. Descriptor fields: `version`, `socketPath`, `capability`, `agentId`, `sessionId`, and `runtimeEpoch`.

One JSONL request/response per connection, maximum 4096 bytes before newline. Requests have `v:1`, `type:"permission_gate_mode"`, `id`, `capability`, exact agent/session/runtime identities, and `action:"status"` or `action:"set"` (set additionally requires boolean `enabled`). Success returns those identities and current `enabled` state. Errors fail closed. `runtimeEpoch` rotates on bridge bind/reload and controller disconnect. The existing live in-process Permission Gate operator remains the authority; its own guard-only/active-session checks run for each operation.

No chat, prompt, slash-command, abort, or turn interruption is dispatched. Prompt mode off does not disable mandatory AgentSH authorization. Capability does not appear in public RPC state or the runtime registry. Descriptor is published only when the Paseo controller is connected and `operator.status(sessionId)` succeeds; it is removed on disconnect and shutdown.

## Trust model / limitation

This implements the user-approved trusted-local desktop model. The descriptor and UDS permissions prevent accidental cross-session use; they do not defend against malicious same-UID code. In guard-only `pi-unsafe`, AgentSH's Permission Gate rendezvous verifies the launched Pi PID but does not sandbox Pi's files, processes, or sockets. Model-executed shell can therefore read same-UID state, including this descriptor. Do not call this OS authentication or claim mode 0600 protects against same-UID shell. The capability is a local-trust protocol defense in depth, not a secret from the model under that threat model.

The endpoint must only be used by a trusted Paseo plugin/backend, never exposed as a model tool or public RPC response. A stronger threat boundary requires a separate OS identity/sandbox or independently authenticated host-side broker.
