import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";

import {
  candidateLocators,
  replayAsset,
  resolveLocator,
  SelectorMissError,
} from "../src/replay.js";
import { overlayScript } from "../src/recorder-overlay.js";
import type { Page } from "playwright";
import type { FlowAsset, SelectorBundle, Step } from "../src/asset.js";

/**
 * A minimal Page stub that records which locator factories were called and in
 * what order. We only need to verify priority ordering of clue resolution —
 * not real DOM behavior — so the returned locators are opaque tags.
 */
function fakePage(calls: string[]): Page {
  return {
    locator(sel: string) {
      calls.push(`locator:${sel}`);
      return {
        __sel: sel,
        nth(i: number) {
          calls.push(`nth:${sel}:${i}`);
          return { __sel: `${sel}>>nth=${i}` };
        },
      } as unknown;
    },
    getByRole(role: string, opts: { name?: string }) {
      calls.push(`role:${role}:${opts.name}`);
      return { __role: role } as unknown;
    },
    getByText(text: string) {
      calls.push(`text:${text}`);
      return { __text: text } as unknown;
    },
  } as unknown as Page;
}

test("candidateLocators orders clues css → xpath → role+name → text", () => {
  const calls: string[] = [];
  const page = fakePage(calls);
  const bundle: SelectorBundle = {
    css: "#u",
    xpath: "//x",
    role: "button",
    name: "Login",
    text: "Login",
  };
  const cands = candidateLocators(page, bundle);
  assert.equal(cands.length, 4);
  assert.deepEqual(calls, [
    "locator:#u",
    "locator:xpath=//x",
    "role:button:Login",
    "text:Login",
  ]);
});

test("candidateLocators uses structural fallback only when no css", () => {
  const calls: string[] = [];
  const page = fakePage(calls);
  const bundle: SelectorBundle = { tagName: "input", nthOfType: 2 };
  const cands = candidateLocators(page, bundle);
  assert.equal(cands.length, 1);
  assert.equal(calls[0], "locator:input");
});

test("SelectorMissError carries the step + bundle and mentions --heal", () => {
  const step: Step = { id: "s9", action: "click", target: { css: "#x" }, label: "the button" };
  const err = new SelectorMissError(step, { css: "#x" });
  assert.equal(err.step.id, "s9");
  assert.match(err.message, /--heal/);
  assert.match(err.message, /the button/);
});

// --- Browser-backed end-to-end replay against a local fixture ----------------

const FIXTURE_HTML = `<!doctype html><html><body>
  <h1 id="title">Login</h1>
  <form id="f" onsubmit="event.preventDefault();document.getElementById('out').textContent='welcome '+document.getElementById('u').value;document.getElementById('panel').style.display='block';">
    <input id="u" type="text" aria-label="Username" />
    <input id="p" type="password" aria-label="Password" />
    <button type="submit">Sign in</button>
  </form>
  <div id="panel" style="display:none">
    <h2 class="heading">Secure Area</h2>
    <span id="out"></span>
  </div>
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

test("replayAsset runs a full flow against a live page (zero heal)", async (t) => {
  if (!(await chromiumAvailable())) {
    t.skip("Chromium not installed (run: npx playwright install chromium)");
    return;
  }
  const { server, url } = await startFixture();
  try {
    const asset: FlowAsset = {
      version: "1",
      name: "fixture-login",
      params: [{ key: "account", required: true, default: "alice" }],
      steps: [
        { id: "s1", action: "goto", url },
        { id: "s2", action: "fill", target: { css: "#u", role: "textbox", name: "Username" }, value: "{{account}}" },
        { id: "s3", action: "fill", target: { css: "#p" }, value: "secret" },
        { id: "s4", action: "click", target: { role: "button", name: "Sign in", text: "Sign in" } },
        { id: "s5", action: "waitFor", target: { css: ".heading", text: "Secure Area" } },
        { id: "s6", action: "extract", target: { css: "#out" } },
      ],
    };
    const result = await replayAsset(asset, {
      params: { account: "alice" },
      headless: true,
      log: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.stepsRun, 6);
    assert.equal(result.healed, false);
    assert.equal(result.extracted.s6, "welcome alice");
  } finally {
    server.close();
  }
});

test("resolveLocator throws SelectorMissError when every clue misses", async (t) => {
  if (!(await chromiumAvailable())) {
    t.skip("Chromium not installed");
    return;
  }
  const { chromium } = await import("playwright");
  const { server, url } = await startFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    const step: Step = { id: "s1", action: "click", target: { css: "#does-not-exist" } };
    await assert.rejects(
      () => resolveLocator(page, step, { css: "#does-not-exist" }, 1500),
      SelectorMissError,
    );
  } finally {
    await browser.close();
    server.close();
  }
});

test("resolveLocator honors the per-step timeout across multiple clues (no N*500 overrun)", async (t) => {
  if (!(await chromiumAvailable())) {
    t.skip("Chromium not installed");
    return;
  }
  const { chromium } = await import("playwright");
  const { server, url } = await startFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url);
    // A 4-clue bundle that all miss. Old code budgeted each clue
    // Math.max(500, floor(timeout/4)) = 500ms -> ~2000ms total. The fix shares
    // a single deadline so the step must fail within roughly the configured
    // timeout, never N*500.
    const bundle: SelectorBundle = {
      css: "#nope-a",
      xpath: "//nopeB",
      role: "button",
      name: "Nope",
      text: "definitely-absent",
    };
    const step: Step = { id: "s1", action: "click", target: bundle };
    const timeoutMs = 1000;
    const start = Date.now();
    await assert.rejects(
      () => resolveLocator(page, step, bundle, timeoutMs),
      SelectorMissError,
    );
    const elapsed = Date.now() - start;
    // Old behaviour ~4*500 = 2000ms; fixed must stay well under that.
    assert.ok(
      elapsed < timeoutMs * 1.7,
      `elapsed ${elapsed}ms exceeded the ${timeoutMs * 1.7}ms budget — deadline not shared`,
    );
  } finally {
    await browser.close();
    server.close();
  }
});

// --- fix-resolvelocator-returns-first-on-ambiguous-match ---------------------
//
// resolveLocator returned the first DOM element as soon as `count >= 1` for a
// candidate clue, but the documented invariant is "exactly one element wins".
// With an ambiguous clue (a getByRole/getByText match hitting several
// elements), `count > 1` silently picked the first element — possibly the
// wrong one. The fix returns ONLY on `count === 1`, falls through to the next
// clue on ambiguity, and throws SelectorMissError (→ --heal) if no clue is
// unique. A Page stub drives the count() of each clue directly (no browser).

/**
 * A Page stub whose locator/getByRole/getByText produce locators with a
 * configurable `count()` (and a `first()` whose `waitFor` throws when count is
 * 0). Each locator + its first() carries a `__tag` so the test can assert
 * WHICH clue won.
 */
function stubResolvePage(
  counts: { css?: number; text?: number; role?: number },
): Page {
  const mk = (count: number, tag: string) => ({
    __tag: tag,
    first: () => ({
      __tag: tag,
      waitFor: async (_opts?: { state?: string; timeout?: number }) => {
        if (count === 0) throw new Error("timeout"); // not attached → next clue
      },
    }),
    count: async () => count,
  });
  return {
    locator: (sel: string) => mk(counts.css ?? 0, `css:${sel}`),
    getByRole: (role: string, opts: { name?: string }) =>
      mk(counts.role ?? 0, `role:${role}:${opts.name}`),
    getByText: (text: string) => mk(counts.text ?? 0, `text:${text}`),
  } as unknown as Page;
}

test("resolveLocator skips an ambiguous clue and returns the uniquely-resolving one", async () => {
  // css matches TWO elements (ambiguous); text matches exactly one.
  const page = stubResolvePage({ css: 2, text: 1 });
  const bundle: SelectorBundle = { css: "#x", text: "Login" };
  const step: Step = { id: "s1", action: "click", target: bundle };
  const loc = await resolveLocator(page, step, bundle, 2000);
  assert.equal(
    (loc as unknown as { __tag: string }).__tag,
    "text:Login",
    "must NOT return the ambiguous css clue's first element",
  );
});

test("resolveLocator throws SelectorMissError when every clue is ambiguous (count>1)", async () => {
  // role+name matches TWO elements — no other clue to fall back to.
  const page = stubResolvePage({ role: 2 });
  const bundle: SelectorBundle = { role: "button", name: "Sign in" };
  const step: Step = { id: "s1", action: "click", target: bundle };
  await assert.rejects(
    () => resolveLocator(page, step, bundle, 2000),
    SelectorMissError,
  );
});

// --- fix-record-drops-submit-input-clicks -----------------------------------
//
// The recorder-overlay click handler used to blanket-return for ALL
// input/textarea/select tags (`if (/^(input|textarea|select)$/i.test(...))
// return; // handled by change`), but the change handler only covers text-like
// inputs (fill) + checkbox/radio (click). <input type="submit"> clicks were
// silently dropped. The fix is type-aware: only skip inputs the change handler
// covers; let submit/button/image/reset fall through to emit a click.

test("overlay click handler no longer blanket-drops submit/button input clicks", () => {
  const src = overlayScript("__flowcastEmit");
  // The old blanket guard with its "handled by change" comment must be gone.
  assert.ok(
    !src.includes("handled by change"),
    "blanket input/textarea/select return ('handled by change') must be removed",
  );
  // The type-aware guard must type-check INPUT elements instead of
  // blanket-dropping them.
  assert.ok(
    src.includes('node.tagName === "INPUT"'),
    "click handler must type-check INPUT elements instead of blanket-dropping them",
  );
});

// --- fix-extract-value-not-param-injected -----------------------------------
//
// The extract action used `step.value` directly as the attribute name without
// calling `injectValue`, unlike fill/select. A parameterized extract value
// (`{{attr}}`) was required by resolveParams but never substituted, silently
// extracting from a literal `{{attr}}` attribute → empty string. The fix calls
// `injectValue(step.value ?? "", values)` in the extract case.

test("replayAsset injects params into extract step value (attribute name)", async (t) => {
  if (!(await chromiumAvailable())) {
    t.skip("Chromium not installed (run: npx playwright install chromium)");
    return;
  }
  const { server, url } = await startFixture();
  try {
    const asset: FlowAsset = {
      version: "1",
      name: "fixture-extract-param",
      params: [{ key: "attr", required: true, default: "id" }],
      steps: [
        { id: "s1", action: "goto", url },
        { id: "s2", action: "extract", target: { css: "#out" }, value: "{{attr}}" },
      ],
    };
    const result = await replayAsset(asset, {
      params: { attr: "id" },
      headless: true,
      log: () => {},
    });
    assert.equal(result.ok, true);
    // Without the fix: getAttribute("{{attr}}") → null → "".
    // With the fix: getAttribute("id") → "out".
    assert.equal(result.extracted.s2, "out");
  } finally {
    server.close();
  }
});
