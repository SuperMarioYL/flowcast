# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/SuperMarioYL/flowcast/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/SuperMarioYL/flowcast/releases/tag/v0.2.0
[0.1.0]: https://github.com/SuperMarioYL/flowcast/releases/tag/v0.1.0
