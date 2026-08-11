/**
 * heal — DOM-layer self-heal for a drifted SelectorBundle (m2).
 *
 * When `replay --heal` is active and every clue in a step's SelectorBundle
 * misses after a site redesign, replay hands the failing step here. We take a
 * compact snapshot of the *live* DOM (candidate interactive elements + their
 * own redundant clues), ask the user's OWN LLM API key to pick the element that
 * best matches the original bundle's intent, and return a fresh bundle. The
 * picked bundle is verified against the page before it's accepted, and the
 * repair is written into the step's `healHistory` so the asset self-improves.
 *
 * Design constraints from the plan:
 *  - No built-in / fine-tuned model. We reuse the user's existing LLM API key
 *    (any OpenAI-compatible Chat Completions endpoint via env vars).
 *  - DOM-layer relocation ONLY — no visual / pixel fallback (out_of_scope).
 *  - LLM is invoked ONLY on the `--heal` path; normal replay stays zero-LLM.
 */
import type { Page } from "playwright";

import {
  type HealRecord,
  type SelectorBundle,
  type Step,
} from "./asset.js";
import type { HealHook } from "./replay.js";
import { candidateLocators } from "./replay.js";

/** A live-DOM candidate the model can choose from. */
export interface DomCandidate {
  /** Stable index the model references in its answer. */
  index: number;
  bundle: SelectorBundle;
  /** Trimmed visible text for the model's benefit. */
  text?: string;
}

/** What the LLM must return: the index of the chosen candidate + a reason. */
export interface HealChoice {
  index: number;
  reason?: string;
}

/** A pluggable chat function so the heal logic is testable without a network. */
export type ChatFn = (prompt: string) => Promise<string>;

export interface HealOptions {
  /** Override the chat backend (tests / alternate providers). */
  chat?: ChatFn;
  /** Max live-DOM candidates to put in front of the model. */
  maxCandidates?: number;
  /** Sink for progress lines. */
  log?: (line: string) => void;
}

const DEFAULT_MAX_CANDIDATES = 40;

/**
 * Collect interactive elements from the live page and compute a redundant
 * SelectorBundle for each — the same clue shape record-time produces, so a
 * healed bundle is a drop-in replacement. Runs entirely in the page context.
 */
export async function snapshotCandidates(
  page: Page,
  action: Step["action"],
  max: number = DEFAULT_MAX_CANDIDATES,
): Promise<DomCandidate[]> {
  // The snapshot logic runs in the BROWSER. We ship it as a stringified IIFE
  // (with args inlined as JSON) rather than a normal closure so the dev runner
  // (tsx/esbuild) can't inject Node-only helpers like `__name` into the body —
  // those break once the function crosses into the page context. This mirrors
  // the same string-script pattern recorder-overlay.ts uses for the same reason.
  const script = `(${snapshotFnSource})(${JSON.stringify(action)}, ${JSON.stringify(max)})`;
  const raw = (await page.evaluate(script)) as Array<{
    bundle: Record<string, unknown>;
    text?: string;
  }>;

  return raw.map((c, i) => ({
    index: i,
    bundle: c.bundle as SelectorBundle,
    text: c.text,
  }));
}

/**
 * Browser-side snapshot routine as a plain function-source string. Takes the
 * action + candidate cap, returns `{bundle, text}[]` of visible interactive
 * elements with the same redundant clue shape record-time captures.
 */
const snapshotFnSource = `function(action, max){
  function cssEscape(value){
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(value);
    return String(value).replace(/([^a-zA-Z0-9_-])/g, "\\\\$1");
  }
  function cssPath(el){
    if (!el || el.nodeType !== 1) return undefined;
    if (el.id) return "#" + cssEscape(el.id);
    var parts = []; var node = el; var depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      var sel = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (parent) {
        var same = []; var kids = parent.children;
        for (var ki = 0; ki < kids.length; ki++) { if (kids[ki].tagName === node.tagName) same.push(kids[ki]); }
        if (same.length > 1) sel += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(sel); node = parent; depth++;
    }
    return parts.join(" > ");
  }
  function xpathOf(el){
    if (!el || el.nodeType !== 1) return undefined;
    if (el.id) return '//*[@id="' + el.id + '"]';
    var parts = []; var node = el; var depth = 0;
    while (node && node.nodeType === 1 && depth < 8) {
      var ix = 1; var sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) ix++; sib = sib.previousElementSibling; }
      parts.unshift(node.tagName.toLowerCase() + "[" + ix + "]");
      node = node.parentElement; depth++;
    }
    return "/" + parts.join("/");
  }
  function roleOf(el){
    var r = el.getAttribute("role"); if (r) return r;
    var tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      var ty = (el.getAttribute("type") || "text").toLowerCase();
      if (ty === "submit" || ty === "button") return "button";
      if (ty === "checkbox") return "checkbox";
      if (ty === "radio") return "radio";
      return "textbox";
    }
    return undefined;
  }
  function accName(el){
    var aria = el.getAttribute("aria-label"); if (aria) return aria.trim();
    if (el.labels && el.labels.length && el.labels[0].textContent) return el.labels[0].textContent.trim();
    var ph = el.getAttribute("placeholder"); if (ph) return ph.trim();
    var val = el.value; var type = (el.getAttribute("type") || "").toLowerCase();
    if ((el.tagName === "BUTTON" || type === "submit" || type === "button") && val) return String(val).trim();
    return undefined;
  }
  function textOf(el){
    var t = (el.innerText || el.textContent || "").trim();
    if (t && t.length <= 80) return t;
    return undefined;
  }
  function visible(el){
    var r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    var s = window.getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }
  var interactiveSel = action === "fill" ? "input, textarea"
    : action === "select" ? "select"
    : "a, button, input, select, textarea, [role], [onclick]";
  var all = Array.prototype.slice.call(document.querySelectorAll(interactiveSel));
  var els = []; for (var i = 0; i < all.length; i++) { if (visible(all[i])) els.push(all[i]); }
  var out = [];
  for (var j = 0; j < els.length && j < max; j++) {
    var el = els[j];
    var bundle = { tagName: el.tagName.toLowerCase() };
    var css = cssPath(el); if (css) bundle.css = css;
    var xp = xpathOf(el); if (xp) bundle.xpath = xp;
    var role = roleOf(el); if (role) bundle.role = role;
    var name = accName(el); if (name) bundle.name = name;
    var text = textOf(el); if (text) bundle.text = text;
    out.push({ bundle: bundle, text: text || name });
  }
  return out;
}`;

/** Build the prompt the model answers with a JSON `{index, reason}` choice. */
export function buildHealPrompt(
  step: Step,
  failed: SelectorBundle,
  candidates: DomCandidate[],
): string {
  const target = {
    action: step.action,
    label: step.label,
    failedSelector: failed,
  };
  const list = candidates.map((c) => ({
    index: c.index,
    role: c.bundle.role,
    name: c.bundle.name,
    text: c.text,
    css: c.bundle.css,
  }));
  return [
    "A browser automation step can no longer find its target element because the",
    "site's DOM changed. Pick the candidate element from the live DOM that best",
    "matches the ORIGINAL target's intent (same action, same role/label/text).",
    "",
    "ORIGINAL TARGET (no longer resolves):",
    JSON.stringify(target, null, 2),
    "",
    "LIVE DOM CANDIDATES:",
    JSON.stringify(list, null, 2),
    "",
    'Respond with ONLY a JSON object: {"index": <number>, "reason": "<short why>"}.',
    "Choose the single best index. Do not invent an index outside the list.",
  ].join("\n");
}

/**
 * Yield every balanced `{...}` substring in `body`, scanning left to right and
 * respecting JSON string boundaries (so a `{`/`}` inside a string value does
 * not unbalance the depth). Each yielded slice begins at a `{` whose depth
 * returns to exactly 0. Used by `parseHealChoice` to tolerate chatty models
 * that wrap the answer JSON in prose which itself contains braces (e.g.
 * `(confidence {high})`); the old greedy `/\{[\s\S]*\}/` spanned from the first
 * `{` to the LAST `}`, capturing prose + the real object and breaking
 * JSON.parse so heal silently failed.
 */
function* balancedObjects(body: string): Generator<string> {
  const n = body.length;
  for (let start = 0; start < n; start++) {
    if (body[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < n; i++) {
      const ch = body[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          yield body.slice(start, i + 1);
          break;
        }
        if (depth < 0) break; // unbalanced from this start; advance to next `{`
      }
    }
  }
}

/** Parse the model's reply into a HealChoice, tolerating ```json fences and braced prose. */
export function parseHealChoice(reply: string, max: number): HealChoice | null {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced && fenced[1] !== undefined ? fenced[1] : reply).trim();
  // Scan for balanced `{...}` objects in order (NOT a greedy `[\s\S]*`, which
  // spans first-`{` to last-`}` and breaks JSON.parse when the model wraps the
  // answer in braced prose). Return the first that parses to a valid HealChoice
  // with an in-range index.
  for (const candidate of balancedObjects(body)) {
    try {
      const obj = JSON.parse(candidate) as { index?: unknown; reason?: unknown };
      const index = typeof obj.index === "number" ? obj.index : Number(obj.index);
      if (!Number.isInteger(index) || index < 0 || index >= max) continue;
      return {
        index,
        reason: typeof obj.reason === "string" ? obj.reason : undefined,
      };
    } catch {
      // not valid JSON / not a HealChoice — try the next balanced object
    }
  }
  return null;
}

/** Default timeout (ms) for a single self-heal LLM chat-completions request. */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;

/**
 * Default chat backend: any OpenAI-compatible Chat Completions endpoint, keyed
 * by the user's OWN env vars. Nothing is bundled or fine-tuned.
 *
 *   FLOWCAST_LLM_API_KEY   (or OPENAI_API_KEY)   — required
 *   FLOWCAST_LLM_BASE_URL  (default https://api.openai.com/v1)
 *   FLOWCAST_LLM_MODEL     (default gpt-4o-mini)
 *
 * The fetch is wrapped in an `AbortController` so a misconfigured base URL, a
 * provider outage, or a hung TCP connection surfaces a readable timeout error
 * instead of hanging the entire `--heal` replay forever — Node's global
 * fetch has no default timeout.
 */
export function defaultChat(
  timeoutMs: number = DEFAULT_LLM_TIMEOUT_MS,
): ChatFn {
  const apiKey =
    process.env.FLOWCAST_LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const baseUrl = (
    process.env.FLOWCAST_LLM_BASE_URL ?? "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const model = process.env.FLOWCAST_LLM_MODEL ?? "gpt-4o-mini";

  return async (prompt: string): Promise<string> => {
    if (!apiKey) {
      throw new Error(
        "Self-heal needs your own LLM API key. Set FLOWCAST_LLM_API_KEY " +
          "(or OPENAI_API_KEY); optionally FLOWCAST_LLM_BASE_URL / " +
          "FLOWCAST_LLM_MODEL for a different provider. FlowCast bundles no model.",
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                "You re-locate a browser element after a DOM change. Reply with JSON only.",
            },
            { role: "user", content: prompt },
          ],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`LLM request failed (${res.status}): ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return data.choices?.[0]?.message?.content ?? "";
    } catch (err) {
      if (controller.signal.aborted) {
        throw new Error(
          `LLM request timed out after ${Math.max(
            1,
            Math.round(timeoutMs / 1000),
          )}s — check FLOWCAST_LLM_BASE_URL / provider availability.`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** True if a bundle resolves to EXACTLY one element on the page (the
 *  "exactly one wins" invariant `resolveLocator` enforces — tightened from
 *  `>= 1` so a heal candidate that matches several elements is rejected and
 *  `--heal` can re-disambiguate instead of silently acting on the wrong one). */
async function bundleResolves(page: Page, bundle: SelectorBundle): Promise<boolean> {
  for (const loc of candidateLocators(page, bundle)) {
    try {
      if ((await loc.count()) === 1) return true;
    } catch {
      /* keep trying other clues */
    }
  }
  return false;
}

/**
 * Build a HealHook ready to pass into `replay({ heal })`. On a selector miss it
 * snapshots the live DOM, asks the user's LLM to pick the replacement, verifies
 * the choice resolves, appends a HealRecord to the step, and returns the fresh
 * bundle. Returns null (heal failed → replay re-throws) if no candidate works.
 */
export function createHealHook(opts: HealOptions = {}): HealHook {
  const chat = opts.chat ?? defaultChat();
  const max = opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const log = opts.log ?? ((l: string) => console.log(l));

  return {
    async heal(page: Page, step: Step, failed: SelectorBundle) {
      log(`  ⚕ healing "${step.id}" — selector drifted, asking your LLM…`);
      const candidates = await snapshotCandidates(page, step.action, max);
      if (candidates.length === 0) {
        log(`  ⚕ no interactive candidates found on the live DOM — cannot heal`);
        return null;
      }

      const prompt = buildHealPrompt(step, failed, candidates);
      const reply = await chat(prompt);
      const choice = parseHealChoice(reply, candidates.length);
      if (!choice) {
        log(`  ⚕ model returned no usable choice — cannot heal`);
        return null;
      }

      const picked = candidates[choice.index]?.bundle;
      if (!picked || !(await bundleResolves(page, picked))) {
        log(`  ⚕ chosen candidate did not resolve on the page — cannot heal`);
        return null;
      }

      const record: HealRecord = {
        at: new Date().toISOString(),
        from: failed,
        to: picked,
        reason: choice.reason,
      };
      step.healHistory = [...(step.healHistory ?? []), record];
      log(
        `  ⚕ healed "${step.id}" → ${picked.css ?? picked.role ?? picked.text ?? "new selector"}` +
          (choice.reason ? ` (${choice.reason})` : ""),
      );
      return picked;
    },
  };
}
