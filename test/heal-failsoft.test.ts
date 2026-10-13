import { test } from "node:test";
import assert from "node:assert/strict";

import { createHealHook } from "../src/heal.js";
import type { HealHook } from "../src/replay.js";
import type { Page, Locator } from "playwright";
import type { SelectorBundle, Step } from "../src/asset.js";

// --- fix-heal-infra-errors-mask-selector-miss --------------------------------
//
// The HealHook contract (src/replay.ts HealHook, src/heal.ts createHealHook
// docs) is "return a fresh bundle — or null if it could not heal", so replay
// re-throws the original SelectorMissError (whose message tells the user to
// run with --heal). Before the fix, an exception inside the hook — a chat
// fetch failure (network error / provider 5xx / timeout from defaultChat) or
// a page.evaluate race where a navigation destroys the execution context
// mid-snapshot — propagated OUT of hook.heal, and replay.ts awaits heal()
// outside its try, so the raw infra error replaced the actionable
// SelectorMissError. The hook now converts both failures into a logged reason
// + null. These tests pin that contract without a browser.

const step: Step = { id: "s1", action: "click", target: { css: "#x" }, label: "the button" };
const failed: SelectorBundle = { css: "#x" };

/** A page stub whose evaluate rejects (navigation race) — the only surface snapshotCandidates touches. */
function pageWithBrokenEvaluate(): Page {
  return {
    evaluate: async () => {
      throw new Error("page.evaluate: Execution context was destroyed");
    },
  } as unknown as Page;
}

/** A page stub whose snapshot succeeds with one candidate, so the flow reaches the chat call. */
function pageWithCandidates(picked: SelectorBundle): Page {
  return {
    evaluate: async () => [{ bundle: picked, text: "Sign in" }],
  } as unknown as Page;
}

test("heal resolves null (not reject) when the LLM chat call throws", async () => {
  const lines: string[] = [];
  const hook: HealHook = createHealHook({
    chat: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    },
    log: (l) => lines.push(l),
  });
  // Without the fix this rejects with the raw fetch error and replay's
  // actionable "Run with --heal" SelectorMissError is lost.
  const out = await hook.heal(pageWithCandidates({ css: "#renamed", text: "Sign in" }), step, failed);
  assert.equal(out, null, "a chat failure must resolve null per the HealHook contract");
  assert.ok(
    lines.some((l) => l.includes("heal failed") && l.includes("ECONNREFUSED")),
    "the failure reason must be logged, not swallowed",
  );
});

test("heal resolves null when the live-DOM snapshot races a navigation", async () => {
  const lines: string[] = [];
  const hook: HealHook = createHealHook({
    chat: async () => {
      throw new Error("chat must not be reached");
    },
    log: (l) => lines.push(l),
  });
  const out = await hook.heal(pageWithBrokenEvaluate(), step, failed);
  assert.equal(out, null, "an evaluate race must resolve null per the HealHook contract");
  assert.ok(
    lines.some((l) => l.includes("could not snapshot the live DOM")),
    "the snapshot failure reason must be logged",
  );
});

test("heal still appends a HealRecord and returns the picked bundle on success", async () => {
  const picked: SelectorBundle = { css: "#renamed-button", text: "Sign in" };
  // A page stub whose evaluate returns one candidate that resolves uniquely.
  const loc = {
    count: async () => 1,
  } as unknown as Locator;
  const page = {
    evaluate: async () => [{ bundle: picked, text: "Sign in" }],
    locator: () => loc,
    getByRole: () => loc,
    getByText: () => loc,
  } as unknown as Page;
  const hook: HealHook = createHealHook({
    chat: async () => 'Sure! {"index": 0, "reason": "renamed element"}',
    log: () => {},
  });
  const out = await hook.heal(page, step, failed);
  assert.deepEqual(out, picked);
  assert.equal(step.healHistory?.length, 1);
  assert.equal(step.healHistory?.[0]?.from.css, "#x");
  assert.equal(step.healHistory?.[0]?.to.css, "#renamed-button");
  assert.equal(step.healHistory?.[0]?.reason, "renamed element");
});
