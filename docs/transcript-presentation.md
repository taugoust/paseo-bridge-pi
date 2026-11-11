# Work transcript canonical presentation

Work background history/live events and foreground activity use one bridge badge/model. Classification and text policy are the **actual existing native Pi implementation**, not copied helpers or another local JSON formatter.

## Bundled canonical code

The Paseo daemon plugin compiler explicitly bundles:

- `@getpaseo/server/pi-tool-presentation`: narrow reexports of unchanged `parseToolArgs`, `parseToolResult`, `mapToolDetail`, and `nativeToolErrorText`;
- public protocol `tool-call-display`, `generic-tool-presentation`, and `paseo-tool-presentation/index`;
- existing canonical highlighting, spinner and markdown metrics.

The native provider keeps using those same implementations. Only the mapper's erased return-type import was redirected to public protocol types. No native app source, native runtime SDK or private app context is added. Runtime imports elsewhere in the server package remain forbidden for client/shared code; aliases cannot traverse into descendants. Every presentation runtime dependency is explicitly reviewed, and ambient I/O/dynamic loading fails compilation. The daemon runtime trace and installed declaration closure include the new pure entry.

`native-tool-presentation.ts` adapts the mapped detail union to public RN prose/fields/code surfaces. It has no tool-name classifier or divergent generic label builder. Reserved prototype names are unclassified safety input. The former bridge `toolDetailSections` classifier/JSON section builder was removed.

## Typed transport without leaking machine internals

The coordinated producer/bridge contract adds optional:

```ts
toolPresentation?: { version: 1; toolName: string; result: KnownSafeResult };
toolArguments?: KnownSafeArguments; // readonly call part / live start
```

Foreground activity additionally carries authoritative call ID, explicit call/result phase, projected arguments, status and `resultFormat: "text"`. Old snapshots still work. Source text is unchanged as fallback; strings and embedded JSON are never parsed by the new projector.

The mirrored `shared/tool-presentation.ts` contract is a security boundary, **not duplicated native presentation policy**. It allowlists only canonical-consumed fields, validates exact enclosing tool names, and rejects prototype keys, symbols, accessors, cycles, nonfinite numbers, malformed records and oversized values. It is dependency-free and needs neither Buffer nor TextEncoder in the client. Known public Paseo catalog parameters are limited to reviewed scalar/string-array fields; arbitrary settings/headers/credentials objects are excluded rather than passed through.

Bounds: 16 KiB encoded envelope; depth 12; 1,024 traversal nodes; arrays 64; individual strings 8 KiB; 256 strings including keys. Existing text clipping/page budgets remain. Live event pagination measures its complete serialized page, not only the event array. Commands, normal tool file paths and independent user-visible stderr are retained only where native policy consumes them. Capabilities, control sockets, session-file paths and ownership manifests are not new presentation fields.

Native result provenance matters:

- Live: validate the actual result using native `parseToolResult`; native error helper sees the original display-safe live result.
- Retained/foreground: mirror native history's `{content, details}` input; lifecycle `message.isError` stays separate. It must not become an extra result field or change the native body policy.
- Text, metadata and source origin are selected together. New raw live output cannot inherit stale history metadata. End-event schema defaults do not erase authoritative safe start arguments. A new explicit start clears stale completion data.
- Foreground collapses a call/result only with one exact ID/name match and explicitly producer-bound arguments. Unknown/legacy/ambiguous input remains visible and is never reconstructed from argument JSON text.

The concrete background-job start now obtains name/status/action from typed producer details. Raw header prose never establishes success or job identity. If typed metadata is absent/rejected/out of bounds, raw output remains verbatim, matching native raw-string fallback.

## UI and ownership boundary

Existing shell/file/diff surfaces, Read offsets, native-compatible geometry, expansion and child navigation remain. File offsets/diff data come from the native mapper, not guessed output patterns. Canonical prose is not rendered as code; explicit native errors use a danger-colored code surface.

Open child chat still resolves the existing child using the same source session/runtime, task/child/group, attempt and runtime tuple. Presentation task IDs and verification labels are never navigation/control authority. The reviewed descendant tree, source/parentKey, limits/pagination and after-read identity checks are preserved.

This does not claim whole-renderer or native-device identity: private sheets, virtualization, native markdown/link/image services and UI contexts are not imported. Markdown retains the bounded bridge tokenizer with canonical metrics; media remains safe placeholders. Native out-of-band extension hydration/dialog/todo activities are separately audited in the parity matrix.

## Focused verification

```sh
PASEO_PLUGIN_COMPILER=/path/to/modified/compiler.js \
  node --test plugin/test/compiled-transcript-canonical.test.mjs
PASEO_PLUGIN_COMPILER=/path/to/modified/compiler.js \
PI_EXTENSIONS_PRESENTATION=/path/to/pi-agent-extensions/shared/tool-presentation.ts \
  node --experimental-strip-types --test plugin/test/compiled-tool-presentation-transport.test.mjs
node --experimental-strip-types --test \
  plugin/test/native-tool-details.test.ts \
  plugin/test/native-tool-presentation-safety.test.ts \
  plugin/test/transcript-tool-flow.test.ts
```

The compiler package has focused installed-closure, exact-boundary/purity and Hermes checks. Browser artifacts under `.dev/transcript-browser/` use the actual emitted candidate and real shipped Paseo components, with fixture-only tool data generated by production retained/live/foreground serializers. Only an exact read-only bootstrap allowlist reaches the daemon; agent sends, attention changes, heartbeats and mutations are blocked. Screenshots are wide/narrow native-versus-Work pairs, not standalone HTML. The source-compiled compiler/staged dependency qualification and emitted hashes are recorded in `build-evidence.json`. This is not a rebuilt installed compiler, full Nix integration check or native-device execution proof.
