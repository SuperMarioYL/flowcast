import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  buildHealPrompt,
  createHealHook,
  defaultChat,
  parseHealChoice,
  snapshotCandidates,
} from "../src/heal.js";
import { replayAsset } from "../src/replay.js";
import type { FlowAsset, SelectorBundle, Step } from "../src/asset.js";

// --- Pure-logic tests (no browser, no network) -------------------------------

test("parseHealChoice reads a bare JSON object", () => {
  const c = parseHealChoice('{"index": 2, "reason": "same button"}', 5);
  assert.deepEqual(c, { index: 2, reason: "same button" });
});

test("parseHealChoice tolerates ```json fences and surrounding prose", () => {
  const reply = 'Sure!\n```json\n{"index": 0}\n```\nDone.';
  assert.deepEqual(parseHealChoice(reply, 3), { index: 0, reason: undefined });
});

test("parseHealChoice rejects out-of-range / non-integer indices", () => {
  assert.equal(parseHealChoice('{"index": 9}', 3), null);
  assert.equal(parseHealChoice('{"index": "x"}', 3), null);
  assert.equal(parseHealChoice("no json here", 3), null);
});

test("buildHealPrompt embeds the failed selector and candidate list", () => {
  const step: Step = { id: "s1", action: "click", target: { css: "#old" }, label: "click Login" };
  const prompt = buildHealPrompt(step, { css: "#old" }, [
    { index: 0, bundle: { css: "#new", role: "button", name: "Login" }, text: "Login" },
  ]);
  assert.match(prompt, /click Login/);
  assert.match(prompt, /#old/);
  assert.match(prompt, /"index": 0/);
});

// --- Browser-backed heal against a local fixture -----------------------------

const FIXTURE_HTML = `<!doctype html><html><body>
  <h1 id="title">Login</h1>
  <form id="f" onsubmit="event.preventDefault();document.getElementById('panel').style.display='block';">
    <input id="u" type="text" aria-label="Username" />
    <input id="p" type="password" aria-label="Password" />
    <!-- the "Sign in" button moved + got a new id, simulating a redesign -->
    <button id="submit-v2" type="submit">Sign in</button>
  </form>
  <div id="panel" style="display:none"><h2 class="heading">Secure Area</h2></div>
</body></html>`;

async function startFixture(): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(FIXTURE_HTML);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function chromiumAvailable(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    const b = await chromium.launch({ headless: true });
    await b.close();
    return true;
  } catch {
    return false;
  }
}

test("snapshotCandidates collects redundant bundles for the live DOM", async (t) => {
  if (!(await chromiumAvailable())) {
    t.skip("Chromium not installed (run: npx playwright install chromium)");
    return;
  }
  const { chromium } = await import("playwright");
  const { server, url } = await startFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    const cands = await snapshotCandidates(page, "click");
    assert.ok(cands.length >= 1);
    const btn = cands.find((c) => c.bundle.text === "Sign in");
    assert.ok(btn, "expected the Sign in button among candidates");
    assert.equal(btn?.bundle.role, "button");
  } finally {
    await browser.close();
    server.close();
  }
});

test("replay --heal self-repairs a drifted selector and records healHistory", async (t) => {
  if (!(await chromiumAvailable())) {
    t.skip("Chromium not installed");
    return;
  }
  const { server, url } = await startFixture();
  try {
    // The click step points at the OLD id (#login-btn) which no longer exists;
    // the live button is now #submit-v2. A stubbed LLM picks it by text match.
    const asset: FlowAsset = {
      version: "1",
      name: "heal-fixture",
      params: [],
      steps: [
        { id: "s1", action: "goto", url },
        { id: "s2", action: "fill", target: { css: "#u" }, value: "alice" },
        {
          id: "s3",
          action: "click",
          // All clues are stale (old id + old label "Log In") so every clue
          // misses against the redesigned DOM, forcing the heal path.
          target: { css: "#login-btn", role: "button", name: "Log In", text: "Log In" },
          label: "click the login button",
        },
        { id: "s4", action: "waitFor", target: { css: ".heading", text: "Secure Area" } },
      ],
    };

    // Stub chat: parse the candidate list out of the prompt and choose the
    // entry whose text is "Sign in" (what a real LLM would do here).
    const heal = createHealHook({
      log: () => {},
      chat: async (prompt: string) => {
        const start = prompt.indexOf("LIVE DOM CANDIDATES:");
        const jsonStart = prompt.indexOf("[", start);
        const jsonEnd = prompt.indexOf("]", jsonStart);
        const list = JSON.parse(prompt.slice(jsonStart, jsonEnd + 1)) as Array<{
          index: number;
          text?: string;
          name?: string;
        }>;
        const pick = list.find((c) => c.text === "Sign in" || c.name === "Sign in") ?? list[0];
        return JSON.stringify({ index: pick.index, reason: "text match" });
      },
    });

    const result = await replayAsset(asset, { headless: true, heal, log: () => {} });
    assert.equal(result.ok, true);
    assert.equal(result.healed, true);
    const clickStep = asset.steps.find((s) => s.id === "s3")!;
    assert.ok(clickStep.healHistory && clickStep.healHistory.length === 1);
    assert.equal(clickStep.healHistory[0].from.css, "#login-btn");
    // The healed bundle should now resolve to the real button.
    const healedBundle: SelectorBundle = clickStep.target!;
    assert.ok(healedBundle.css || healedBundle.role);
  } finally {
    server.close();
  }
});

// --- fix-heal-chat-fetch-has-no-timeout --------------------------------------
//
// defaultChat's fetch to the LLM endpoint had no AbortController / timeout.
// Node's global fetch has no default timeout, so a stalled FLOWCAST_LLM_BASE_URL
// or provider outage would hang the entire --heal replay forever with no error.
// The fix wraps the fetch in an AbortController and throws a readable timeout
// error so the heal hook fails loudly instead of freezing.

test("defaultChat aborts and throws a readable timeout error when the endpoint stalls", { timeout: 5000 }, async () => {
  // Local server that accepts the connection but NEVER responds — simulates a
  // stalled endpoint. Loopback-only, no real network.
  const server = createServer((_req, _res) => {
    // intentionally never call res.end()
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  const savedBase = process.env.FLOWCAST_LLM_BASE_URL;
  const savedKey = process.env.FLOWCAST_LLM_API_KEY;
  process.env.FLOWCAST_LLM_BASE_URL = baseUrl;
  process.env.FLOWCAST_LLM_API_KEY = "test-key";
  try {
    const chat = defaultChat(150); // 150ms timeout — hermetic, fast
    const start = Date.now();
    await assert.rejects(() => chat("heal prompt"), /timed out/i);
    const elapsed = Date.now() - start;
    // Must fail fast (the AbortController fired), NOT hang for 120s.
    assert.ok(elapsed < 5000, `expected a fast timeout, got ${elapsed}ms`);
  } finally {
    if (savedBase === undefined) delete process.env.FLOWCAST_LLM_BASE_URL;
    else process.env.FLOWCAST_LLM_BASE_URL = savedBase;
    if (savedKey === undefined) delete process.env.FLOWCAST_LLM_API_KEY;
    else process.env.FLOWCAST_LLM_API_KEY = savedKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// --- fix-heal-parse-greedy-regex ---------------------------------------------
//
// parseHealChoice extracted the model's answer with a GREEDY /\{[\s\S]*\}/,
// which spans from the first `{` to the LAST `}`. When a chatty model (the
// default backend is gpt-4o-mini) wraps the JSON in prose that itself contains
// braces — e.g. `(confidence {high})` — the match captured prose + the real
// object and JSON.parse threw, so parseHealChoice returned null and heal gave
// up even though the reply contained a valid choice. The fix scans for
// balanced `{...}` objects (string-aware) and returns the first that parses to
// a valid HealChoice.

test("parseHealChoice survives braces in surrounding prose (balanced scan)", () => {
  // Braces AFTER the object (the greedy regex's headline failure).
  assert.deepEqual(
    parseHealChoice('{"index": 1, "reason": "ok"} (note: confidence {high})', 5),
    { index: 1, reason: "ok" },
  );
  // Braces BEFORE the object, as invalid prose (`{x}` is not valid JSON).
  assert.deepEqual(
    parseHealChoice(
      'Thinking... the old {x} was wrong. Final: {"index": 3, "reason": "new button"}',
      5,
    ),
    { index: 3, reason: "new button" },
  );
  // A brace INSIDE a string value must not unbalance the scan.
  assert.deepEqual(
    parseHealChoice('{"index": 0, "reason": "matched {button}"}', 2),
    { index: 0, reason: "matched {button}" },
  );
  // The existing ```json-fence fast path still works.
  assert.deepEqual(
    parseHealChoice('Sure!\n```json\n{"index": 0}\n```\nDone.', 3),
    { index: 0, reason: undefined },
  );
});
