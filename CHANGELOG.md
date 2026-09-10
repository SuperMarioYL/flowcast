# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-09-11

### Fixed
- **`--timeout`/`--port` typos hung replay or crashed edit**: both numeric CLI
  options were coerced with a bare `Number(v)`, so a value like `--timeout 5s`
  silently became `NaN`. For `--timeout`, NaN flowed unchecked into Playwright
  and disabled the per-step timeout entirely — a replay against a missing
  selector hung forever with no error (verified: >150s with zero progress vs.
  a ~1s `SelectorMissError` with a valid timeout). For `edit --port`, NaN
  reached `server.listen(NaN)` and crashed with a raw `RangeError` that never
  named the flag. Both options now validate as integers at the parsing layer
  and reject bad input with a readable error naming the flag and the value
  (`Invalid --timeout "5s": expected a positive integer`). `--timeout 0` is
  rejected too (it previously insta-failed every step); `--port 0` remains
  valid (random free port, matching the documented default).

### Added
- **editor parameterization for `goto` urls and `extract` attribute values**:
  replay substitutes `{{param}}` on four step surfaces (goto url, fill value,
  select value, extract attribute), but the editor's editable field +
  "→ parameterize" pill only covered fill/select — a goto url sat in a
  disabled input and an extract attribute was not rendered at all, so
  `url: "{{host}}"` could only be produced by hand-editing the JSON. The
  editor now renders editable url and attribute fields with the same pill for
  goto/extract steps, and `parameterize()` writes the `{{key}}` ref into
  `step.url` for goto steps (auto-declaring the param with the current url as
  its default). Saves flow through the same Zod validation, so a goto url
  edited to an invalid value is rejected and the on-disk asset is untouched.

### Changed
- **package-lock.json version lockstep**: the lockfile's embedded package
  version (root and `packages.""`) had read `0.1.0` since the first release —
  five releases stale — and still carried a root `license: MIT` while
  package.json is Apache-2.0. The lock is regenerated during the v0.7.0
  lockstep, and a new `test/version.test.ts` asserts the VERSION file,
  package.json, package-lock.json (both embedded copies), and
  `web/site.json` `content_version` all agree, plus a matching CHANGELOG
  section — so no version surface can silently lag again.

## [0.6.0] - 2026-08-29

### Fixed
- **label-forwarded checkbox/radio/button clicks double-captured**: the
  recorder overlay's click handler emitted a click for the `<label>` itself
  whenever the user clicked a label (e.g. `<label for="chk">Remember me</label>`),
  AND the change handler emitted a click for the forwarded checkbox. Replay
  therefore toggled the box twice, leaving a recorded "check the box" as
  UNCHECKED (and a `<label for="submitBtn">` submitted the form twice). The
  click handler now skips `<label>` targets — a label is a non-interactive
  forwarder, and the forwarded control's own click/change is captured
  separately, so exactly one step is recorded.
- **date/time/datetime-local/month/week/color/range input values dropped during
  recording**: the change handler only emitted a `fill` for text-like inputs
  (`text|password|email|search|tel|url|number` + textarea); the value-bearing
  picker types fired `change` but were in neither the fill list nor the
  checkbox/radio list, so their picked value was silently dropped (a date
  replayed empty, a color replayed `#000000`). The change handler now captures
  these as `fill` steps carrying `el.value`, and the click handler skips them so
  a click does not also emit a value-less click. `file` inputs are intentionally
  left out (replay needs `setInputFiles`, not `fill`).

### Added
- **parameterized `goto` urls**: `{{param}}` references in a `goto` step's url
  are now resolved (no longer rejected) before navigating — the v0.4.0
  superRefine that blocked `{{param}}` in goto urls is gone, the goto branch
  substitutes via `injectValue`, and `referencedParamKeys` scans `step.url` so a
  url ref is declared/required like a fill/select ref. The single most visible
  hardcoded value in a flow (host/path/environment) can now be parameterized,
  completing the m2 parameterization story for multi-tenant/staging-vs-prod
  flows. zod's `.url()` already accepts brace templates; an unresolved url param
  errors loudly at replay via `resolveParams`/`injectValue`.

## [0.5.0] - 2026-08-14

### Fixed
- **submit/button-type input clicks dropped during recording**: the recorder
  overlay's click handler blanket-returned for all `input`/`textarea`/`select`
  tags, claiming they were "handled by change" — but the change handler only
  covers text-like inputs (fill) and checkbox/radio (click). `<input
  type="submit">`, `type="button"`, `type="image"`, and `type="reset">` clicks
  were silently dropped, so a recorded flow that submits a form via a submit
  input omitted the submit step and replay never submitted the form. The click
  handler now uses a type-aware guard: only text-like + checkbox/radio inputs
  and textarea/select are skipped; submit/button/image/reset fall through to
  emit a click.
- **extract step value not param-injected**: the `extract` action used
  `step.value` directly as the attribute name without calling `injectValue`,
  unlike the `fill` and `select` branches. A parameterized extract value
  (`{{attr}}`) was required by `resolveParams` but never substituted, silently
  using the literal `{{attr}}` string as the attribute name (→ null → empty
  extract). The extract case now calls `injectValue(step.value, values)` before
  using it as the attribute name, matching fill/select.
- **README license label drift (MIT → Apache-2.0)**: the LICENSE file and
  `package.json` are Apache-2.0, but the README.md footer and README.en.md
  badge + footer still said MIT. All README license references are now aligned
  to Apache-2.0 in both files.

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

[Unreleased]: https://github.com/SuperMarioYL/flowcast/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/SuperMarioYL/flowcast/releases/tag/v0.5.0
[0.4.0]: https://github.com/SuperMarioYL/flowcast/releases/tag/v0.4.0
[0.3.0]: https://github.com/SuperMarioYL/flowcast/releases/tag/v0.3.0
[0.2.0]: https://github.com/SuperMarioYL/flowcast/releases/tag/v0.2.0
[0.1.0]: https://github.com/SuperMarioYL/flowcast/releases/tag/v0.1.0
