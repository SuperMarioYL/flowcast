/**
 * replay — re-execute a recorded asset against a live Chromium, with ZERO LLM
 * calls on the happy path. This is the core m1 payoff: a recorded walkthrough
 * becomes a durable, deterministically-replayable capability.
 *
 * `resolveLocator` tries the redundant SelectorBundle clues in priority order
 * (css → xpath → role+name → text → structural). When all clues miss after a
 * site redesign it throws a `SelectorMissError`; the m2 `--heal` path hooks
 * that exact failure point to re-locate against the live DOM. Keeping the
 * resolution + step planning logic separable from Playwright I/O keeps replay
 * unit-testable.
 */
import { chromium } from "playwright";
import type { Browser, Locator, Page } from "playwright";

import {
  readFlowAsset,
  type FlowAsset,
  type SelectorBundle,
  type Step,
} from "./asset.js";
import { injectValue, resolveParams, type ParamValues } from "./params.js";

/** Thrown when no clue in a SelectorBundle resolves to a unique element. */
export class SelectorMissError extends Error {
  constructor(
    public readonly step: Step,
    public readonly bundle: SelectorBundle,
  ) {
    super(
      `No selector clue resolved for step "${step.id}" (${step.action}${
        step.label ? `: ${step.label}` : ""
      }). Run with --heal to re-locate against the live DOM.`,
    );
    this.name = "SelectorMissError";
  }
}

/** Optional hook the m2 heal path implements to recover a missed selector. */
export interface HealHook {
  /**
   * Given the page, the failing step, and its bundle, return a fresh bundle
   * that resolves — or null if it could not heal. Implementations are expected
   * to write the heal into the asset's `healHistory`.
   */
  heal(page: Page, step: Step, bundle: SelectorBundle): Promise<SelectorBundle | null>;
}

export interface ReplayOptions {
  /** CLI `--param key=value` overrides (already parsed). */
  params?: ParamValues;
  /** Run headless (default true for replay; record is always headed). */
  headless?: boolean;
  /** Per-step default timeout (ms). */
  timeoutMs?: number;
  /** Optional m2 self-heal hook. */
  heal?: HealHook;
  /** Override the browser launch (used in tests). */
  launch?: (headless: boolean) => Promise<Browser>;
  /** Sink for progress lines (defaults to console.log). */
  log?: (line: string) => void;
}

/** Outcome of a replay run. */
export interface ReplayResult {
  ok: boolean;
  stepsRun: number;
  /** Values captured by `extract` steps, keyed by step id. */
  extracted: Record<string, string>;
  /** True if any step was self-healed during this run. */
  healed: boolean;
}

const DEFAULT_TIMEOUT = 15_000;

/**
 * Build an ordered list of candidate Playwright locators from a bundle. Tried
 * in priority order; the first that resolves to exactly one element wins.
 */
export function candidateLocators(page: Page, bundle: SelectorBundle): Locator[] {
  const out: Locator[] = [];
  if (bundle.css) out.push(page.locator(bundle.css));
  if (bundle.xpath) out.push(page.locator(`xpath=${bundle.xpath}`));
  if (bundle.role && bundle.name) {
    out.push(
      page.getByRole(bundle.role as Parameters<Page["getByRole"]>[0], {
        name: bundle.name,
        exact: false,
      }),
    );
  }
  if (bundle.text) out.push(page.getByText(bundle.text, { exact: false }));
  if (bundle.css === undefined && bundle.tagName && bundle.nthOfType !== undefined) {
    out.push(page.locator(bundle.tagName).nth(bundle.nthOfType));
  }
  return out;
}

/**
 * Resolve a bundle to a single, attached locator within `timeoutMs`. Returns
 * the winning locator or throws SelectorMissError if none resolve.
 */
export async function resolveLocator(
  page: Page,
  step: Step,
  bundle: SelectorBundle,
  timeoutMs: number,
): Promise<Locator> {
  const candidates = candidateLocators(page, bundle);
  // Share ONE deadline across all candidate clues so the per-step timeout is
  // honored even when several clues miss. Previously each clue got at least
  // 500ms (Math.max(500, budget/N)), so N clues could overrun the configured
  // timeout by up to N*500ms — which on the --heal retry path (resolveLocator
  // is called twice) is the exact self-heal stall the market forecast flags.
  const start = Date.now();
  const MIN_PROBE_MS = 50; // tiny floor so a near-deadline clue still gets one quick check
  let tried = 0;
  for (const loc of candidates) {
    tried++;
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) break;
    const candidatesLeft = candidates.length - (tried - 1);
    // Equal share of the REMAINING budget among the clues still to try.
    const per = Math.max(MIN_PROBE_MS, Math.floor(remaining / candidatesLeft));
    try {
      const first = loc.first();
      await first.waitFor({ state: "attached", timeout: per });
      const count = await loc.count();
      // "the first that resolves to exactly one element wins": return ONLY on a
      // unique match. The lenient `>= 1` returned the first DOM element on an
      // ambiguous clue (a getByRole/getByText match hitting several elements),
      // silently clicking/filling the wrong one. With `count > 1` we fall
      // through to the next candidate clue, and only throw SelectorMissError
      // (→ `--heal`) if NO clue resolves uniquely.
      if (count === 1) return first;
    } catch {
      // try the next clue within the remaining budget
    }
  }
  throw new SelectorMissError(step, bundle);
}

/** Execute a single resolved step against the page. */
async function runStep(
  page: Page,
  step: Step,
  values: ParamValues,
  timeoutMs: number,
  heal: HealHook | undefined,
  extracted: Record<string, string>,
  log: (line: string) => void,
): Promise<{ healed: boolean }> {
  const t = step.timeoutMs ?? timeoutMs;

  if (step.action === "goto") {
    // Substitute {{param}} refs (e.g. `https://{{host}}/login`) before
    // navigating — goto urls are now parameterizable like fill/select values
    // (see src/asset.ts StepSchema + src/params.ts referencedParamKeys). An
    // unresolved ref throws here via injectValue rather than navigating to a
    // literal-brace URL.
    const url = injectValue(step.url!, values);
    log(`→ ${step.id} goto ${url}`);
    await page.goto(url, { timeout: t, waitUntil: "domcontentloaded" });
    return { healed: false };
  }

  const bundle = step.target!;
  let healed = false;
  let locator: Locator;
  try {
    locator = await resolveLocator(page, step, bundle, t);
  } catch (err) {
    if (!(err instanceof SelectorMissError) || !heal) throw err;
    const fresh = await heal.heal(page, step, bundle);
    if (!fresh) throw err;
    step.target = fresh;
    healed = true;
    locator = await resolveLocator(page, step, fresh, t);
  }

  switch (step.action) {
    case "click": {
      log(`→ ${step.id} click${step.label ? ` (${step.label})` : ""}`);
      await locator.click({ timeout: t });
      break;
    }
    case "fill": {
      const value = injectValue(step.value ?? "", values);
      log(`→ ${step.id} fill${step.label ? ` (${step.label})` : ""}`);
      await locator.fill(value, { timeout: t });
      break;
    }
    case "select": {
      const value = injectValue(step.value ?? "", values);
      log(`→ ${step.id} select ${value}`);
      await locator.selectOption(value, { timeout: t });
      break;
    }
    case "waitFor": {
      log(`→ ${step.id} waitFor`);
      await locator.waitFor({ state: "visible", timeout: t });
      break;
    }
    case "extract": {
      const attr = injectValue(step.value ?? "", values);
      const out = attr
        ? ((await locator.getAttribute(attr, { timeout: t })) ?? "")
        : ((await locator.textContent({ timeout: t })) ?? "").trim();
      extracted[step.id] = out;
      log(`→ ${step.id} extract = ${JSON.stringify(out)}`);
      break;
    }
  }
  return { healed };
}

/**
 * Replay a loaded asset against a fresh browser page. Pure-ish core that the
 * file-path `replay` wrapper calls; exposed for tests with a stub launcher.
 */
export async function replayAsset(
  asset: FlowAsset,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const headless = opts.headless ?? true;
  const values = resolveParams(asset, opts.params ?? {});

  const browser = opts.launch
    ? await opts.launch(headless)
    : await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const extracted: Record<string, string> = {};
  let stepsRun = 0;
  let anyHealed = false;

  try {
    for (const step of asset.steps) {
      const { healed } = await runStep(
        page,
        step,
        values,
        timeoutMs,
        opts.heal,
        extracted,
        log,
      );
      anyHealed = anyHealed || healed;
      stepsRun++;
    }
    return { ok: true, stepsRun, extracted, healed: anyHealed };
  } finally {
    await context.close().catch(() => {});
    if (!opts.launch) await browser.close().catch(() => {});
    else await browser.close().catch(() => {});
  }
}

/** Read an asset from disk and replay it. */
export async function replay(
  assetPath: string,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const asset = await readFlowAsset(assetPath);
  return replayAsset(asset, opts);
}
