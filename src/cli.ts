#!/usr/bin/env node
/**
 * FlowCast CLI entry point.
 *
 * Subcommands:
 *   record  — capture a human walkthrough into a `.flow.json` asset.
 *   replay  — re-execute it deterministically (zero LLM calls on the happy path).
 *             `--heal` re-locates a drifted selector against the live DOM using
 *             your own LLM API key and writes the repair back into the asset.
 *   edit    — open a local UI to parameterize captured steps and prune them.
 */
import { Command } from "commander";

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { record } from "./record.js";
import { replayAsset, type HealHook } from "./replay.js";
import { parseParamPairs } from "./params.js";
import { createHealHook } from "./heal.js";
import { startEditor } from "./ui/editor.js";
import { readFlowAsset, writeFlowAsset, type FlowAsset } from "./asset.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("flowcast")
  .description(
    "Record a browser walkthrough once, replay it forever, self-heal when the site changes.",
  )
  .version(readVersion(), "-v, --version", "print the FlowCast version");

program
  .command("record")
  .description("Record a browser walkthrough into a .flow.json asset")
  .argument("<output>", "path to write the .flow.json asset")
  .option("-u, --url <url>", "start URL to open before recording begins")
  .option("-n, --name <name>", "friendly name for the asset")
  .action(
    async (
      output: string,
      options: { url?: string; name?: string },
    ) => {
      console.log("Launching Chromium — walk through your flow, then close the window to save.");
      const asset = await record(output, {
        startUrl: options.url,
        name: options.name,
      });
      console.log(
        `Saved ${asset.steps.length} step(s) to ${output} (asset "${asset.name}").`,
      );
    },
  );

program
  .command("replay")
  .description("Replay a recorded .flow.json asset (zero LLM calls on the happy path)")
  .argument("<asset>", "path to the .flow.json asset")
  .option(
    "-p, --param <key=value>",
    "set a parameter value (repeatable)",
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option("--headed", "show the browser while replaying", false)
  .option("--timeout <ms>", "per-step timeout in milliseconds", (v) => Number(v))
  .option(
    "--heal",
    "on selector drift, re-locate against the live DOM with your own LLM API key",
    false,
  )
  .option(
    "--write",
    "with --heal, write the repaired selectors back to the asset (default; --no-write disables)",
    true,
  )
  .option(
    "--no-write",
    "with --heal, do NOT write the repaired selectors back to the asset",
  )
  .action(
    async (
      assetPath: string,
      options: {
        param: string[];
        headed: boolean;
        timeout?: number;
        heal: boolean;
        write: boolean;
      },
    ) => {
      await runReplayCommand(assetPath, options);
    },
  );

program
  .command("edit")
  .description("Open a local UI to parameterize and prune a .flow.json asset")
  .argument("<asset>", "path to the .flow.json asset")
  .option("--port <port>", "port for the local editor (default: random free port)", (v) => Number(v))
  .option("--no-open", "do not auto-open the system browser")
  .action(async (assetPath: string, options: { port?: number; open: boolean }) => {
    const handle = await startEditor(assetPath, {
      port: options.port,
      open: options.open,
    });
    await handle.done;
    console.log("Editor closed.");
  });

program
  .command("validate")
  .description("Validate a .flow.json asset without launching a browser or LLM")
  .argument("<asset>", "path to the .flow.json asset")
  .action(async (assetPath: string) => {
    const ok = await validateAssetCommand(assetPath);
    if (!ok) process.exitCode = 1;
  });

/**
 * Validate a .flow.json asset on disk WITHOUT launching a browser or calling an
 * LLM — reuses the same Zod schema replay reads (parseFlowAsset via
 * readFlowAsset). Returns true (and logs a one-line summary) on a valid asset,
 * false (and prints a readable, path-tagged error to stderr) on an invalid one,
 * so it is safe to wire into CI (non-zero exit on failure).
 */
export async function validateAssetCommand(
  assetPath: string,
  log: (line: string) => void = (l) => console.log(l),
): Promise<boolean> {
  try {
    const asset = await readFlowAsset(assetPath);
    log(
      `Valid: ${assetPath} — ${asset.steps.length} step(s), ${asset.params.length} param(s).`,
    );
    return true;
  } catch (err) {
    console.error(`Invalid: ${(err as Error).message}`);
    return false;
  }
}

/**
 * Core of the `replay` action, extracted so the partial-heal writeback is
 * unit-testable without a browser. Loads the asset, snapshots each step's
 * healHistory length, runs `replayAsset`, and — on success OR on a later-step
 * failure after earlier steps healed — writes the (mutated) asset back to disk
 * when `options.write` is set, then propagates any error.
 */
export interface ReplayCommandDeps {
  read?: (path: string) => Promise<FlowAsset>;
  replay?: typeof replayAsset;
  write?: (path: string, asset: FlowAsset) => Promise<void>;
  makeHeal?: (opts: { log: (l: string) => void }) => HealHook;
}

export async function runReplayCommand(
  assetPath: string,
  options: {
    param: string[];
    headed: boolean;
    timeout?: number;
    heal: boolean;
    write: boolean;
  },
  deps: ReplayCommandDeps = {},
): Promise<void> {
  const read = deps.read ?? readFlowAsset;
  const replay = deps.replay ?? replayAsset;
  const write = deps.write ?? writeFlowAsset;
  const makeHeal = deps.makeHeal ?? createHealHook;
  const params = parseParamPairs(options.param);
  // Load once so healed selectors can be persisted back to the same file.
  const asset = await read(assetPath);
  // Snapshot each step's healHistory length BEFORE replay. replayAsset
  // re-throws any step error after closing the browser in its `finally`, so the
  // success-gated writeback below would never run when a LATER step fails —
  // silently discarding heals EARLIER steps performed during this run (and
  // re-billing the LLM on the next run). The catch persists any heals that
  // happened before the failing step, then re-throws.
  const healsBefore = asset.steps.map((s) => s.healHistory?.length ?? 0);
  try {
    const result = await replay(asset, {
      params,
      headless: !options.headed,
      timeoutMs: options.timeout,
      heal: options.heal ? makeHeal({ log: (l) => console.log(l) }) : undefined,
    });

    console.log(
      `Replay ${result.ok ? "succeeded" : "failed"}: ${result.stepsRun} step(s) run.`,
    );
    if (result.healed && options.write) {
      await write(assetPath, asset);
      console.log(`Healed selector(s) written back to ${assetPath}.`);
    } else if (result.healed) {
      console.log("Healed in memory only (--no-write); asset on disk unchanged.");
    }
    const extractedKeys = Object.keys(result.extracted);
    if (extractedKeys.length > 0) {
      console.log("Extracted:");
      for (const k of extractedKeys) {
        console.log(`  ${k} = ${JSON.stringify(result.extracted[k])}`);
      }
    }
  } catch (err) {
    const healedDuringRun = asset.steps.some(
      (s, i) => (s.healHistory?.length ?? 0) > (healsBefore[i] ?? 0),
    );
    if (healedDuringRun && options.write) {
      await write(assetPath, asset);
      console.log(
        `Healed selector(s) written back to ${assetPath} (later step failed — heals preserved).`,
      );
    }
    throw err;
  }
}

export { program };

/**
 * Detect whether this module was invoked as the process entry point
 * (i.e. `node .../cli.js <cmd>` rather than imported). Comparing the RESOLVED
 * filesystem paths (via realpathSync) — not raw URL strings — makes this
 * robust on Windows backslash paths, paths with spaces / URL-special chars
 * (import.meta.url percent-encodes those, the string concat does not), and
 * symlinked dirs (e.g. macOS /tmp → /private/tmp, where import.meta.url
 * resolves the symlink but process.argv[1] does not). With the old string
 * comparison this check silently failed in those environments and
 * program.parseAsync was never called, so `flowcast <cmd>` exited doing
 * nothing.
 */
export function isDirectRun(
  metaUrl: string,
  argv1: string | undefined,
): boolean {
  if (argv1 === undefined) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error((err as Error).message ?? err);
    process.exitCode = 1;
  });
}
