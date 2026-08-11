# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-08-11

### Fixed
- **partial-heal persistence on later-step failure**: the `replay` action only
  wrote healed selectors back on full-replay success, so in a multi-step flow
  where an earlier step healed but a LATER step then failed, every heal
  performed before the failing step was silently discarded (and the LLM was
  re-billed on the next run). The action now snapshots `healHistory` lengths
  before replay and persists any heal that happened during this run (when
  `--write`) before re-throwing, so completed heals survive a later-step
  failure.
- **heal parse greedy regex**: `parseHealChoice` used a greedy `/\{[\s\S]*\}/`
  that spanned from the first `{` to the last `}`, so a chatty model (the
  default `gpt-4o-mini`) wrapping the answer JSON in prose containing braces
  (e.g. `(confidence {high})`) broke `JSON.parse` and heal silently failed. It
  now scans for balanced, string-aware `{...}` objects and returns the first
  that parses to a valid `HealChoice`.
- **goto url `{{param}}` not injected**: the goto branch used `step.url`
  verbatim (no `injectValue`, unlike fill/select), and Zod's `.url()` accepts
  `https://{{host}}/login`, so a `{{param}}` in a url navigated to a
  literal-brace URL and failed confusingly. The `StepSchema` superRefine now
  rejects `{{` in a goto url loudly so `validate`/`replay` fail fast.
- **edit hangs when tab closed without Save & close**: closing the browser tab
  without clicking "Save & close" fired no server-observable event, so
  `flowcast edit` hung on a leaked port forever with no SIGINT handler. The
  editor now registers SIGINT/SIGTERM handlers that call `stop()` (and remove
  themselves) so Ctrl-C frees the port and resolves `done`.
- **resolveLocator returns first on ambiguous match**: `resolveLocator`
  returned the first DOM element as soon as `count >= 1`, but the invariant is
  "exactly one element wins"; an ambiguous clue (e.g. `getByRole` matching
  several elements) silently picked the first element — possibly the wrong one.
  It now returns ONLY on `count === 1`, falls through to the next clue on
  ambiguity, and throws `SelectorMissError` (→ `--heal`) when no clue is
  unique; `bundleResolves` is tightened symmetrically.

## [0.3.0] - 2026-08-06

### Fixed
- **--no-write heal persistence**: the `replay` command now declares a positive
  `--write` flag (default true) alongside `--no-write`, so heal writeback
  persists by default and `--write` is a recognized option (previously only
  `--no-write` was declared, so `--write` was an unknown option commander
  rejected).
- **isDirectRun detection**: replaced the
  `import.meta.url === \`file://\${argv[1]}\`` string check with a `realpath`
  comparison so direct-run detection is robust on Windows backslash paths, paths
  with spaces / URL-special chars, and symlinked dirs (was silently disabling
  the CLI in those environments). Extracted as an exported `isDirectRun()`
  helper.
- **heal fetch timeout**: wrapped `defaultChat`'s LLM fetch in an
  `AbortController` with a 120s default timeout; on abort throws a readable
  "LLM request timed out after Ns" error so a stalled endpoint fails loudly
  instead of hanging `--heal` replay forever.

## [0.2.0] - 2026-08-01

### Added
- **m4 — validate command**: `flowcast validate <asset>` parses and Zod-validates a
  `.flow.json` with no browser and no LLM, reporting step/param errors with paths and
  a CI-friendly non-zero exit code. Reuses `parseFlowAsset` (zero new deps).

### Fixed
- **replay timeout budget**: `resolveLocator` now shares a single deadline across all
  selector clues instead of giving each at least 500ms, so a step's configured
  `--timeout` is honored when several clues miss (previously N clues could overrun by
  up to N×500ms — the exact stall on the `--heal` retry path).
- **recorder fill collapse**: `buildSteps` now collapses consecutive `fill` events on
  elements captured without a css/xpath selector (role+name/text only), so typing into
  such a field produces one fill step with the final value instead of one step per
  keystroke.

## [0.1.0] - 2026-06-23

### Added
- **m1 — record & replay asset**: record a multi-step human walkthrough on a real
  site and persist it as a schema-valid `.flow.json` flow-asset; replay it as-is
  with zero LLM re-inference.
- **m2 — parameterize & heal**: a local editor UI to parameterize captured step
  values (`{{param}}`); `replay --heal` re-locates a drifted selector against the
  live DOM using the SelectorBundle clues and your own LLM API key, then writes the
  repair back into the asset.
- **m3 — polished demo & example**: a runnable bundled sample asset
  (`examples/login-and-export.flow.json`), a scripted demo, and a bilingual README
  (zh primary + English sibling).

[Unreleased]: https://github.com/SuperMarioYL/flowcast/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/SuperMarioYL/flowcast/releases/tag/v0.4.0
[0.3.0]: https://github.com/SuperMarioYL/flowcast/releases/tag/v0.3.0
[0.2.0]: https://github.com/SuperMarioYL/flowcast/releases/tag/v0.2.0
[0.1.0]: https://github.com/SuperMarioYL/flowcast/releases/tag/v0.1.0
