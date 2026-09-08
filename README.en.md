**English** | [简体中文](README.md)

<picture>
  <source media="(max-width: 640px) and (prefers-color-scheme: dark)" srcset="assets/presentation/hero-mobile-dark.svg">
  <source media="(max-width: 640px)" srcset="assets/presentation/hero-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/presentation/hero-dark.svg">
  <img src="assets/presentation/hero-light.svg" width="1000" alt="Record, edit and replay parameterized browser flows with steps and locator clues stored in a structured asset.">
</picture>

**Record, edit and replay parameterized browser flows with steps and locator clues stored in a structured asset.**

`v0.6.0` · `Node.js 22+` · [Apache-2.0](LICENSE)

[Website](https://flowcast.lei6393.com) · [Demo record](docs/demo-results.json)

## Why use it

Repeated logins, forms and extraction tasks often share fixed steps with a few changing inputs. FlowCast saves steps in .flow.json and injects input parameters for repeatable review and execution. When a page changes, replay first tries existing locator clues; optional model repair follows only after those fail.

## Architecture

<picture>
  <source media="(max-width: 640px) and (prefers-color-scheme: dark)" srcset="assets/presentation/architecture-mobile-dark.svg">
  <source media="(max-width: 640px)" srcset="assets/presentation/architecture-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/presentation/architecture-dark.svg">
  <img src="assets/presentation/architecture-light.svg" width="1000" alt="The Zod schema in asset.ts defines actions, parameters and SelectorBundle. record captures browser actions, params resolves variables and replay executes goto/fill/click/select/waitFor/extract through Playwright. heal submits DOM and clues to the configured model and records healHistory; the local editor updates assets.">
</picture>

The Zod schema in asset.ts defines actions, parameters and SelectorBundle. record captures browser actions, params resolves variables and replay executes goto/fill/click/select/waitFor/extract through Playwright. heal submits DOM and clues to the configured model and records healHistory; the local editor updates assets.

Source entry points: [src/asset.ts](src/asset.ts) · [src/params.ts](src/params.ts) · [src/replay.ts](src/replay.ts) · [src/record.ts](src/record.ts) · [src/heal.ts](src/heal.ts) · [src/cli.ts](src/cli.ts) · [schema/flow-asset.schema.json](schema/flow-asset.schema.json)

## Install

Requires Node.js 22+ and Chromium. The example starts a temporary local HTTP server and uses a real headless browser, without a remote site.

```bash
git clone https://github.com/SuperMarioYL/flowcast.git
cd flowcast
npm ci
npm run build
npx playwright install chromium
```

## Quickstart

A self-contained script supplies complete HTML and a four-step asset, injects name=Lin, fills the form and extracts the result. It uses no LLM and does not validate remote sites or healing.

```bash
node examples/presentation-demo.mjs
```

Complete inputs and execution steps are included in the commands above and the [demo record](docs/demo-results.json).

## Usage

```bash
node dist/cli.js validate examples/login-and-export.flow.json
node dist/cli.js record login.flow.json --url https://example.com/login
node dist/cli.js edit login.flow.json
node dist/cli.js replay login.flow.json --param account=alice
```
Use an accessible real page for recording. `--headed` shows replay; `replay --heal --no-write` repairs only the current run without saving the asset. Required missing parameters produce an error.

## Recorded demo

<picture>
  <source media="(max-width: 640px) and (prefers-color-scheme: dark)" srcset="assets/presentation/process-mobile-dark.svg">
  <source media="(max-width: 640px)" srcset="assets/presentation/process-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/presentation/process-dark.svg">
  <img src="assets/presentation/process-light.svg" width="1000" alt="A self-contained script supplies complete HTML and a four-step asset, injects name=Lin, fills the form and extracts the result. It uses no LLM and does not validate remote sites or healing.">
</picture>

### Replay the local form

Returns ok=true, stepsRun=4 and Hello, Lin.

```text
$ node examples/presentation-demo.mjs
{
  "ok": true,
  "stepsRun": 4,
  "extracted": {
    "result": "Hello, Lin"
  },
  "healed": false
}
```

## Capabilities and integration

<picture>
  <source media="(max-width: 640px) and (prefers-color-scheme: dark)" srcset="assets/presentation/integrations-mobile-dark.svg">
  <source media="(max-width: 640px)" srcset="assets/presentation/integrations-mobile-light.svg">
  <source media="(prefers-color-scheme: dark)" srcset="assets/presentation/integrations-dark.svg">
  <img src="assets/presentation/integrations-light.svg" width="1000" alt="Normal replay needs no model. record and edit use an interactive browser; validate checks asset structure and parameters only. With heal enabled, page DOM is sent to the configured Chat Completions service.">
</picture>

Normal replay needs no model. record and edit use an interactive browser; validate checks asset structure and parameters only. With heal enabled, page DOM is sent to the configured Chat Completions service.



## Configuration

Healing reads `FLOWCAST_LLM_API_KEY` (or OPENAI_API_KEY), `FLOWCAST_LLM_BASE_URL` and `FLOWCAST_LLM_MODEL`. Steps accept timeoutMs and redundant CSS, XPath, role/name, text and structural clues. The example contains no private credentials; inspect values in real recorded assets.

## Roadmap and scope

Recording, editing, validation, replay and optional repair are implemented. Hosted scheduling, team collaboration and failure notifications remain future service directions.

- Layout, authentication and business-logic changes can invalidate an asset; replay and model repair do not guarantee permanent success.
- The demo tests local-form replay, not the recording UI or live-model repair.

![Terminal recording](assets/demo.gif) · [Recording script](docs/demo.tape)

## License

[Apache-2.0](LICENSE)
