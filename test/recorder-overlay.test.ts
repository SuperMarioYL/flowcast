import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  overlayScript,
  EMIT_BINDING,
  type CapturedEvent,
} from "../src/recorder-overlay.js";

// These tests drive the in-page recorder overlay against a live fixture and
// assert WHICH interactions it captures. They mirror the record-time wiring
// (context-level exposeBinding + addInitScript) so the overlay runs exactly as
// it does in `record`.

async function serve(html: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
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

/** Drive the overlay against `html`, performing `act`, returning captured events. */
async function capture(
  html: string,
  act: (page: import("playwright").Page) => Promise<void>,
): Promise<CapturedEvent[]> {
  const { server, url } = await serve(html);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const events: CapturedEvent[] = [];
    await context.exposeBinding(EMIT_BINDING, (_s, payload: string) => {
      try {
        events.push(JSON.parse(payload) as CapturedEvent);
      } catch {
        /* ignore malformed payloads */
      }
    });
    await context.addInitScript({ content: overlayScript(EMIT_BINDING) });
    await page.goto(url);
    await act(page);
    // let capture-phase listeners flush
    await page.waitForTimeout(80);
    return events;
  } finally {
    await browser.close();
    server.close();
  }
}

// --- m1_label_forwarded_click_double_capture --------------------------------
//
// Clicking a <label for="checkbox"> used to emit a click for the LABEL (the
// click handler climbed to / resolved the label) AND a click for the CHECKBOX
// (the change handler, since the forwarded toggle fires change). Replay then
// toggled the box twice, leaving it unchecked — a recorded "check the box"
// reproduced as UNCHECKED. The fix skips <label> in the click handler; the
// forwarded control's own change is captured, so exactly ONE click (on the
// checkbox) is recorded.

test("clicking a <label for=checkbox> captures one click on the checkbox, not the label", async (t) => {
  if (!(await chromiumAvailable())) {
    t.skip("Chromium not installed (run: npx playwright install chromium)");
    return;
  }
  const events = await capture(
    `<form><label id="lab" for="chk" style="display:block;padding:40px">Remember me</label><input id="chk" type="checkbox" /></form>`,
    // Click the label's top-left padding corner so the click lands on the
    // label itself (not the checkbox), forcing the label-forwarded toggle.
    async (page) => {
      await page.click("#lab", { position: { x: 5, y: 5 } });
    },
  );
  assert.equal(
    events.length,
    1,
    "a label-forwarded toggle must capture exactly ONE click (on the control)",
  );
  assert.equal(events[0]?.action, "click");
  assert.equal(
    events[0]?.target.css,
    "#chk",
    "the captured click must target the checkbox, not the label",
  );
});

// --- m2_value_bearing_input_changes_dropped ---------------------------------
//
// date/time/datetime-local/month/week/color/range inputs fire `change` with a
// value, but the change handler used to drop them (they were in neither the
// text-like fill list nor the checkbox/radio click list) — and the click
// handler emitted a value-less click for them. So a recorded date/color value
// was lost and replay could not reproduce it. The fix captures these as `fill`
// steps carrying `el.value` (and skips them in the click handler).

test("a date input change is captured as a fill carrying the value", async (t) => {
  if (!(await chromiumAvailable())) {
    t.skip("Chromium not installed (run: npx playwright install chromium)");
    return;
  }
  const events = await capture(
    `<input id="d" type="date" />`,
    async (page) => {
      await page.fill("#d", "2026-08-29");
    },
  );
  // Before the fix: zero events (the change was dropped).
  assert.equal(events.length, 1, "the date change must be captured as one fill");
  assert.equal(events[0]?.action, "fill");
  assert.equal(events[0]?.target.css, "#d");
  assert.equal(events[0]?.value, "2026-08-29");
});

test("a color input change is captured as a fill carrying the value", async (t) => {
  if (!(await chromiumAvailable())) {
    t.skip("Chromium not installed (run: npx playwright install chromium)");
    return;
  }
  const events = await capture(
    `<input id="c" type="color" />`,
    async (page) => {
      await page.fill("#c", "#112233");
    },
  );
  assert.equal(events.length, 1, "the color change must be captured as one fill");
  assert.equal(events[0]?.action, "fill");
  assert.equal(events[0]?.target.css, "#c");
  assert.equal(events[0]?.value, "#112233");
});
