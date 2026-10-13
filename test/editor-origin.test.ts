import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startEditor, type EditHandle } from "../src/ui/editor.js";

// --- fix-editor-localhost-csrf ------------------------------------------------
//
// The editor's localhost server accepted a cross-origin POST /api/asset whose
// content-type is text/plain (a CORS "simple request": no preflight, response
// unreadable — but the WRITE landed). Verified by probe before the fix: an
// attacker asset body sent from a foreign origin returned 200 and was persisted
// to the .flow.json on disk. A rebound DNS name pointing at 127.0.0.1 could
// additionally read the asset via GET (Host header unchecked). The server now
// requires the Host header to name the editor and rejects POSTs whose Origin
// (when present) is not the editor's own. These tests drive a REAL editor
// server — no stubs.

function freshAsset(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "flowcast-editor-origin-"));
  const path = join(dir, "asset.flow.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        version: "1",
        name: "original",
        params: [],
        steps: [{ id: "s1", action: "goto", url: "https://example.com/" }],
      },
      null,
      2,
    )}\n`,
  );
  return { dir, path };
}

/** POST JSON to the editor with explicit content-type + Origin headers. */
function post(
  url: string,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: "POST", headers: { "content-length": String(Buffer.byteLength(body)), ...headers } },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** GET the editor with a spoofed Host header (DNS-rebinding simulation). */
function getWithHost(url: string, host: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "GET", headers: { host } }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end();
  });
}

const ATTACKER_ASSET = JSON.stringify({
  version: "1",
  name: "PWNED-BY-EVIL-PAGE",
  params: [],
  steps: [{ id: "s1", action: "goto", url: "https://evil.example/" }],
});

test("editor rejects a cross-origin POST (simple request) and leaves the asset untouched", async () => {
  const { path } = freshAsset();
  const handle: EditHandle = await startEditor(path, { open: false, log: () => {} });
  try {
    const res = await post(handle.url + "api/asset", ATTACKER_ASSET, {
      "content-type": "text/plain",
      origin: "https://evil.example",
    });
    assert.equal(res.status, 403, "a foreign-Origin POST must be rejected");
    const onDisk = readFileSync(path, "utf8");
    assert.ok(
      !onDisk.includes("PWNED-BY-EVIL-PAGE"),
      "the attacker asset must NOT be persisted",
    );
    assert.ok(onDisk.includes("original"), "the original asset must be intact");
  } finally {
    handle.stop();
  }
});

test("editor accepts a same-origin POST and saves", async () => {
  const { path } = freshAsset();
  const handle: EditHandle = await startEditor(path, { open: false, log: () => {} });
  try {
    const origin = handle.url.replace(/\/$/, ""); // http://127.0.0.1:<port>
    const res = await post(handle.url + "api/asset", ATTACKER_ASSET, {
      "content-type": "application/json",
      origin,
    });
    assert.equal(res.status, 200);
    assert.ok(
      readFileSync(path, "utf8").includes("PWNED-BY-EVIL-PAGE"),
      "a same-origin save must persist",
    );
  } finally {
    handle.stop();
  }
});

test("editor accepts an Origin-less POST (curl / plain HTTP client)", async () => {
  const { path } = freshAsset();
  const handle: EditHandle = await startEditor(path, { open: false, log: () => {} });
  try {
    const res = await post(handle.url + "api/asset", ATTACKER_ASSET, {
      "content-type": "application/json",
    });
    assert.equal(res.status, 200);
  } finally {
    handle.stop();
  }
});

test("editor rejects a GET whose Host header names a rebound DNS origin", async () => {
  const { path } = freshAsset();
  const handle: EditHandle = await startEditor(path, { open: false, log: () => {} });
  try {
    const res = await getWithHost(handle.url, "evil.example");
    assert.equal(res.status, 403, "a foreign Host header must not be served");
  } finally {
    handle.stop();
  }
});

// Sanity: the guard must not break the page load itself (GET / with the real Host).
test("editor still serves the editor page to the real Host", async () => {
  const { path } = freshAsset();
  const handle: EditHandle = await startEditor(path, { open: false, log: () => {} });
  try {
    const res = await fetch(handle.url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /FlowCast/);
  } finally {
    handle.stop();
  }
});
