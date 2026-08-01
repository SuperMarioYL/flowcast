import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateAssetCommand } from "../src/cli.js";

const validAsset = {
  version: "1",
  name: "demo",
  params: [{ key: "account", required: true, default: "alice" }],
  steps: [
    { id: "s1", action: "goto", url: "https://example.com/login" },
    { id: "s2", action: "fill", target: { css: "#user" }, value: "{{account}}" },
    { id: "s3", action: "click", target: { role: "button", name: "Login" } },
  ],
};

test("validateAssetCommand returns true and reports a valid asset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowcast-validate-"));
  const path = join(dir, "ok.flow.json");
  try {
    await writeFile(path, JSON.stringify(validAsset, null, 2), "utf8");
    const lines: string[] = [];
    const ok = await validateAssetCommand(path, (s) => lines.push(s));
    assert.equal(ok, true);
    assert.match(lines.join("\n"), /Valid/);
    assert.match(lines.join("\n"), /3 step/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateAssetCommand returns false for an invalid asset (goto without url)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowcast-validate-"));
  const path = join(dir, "bad.flow.json");
  try {
    await writeFile(
      path,
      JSON.stringify(
        { version: "1", name: "x", steps: [{ id: "s1", action: "goto" }] },
        null,
        2,
      ),
      "utf8",
    );
    const ok = await validateAssetCommand(path, () => {});
    assert.equal(ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateAssetCommand returns false for a missing file", async () => {
  const ok = await validateAssetCommand(
    join(tmpdir(), "flowcast-does-not-exist.flow.json"),
    () => {},
  );
  assert.equal(ok, false);
});
