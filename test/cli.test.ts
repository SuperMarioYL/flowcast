import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { program, isDirectRun, runReplayCommand } from "../src/cli.js";
import { writeFlowAsset, type FlowAsset } from "../src/asset.js";

// --- fix-no-write-default-disables-heal-persistence --------------------------
//
// The replay command must persist healed selectors back to the asset BY
// DEFAULT (write=true), expose an explicit positive `--write` flag, and keep
// `--no-write` to disable. On the pre-fix code only `--no-write` was declared,
// so an explicit `--write` was an unknown option commander rejected — the
// regression discriminator below asserts `--write` is now recognized.

test("replay --write is recognized; writeback defaults on; --no-write disables", () => {
  const replay = program.commands.find((c) => c.name() === "replay")!;

  // First parse: defaults applied -> write=true, so heal writeback persists
  // unless the user opts out with --no-write.
  replay.parseOptions(["demo.flow.json"]);
  assert.equal(
    (replay.opts() as { write: boolean }).write,
    true,
    "write must default to true so healed selectors persist by default",
  );

  // Explicit `--write` is a RECOGNIZED option. On the old code `--write` was
  // unknown and landed in `unknown`; after the fix it is a positive flag.
  const withWrite = replay.parseOptions(["demo.flow.json", "--write"]);
  assert.ok(
    !withWrite.unknown.includes("--write"),
    "--write should be recognized, not treated as an unknown option",
  );
  assert.equal((replay.opts() as { write: boolean }).write, true);

  // `--no-write` disables writeback.
  replay.parseOptions(["demo.flow.json", "--no-write"]);
  assert.equal(
    (replay.opts() as { write: boolean }).write,
    false,
    "--no-write must set write=false",
  );
});

// --- fix-isdirectrun-url-string-comparison -----------------------------------
//
// The old `import.meta.url === \`file://${process.argv[1]}\`` string check
// diverges whenever the path is not already a canonical file URL: Windows
// backslash paths, paths with spaces / URL-special chars (import.meta.url
// percent-encodes them, the concat does not), and symlinked dirs (e.g. macOS
// /tmp -> /private/tmp). When it fails, program.parseAsync is never called and
// `flowcast <cmd>` exits silently doing nothing. The fix compares RESOLVED
// filesystem paths via realpathSync(fileURLToPath(...)).

test("isDirectRun resolves real paths so space/symlink paths don't silently disable the CLI", async () => {
  // A directory whose path contains a space. import.meta.url would percent-
  // encode the space (`%20`) while process.argv[1] keeps it raw, so the OLD
  // string comparison diverges. On macOS tmpdir also lives under /var (a
  // symlink to /private/var), so realpath diverges from the raw argv too —
  // faithfully reproducing the real-world failure.
  const root = await mkdtemp(join(tmpdir(), "fc-isdirect-"));
  const spaced = join(root, "with space dir");
  await mkdir(spaced, { recursive: true });
  const entry = join(spaced, "cli.js");
  await writeFile(entry, "// flowcast entry\n", "utf8");
  const other = join(spaced, "other.js");
  await writeFile(other, "// other\n", "utf8");
  try {
    const realEntry = realpathSync(entry);
    // import.meta.url form: canonical file URL, percent-encoded.
    const metaUrl = pathToFileURL(realEntry).href;
    // process.argv[1] form: raw path as invoked, space + unresolved symlink.
    const argv1 = entry;

    // OLD (buggy) string comparison — must FAIL here (this is the bug).
    const oldCheck = argv1 !== undefined && metaUrl === `file://${argv1}`;
    assert.equal(
      oldCheck,
      false,
      "string comparison must diverge on a space/symlink path (the bug)",
    );

    // NEW (fixed) realpath comparison — must SUCCEED where the string failed.
    assert.equal(
      isDirectRun(metaUrl, argv1),
      true,
      "realpath comparison must match on space/symlink paths",
    );

    // Not invoked as a script (no argv1) -> not a direct run.
    assert.equal(isDirectRun(metaUrl, undefined), false);

    // A different existing file -> not a direct run.
    assert.equal(isDirectRun(metaUrl, other), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- fix-partial-heal-lost-on-later-step-failure ----------------------------
//
// replayAsset re-throws any step error after its `finally` closes the browser,
// so the success-gated writeback would never run when a LATER step fails —
// silently discarding heals EARLIER steps performed during this run (and
// re-billing the LLM on the next run). The fix (in runReplayCommand, which the
// `replay` action delegates to) snapshots healHistory lengths before replay
// and, on a thrown error, persists any heal that happened during this run
// (when --write) before re-throwing. Injected deps let us drive this without a
// browser: a stub `replay` that mutates the asset then throws.

test("runReplayCommand persists earlier-step heals when a later step fails (--write)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fc-partial-"));
  const path = join(dir, "a.flow.json");
  const asset: FlowAsset = {
    version: "1",
    name: "t",
    params: [],
    steps: [{ id: "s1", action: "click", target: { css: "#old" } }],
  };
  await writeFlowAsset(path, asset);

  let writes = 0;
  let written: FlowAsset | undefined;
  await assert.rejects(
    () =>
      runReplayCommand(
        path,
        { param: [], headed: false, heal: true, write: true },
        {
          // Step 0 heals (mutates healHistory), then a LATER step fails.
          replay: async (a) => {
            a.steps[0]!.healHistory = [
              {
                at: "2026-08-11T00:00:00Z",
                from: { css: "#old" },
                to: { css: "#new" },
              },
            ];
            throw new Error("later step failed");
          },
          write: async (_p, a) => {
            writes++;
            written = a;
          },
          makeHeal: () => ({ heal: async () => null }),
        },
      ),
    /later step failed/,
  );
  assert.equal(writes, 1, "partial heal must be written back before re-throwing");
  assert.equal(
    written?.steps[0]?.healHistory?.length,
    1,
    "written asset carries the healed step",
  );

  // --no-write: even though a heal happened and a later step failed, do NOT
  // write back (the user opted out of persistence).
  let writesNoWrite = 0;
  await assert.rejects(
    () =>
      runReplayCommand(
        path,
        { param: [], headed: false, heal: true, write: false },
        {
          replay: async (a) => {
            a.steps[0]!.healHistory = [
              {
                at: "2026-08-11T00:00:00Z",
                from: { css: "#old" },
                to: { css: "#new" },
              },
            ];
            throw new Error("later step failed again");
          },
          write: async () => {
            writesNoWrite++;
          },
          makeHeal: () => ({ heal: async () => null }),
        },
      ),
    /later step failed again/,
  );
  assert.equal(writesNoWrite, 0, "--no-write must suppress the partial-heal writeback");

  // No heal this run → no writeback even on failure with --write.
  let writesNoHeal = 0;
  await assert.rejects(
    () =>
      runReplayCommand(
        path,
        { param: [], headed: false, heal: true, write: true },
        {
          replay: async () => {
            throw new Error("step failed before any heal");
          },
          write: async () => {
            writesNoHeal++;
          },
          makeHeal: () => ({ heal: async () => null }),
        },
      ),
    /step failed before any heal/,
  );
  assert.equal(writesNoHeal, 0, "no writeback when no step healed during this run");

  await rm(dir, { recursive: true, force: true });
});
