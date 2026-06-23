/**
 * record — capture a human walkthrough into a `.flow.json` asset.
 *
 * Launches a headed Chromium (via Playwright), injects the recorder overlay,
 * and listens for captured interactions plus navigations. When the user closes
 * the window the collected events are folded into a validated FlowAsset and
 * written to disk.
 *
 * The event→step folding (`buildSteps`) is a pure function so it can be unit
 * tested without a browser; the Playwright orchestration (`record`) is the thin
 * I/O shell around it.
 */
import { chromium } from "playwright";
import type { Browser } from "playwright";

import {
  emptyAsset,
  writeFlowAsset,
  type FlowAsset,
  type Step,
} from "./asset.js";
import {
  EMIT_BINDING,
  overlayScript,
  type CapturedEvent,
} from "./recorder-overlay.js";

/** A raw event in the recording timeline: either a navigation or an interaction. */
export type TimelineEvent =
  | { kind: "goto"; url: string }
  | ({ kind: "interaction" } & CapturedEvent);

export interface RecordOptions {
  /** Start URL to open before handing control to the user. */
  startUrl?: string;
  /** Friendly asset name; defaults to the output file stem. */
  name?: string;
  /** Override the browser launch (used in tests). */
  launch?: () => Promise<Browser>;
}

/**
 * Fold a raw event timeline into validated steps. Pure + deterministic:
 * - assigns stable ids (s1, s2, …);
 * - collapses consecutive `fill` events on the same target into the last value
 *   (typing fires many change events; we want the final value);
 * - drops a redundant leading `goto` that duplicates the very first navigation.
 */
export function buildSteps(timeline: readonly TimelineEvent[]): Step[] {
  const steps: Step[] = [];
  let counter = 0;
  const nextId = () => `s${++counter}`;

  for (const ev of timeline) {
    if (ev.kind === "goto") {
      const last = steps[steps.length - 1];
      // Collapse duplicate consecutive navigations to the same URL.
      if (last && last.action === "goto" && last.url === ev.url) continue;
      steps.push({ id: nextId(), action: "goto", url: ev.url });
      continue;
    }

    if (ev.action === "fill") {
      const last = steps[steps.length - 1];
      const sameTarget =
        last &&
        last.action === "fill" &&
        sameSelector(last.target?.css, ev.target.css) &&
        sameSelector(last.target?.xpath, ev.target.xpath);
      if (sameTarget && last) {
        last.value = ev.value ?? "";
        last.label = ev.label ?? last.label;
        continue;
      }
      steps.push({
        id: nextId(),
        action: "fill",
        target: ev.target,
        value: ev.value ?? "",
        label: ev.label,
      });
      continue;
    }

    if (ev.action === "select") {
      steps.push({
        id: nextId(),
        action: "select",
        target: ev.target,
        value: ev.value ?? "",
        label: ev.label,
      });
      continue;
    }

    // click
    steps.push({
      id: nextId(),
      action: "click",
      target: ev.target,
      label: ev.label,
    });
  }

  return steps;
}

function sameSelector(a?: string, b?: string): boolean {
  return a !== undefined && a === b;
}

/** Assemble a complete, validated asset from a name and a timeline. */
export function assembleAsset(name: string, timeline: TimelineEvent[]): FlowAsset {
  const shell = emptyAsset(name);
  const steps = buildSteps(timeline);
  return { ...shell, steps };
}

/** Derive a readable asset name from an output path (file stem). */
export function nameFromPath(outPath: string): string {
  const base = outPath.split(/[\\/]/).pop() ?? outPath;
  return base.replace(/\.flow\.json$/i, "").replace(/\.json$/i, "") || "flow";
}

/**
 * Run an interactive recording session and write the asset to `outPath`.
 * Resolves with the written asset once the user closes the browser window.
 */
export async function record(
  outPath: string,
  opts: RecordOptions = {},
): Promise<FlowAsset> {
  const name = opts.name ?? nameFromPath(outPath);
  const timeline: TimelineEvent[] = [];

  const browser = opts.launch
    ? await opts.launch()
    : await chromium.launch({ headless: false });

  const context = await browser.newContext();
  const page = await context.newPage();

  // Receive interaction events from the in-page overlay.
  await context.exposeBinding(EMIT_BINDING, (_source, payload: string) => {
    try {
      const ev = JSON.parse(payload) as CapturedEvent;
      timeline.push({ kind: "interaction", ...ev });
    } catch {
      /* ignore malformed payloads */
    }
  });

  // Inject the overlay into every document (top frame + future navigations).
  await context.addInitScript({ content: overlayScript(EMIT_BINDING) });

  // Record top-level navigations as `goto` steps.
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!url || url === "about:blank") return;
    timeline.push({ kind: "goto", url });
  });

  if (opts.startUrl) {
    await page.goto(opts.startUrl);
  }

  // Wait until the user closes the window (or the context is disposed).
  await waitForClose(context, browser);

  const asset = assembleAsset(name, timeline);
  await writeFlowAsset(outPath, asset);
  return asset;
}

/** Resolve when the browser context or browser is closed by the user. */
function waitForClose(
  context: import("playwright").BrowserContext,
  browser: Browser,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    context.on("close", finish);
    browser.on("disconnected", finish);
  });
}
