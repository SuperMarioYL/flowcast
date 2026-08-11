import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { editorHtml, startEditor } from "../src/ui/editor.js";
import { writeFlowAsset, readFlowAsset, type FlowAsset } from "../src/asset.js";

const SAMPLE: FlowAsset = {
  version: "1",
  name: "sample",
  params: [],
  steps: [
    { id: "s1", action: "goto", url: "https://example.com/login" },
    { id: "s2", action: "fill", target: { css: "#u" }, value: "alice" },
  ],
};

test("editorHtml is a self-contained page with the editor endpoints", () => {
  const html = editorHtml();
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /\/api\/asset/);
  assert.match(html, /parameterize/);
});

async function tmpAsset(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flowcast-edit-"));
  const path = join(dir, "sample.flow.json");
  await writeFlowAsset(path, SAMPLE);
  return path;
}

test("editor serves GET /api/asset with the on-disk asset", async () => {
  const path = await tmpAsset();
  const handle = await startEditor(path, { open: false, log: () => {} });
  try {
    const res = await fetch(handle.url + "api/asset");
    const data = (await res.json()) as { path: string; asset: FlowAsset };
    assert.equal(data.path, path);
    assert.equal(data.asset.name, "sample");
    assert.equal(data.asset.steps.length, 2);
  } finally {
    handle.stop();
  }
});

test("POST /api/asset validates and writes a parameterized asset back to disk", async () => {
  const path = await tmpAsset();
  const handle = await startEditor(path, { open: false, log: () => {} });
  try {
    const edited: FlowAsset = {
      version: "1",
      name: "sample-edited",
      params: [{ key: "account", required: true, default: "alice" }],
      steps: [
        { id: "s1", action: "goto", url: "https://example.com/login" },
        { id: "s2", action: "fill", target: { css: "#u" }, value: "{{account}}" },
      ],
    };
    const res = await fetch(handle.url + "api/asset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(edited),
    });
    const data = (await res.json()) as { ok: boolean };
    assert.equal(data.ok, true);

    // Disk round-trips through the schema.
    const onDisk = await readFlowAsset(path);
    assert.equal(onDisk.name, "sample-edited");
    assert.equal(onDisk.params[0]?.key, "account");
    assert.equal(onDisk.steps[1]?.value, "{{account}}");

    const raw = await readFile(path, "utf8");
    assert.match(raw, /\{\{account\}\}/);
  } finally {
    handle.stop();
  }
});

test("POST /api/asset rejects a malformed asset with 400", async () => {
  const path = await tmpAsset();
  const handle = await startEditor(path, { open: false, log: () => {} });
  try {
    const res = await fetch(handle.url + "api/asset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: "1", name: "", steps: [] }),
    });
    assert.equal(res.status, 400);
    const data = (await res.json()) as { ok: boolean; error: string };
    assert.equal(data.ok, false);
    assert.ok(data.error.length > 0);
  } finally {
    handle.stop();
  }
});

// --- fix-edit-command-hangs-when-tab-closed-without-save-close ---------------
//
// `done` was resolved ONLY by `stop()`, reachable solely via `POST /api/close`
// (or an external handle.stop()). Closing the browser tab without clicking
// "Save & close" fires no server-observable event, so `flowcast edit` hung on a
// leaked port forever with no SIGINT handler. The fix registers SIGINT/SIGTERM
// handlers in startEditor that call stop() (and remove themselves on stop), so
// Ctrl-C frees the port and resolves done. We exercise it by invoking the
// registered handler directly (no real signal needed).

test("editor SIGINT handler resolves done and removes itself on stop", async () => {
  const path = await tmpAsset();
  const before = new Set(process.listeners("SIGINT"));
  const handle = await startEditor(path, { open: false, log: () => {} });
  try {
    const added = process.listeners("SIGINT").filter((h) => !before.has(h));
    assert.ok(added.length >= 1, "startEditor must register a SIGINT handler");

    // Invoke the handler the way a real Ctrl-C would.
    const handler = added[0] as (() => void) | undefined;
    assert.ok(handler, "SIGINT handler present");
    await handler!();

    // done must resolve promptly (stop() ran).
    await Promise.race([
      handle.done,
      new Promise<void>((_, rej) =>
        setTimeout(
          () => rej(new Error("done did not resolve after SIGINT")),
          1000,
        ),
      ),
    ]);

    // The handler must be removed after stop() so it doesn't leak across
    // repeated editor sessions (and so the process can exit normally).
    const after = process.listeners("SIGINT").filter((h) => !before.has(h));
    assert.equal(after.length, 0, "SIGINT handler removed after stop");
  } finally {
    handle.stop();
  }
});
