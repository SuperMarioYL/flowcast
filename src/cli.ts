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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { record } from "./record.js";
import { replayAsset } from "./replay.js";
import { parseParamPairs } from "./params.js";
import { createHealHook } from "./heal.js";
import { startEditor } from "./ui/editor.js";
import { readFlowAsset, writeFlowAsset } from "./asset.js";

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
      const params = parseParamPairs(options.param);
      // Load once so healed selectors can be persisted back to the same file.
      const asset = await readFlowAsset(assetPath);
      const result = await replayAsset(asset, {
        params,
        headless: !options.headed,
        timeoutMs: options.timeout,
        heal: options.heal ? createHealHook({ log: (l) => console.log(l) }) : undefined,
      });

      console.log(
        `Replay ${result.ok ? "succeeded" : "failed"}: ${result.stepsRun} step(s) run.`,
      );
      if (result.healed && options.write) {
        await writeFlowAsset(assetPath, asset);
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

export { program };

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error((err as Error).message ?? err);
    process.exitCode = 1;
  });
}
