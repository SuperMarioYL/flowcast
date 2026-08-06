import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { program, isDirectRun } from "../src/cli.js";

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
