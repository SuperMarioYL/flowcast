import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FLOW_ASSET_VERSION,
  parseFlowAsset,
  serializeFlowAsset,
  readFlowAsset,
  writeFlowAsset,
  emptyAsset,
  type FlowAsset,
} from "../src/asset.js";

const validAsset: FlowAsset = {
  version: "1",
  name: "demo",
  params: [{ key: "account", required: true, default: "alice" }],
  steps: [
    { id: "s1", action: "goto", url: "https://example.com/login" },
    {
      id: "s2",
      action: "fill",
      target: { css: "#user" },
      value: "{{account}}",
    },
    { id: "s3", action: "click", target: { role: "button", name: "Login" } },
  ],
};

test("version constant is 1", () => {
  assert.equal(FLOW_ASSET_VERSION, "1");
});

test("parseFlowAsset accepts a valid asset", () => {
  const parsed = parseFlowAsset(validAsset);
  assert.equal(parsed.name, "demo");
  assert.equal(parsed.steps.length, 3);
});

test("parseFlowAsset rejects an empty steps array", () => {
  assert.throws(
    () => parseFlowAsset({ version: "1", name: "x", steps: [] }),
    /at least one step/,
  );
});

test("parseFlowAsset rejects a goto without url", () => {
  assert.throws(
    () =>
      parseFlowAsset({
        version: "1",
        name: "x",
        steps: [{ id: "s1", action: "goto" }],
      }),
    /goto step requires a `url`/,
  );
});

test("parseFlowAsset rejects an element action without target", () => {
  assert.throws(
    () =>
      parseFlowAsset({
        version: "1",
        name: "x",
        steps: [{ id: "s1", action: "click" }],
      }),
    /requires a `target`/,
  );
});

test("parseFlowAsset rejects a SelectorBundle with no usable clue", () => {
  assert.throws(
    () =>
      parseFlowAsset({
        version: "1",
        name: "x",
        steps: [{ id: "s1", action: "click", target: { tagName: "div" } }],
      }),
    /at least one usable clue/,
  );
});

test("parseFlowAsset rejects a bad param key", () => {
  assert.throws(
    () =>
      parseFlowAsset({
        version: "1",
        name: "x",
        params: [{ key: "1bad" }],
        steps: [{ id: "s1", action: "goto", url: "https://x.io" }],
      }),
    /valid identifier/,
  );
});

test("serializeFlowAsset round-trips through parse", () => {
  const json = serializeFlowAsset(validAsset);
  assert.ok(json.endsWith("\n"));
  const back = parseFlowAsset(JSON.parse(json));
  assert.deepEqual(back, parseFlowAsset(validAsset));
});

test("read/write asset round-trips on disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowcast-"));
  const path = join(dir, "x.flow.json");
  try {
    await writeFlowAsset(path, validAsset);
    const back = await readFlowAsset(path);
    assert.equal(back.name, "demo");
    assert.equal(back.steps[2]?.target?.role, "button");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readFlowAsset gives a readable error on bad JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "flowcast-"));
  const path = join(dir, "bad.flow.json");
  try {
    await writeFlowAsset(path, validAsset);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{ not json", "utf8");
    await assert.rejects(() => readFlowAsset(path), /not valid JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("emptyAsset produces a fillable shell", () => {
  const shell = emptyAsset("fresh");
  assert.equal(shell.version, "1");
  assert.equal(shell.name, "fresh");
  assert.deepEqual(shell.steps, []);
  assert.ok(shell.recordedAt);
});

// --- m3_goto_url_param_injection ---------------------------------------------
//
// The goto branch in replay now substitutes {{param}} refs before navigating
// (src/replay.ts goto branch calls injectValue), and params.ts
// referencedParamKeys scans step.url so a url ref is declared/required like a
// fill/select ref. zod's `.url()` already accepts brace templates
// (`https://{{host}}/login` parses true), so the schema now ALLOWS {{param}}
// in goto urls (the v0.4.0 superRefine that rejected them is gone). An
// unresolved url param errors loudly at replay via resolveParams/injectValue.

test("parseFlowAsset accepts a {{param}} ref in a goto url (and a plain url)", () => {
  // A param-injected url is now valid (previously rejected by superRefine).
  assert.doesNotThrow(() =>
    parseFlowAsset({
      version: "1",
      name: "x",
      steps: [{ id: "s1", action: "goto", url: "https://{{host}}/login" }],
    }),
  );
  // A plain url (no {{) is still accepted.
  assert.doesNotThrow(() =>
    parseFlowAsset({
      version: "1",
      name: "x",
      steps: [{ id: "s1", action: "goto", url: "https://example.com/login" }],
    }),
  );
});
