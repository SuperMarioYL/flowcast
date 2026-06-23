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
