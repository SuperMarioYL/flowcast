import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSteps,
  assembleAsset,
  nameFromPath,
  type TimelineEvent,
} from "../src/record.js";
import { parseFlowAsset } from "../src/asset.js";

test("nameFromPath strips the .flow.json suffix", () => {
  assert.equal(nameFromPath("./login.flow.json"), "login");
  assert.equal(nameFromPath("/a/b/checkout.flow.json"), "checkout");
  assert.equal(nameFromPath("plain.json"), "plain");
});

test("buildSteps assigns sequential ids", () => {
  const timeline: TimelineEvent[] = [
    { kind: "goto", url: "https://x.io/login" },
    { kind: "interaction", action: "click", target: { css: "#go" } },
  ];
  const steps = buildSteps(timeline);
  assert.deepEqual(
    steps.map((s) => s.id),
    ["s1", "s2"],
  );
});

test("buildSteps collapses duplicate consecutive navigations", () => {
  const timeline: TimelineEvent[] = [
    { kind: "goto", url: "https://x.io/a" },
    { kind: "goto", url: "https://x.io/a" },
    { kind: "goto", url: "https://x.io/b" },
  ];
  const steps = buildSteps(timeline);
  assert.deepEqual(
    steps.map((s) => s.url),
    ["https://x.io/a", "https://x.io/b"],
  );
});

test("buildSteps folds consecutive fills on the same target to the last value", () => {
  const target = { css: "#user", xpath: "//*[@id='user']" };
  const timeline: TimelineEvent[] = [
    { kind: "interaction", action: "fill", target, value: "a" },
    { kind: "interaction", action: "fill", target, value: "al" },
    { kind: "interaction", action: "fill", target, value: "alice" },
  ];
  const steps = buildSteps(timeline);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.value, "alice");
});

test("buildSteps keeps fills on different targets separate", () => {
  const timeline: TimelineEvent[] = [
    { kind: "interaction", action: "fill", target: { css: "#user", xpath: "/a" }, value: "alice" },
    { kind: "interaction", action: "fill", target: { css: "#pass", xpath: "/b" }, value: "pw" },
  ];
  const steps = buildSteps(timeline);
  assert.equal(steps.length, 2);
});

test("assembleAsset produces a schema-valid asset", () => {
  const timeline: TimelineEvent[] = [
    { kind: "goto", url: "https://x.io/login" },
    { kind: "interaction", action: "fill", target: { css: "#user" }, value: "alice" },
    { kind: "interaction", action: "click", target: { role: "button", name: "Login" } },
  ];
  const asset = assembleAsset("login", timeline);
  // Must not throw — validates against the same schema replay reads.
  const parsed = parseFlowAsset(asset);
  assert.equal(parsed.name, "login");
  assert.equal(parsed.steps.length, 3);
});

test("buildSteps collapses consecutive fills on a css-less element (role+name)", () => {
  // Element captured WITHOUT a css/xpath selector — only role+name/text/nth.
  // Old sameSelector returned false when both css were undefined, so every
  // keystroke became its own fill step instead of collapsing to the last value.
  const target = {
    role: "textbox",
    name: "Username",
    text: "Username",
    tagName: "input",
    nthOfType: 0,
  };
  const timeline: TimelineEvent[] = [
    { kind: "interaction", action: "fill", target: { ...target }, value: "a" },
    { kind: "interaction", action: "fill", target: { ...target }, value: "al" },
    { kind: "interaction", action: "fill", target: { ...target }, value: "alice" },
  ];
  const steps = buildSteps(timeline);
  assert.equal(steps.length, 1, "expected a single collapsed fill step");
  assert.equal(steps[0]?.action, "fill");
  assert.equal(steps[0]?.value, "alice");
});

test("buildSteps keeps css-less fills on different targets separate", () => {
  // Two different css-less textboxes (distinct role+name) must NOT collapse.
  const timeline: TimelineEvent[] = [
    {
      kind: "interaction",
      action: "fill",
      target: { role: "textbox", name: "Username", tagName: "input", nthOfType: 0 },
      value: "alice",
    },
    {
      kind: "interaction",
      action: "fill",
      target: { role: "textbox", name: "Password", tagName: "input", nthOfType: 1 },
      value: "pw",
    },
  ];
  const steps = buildSteps(timeline);
  assert.equal(steps.length, 2);
  assert.equal(steps[0]?.value, "alice");
  assert.equal(steps[1]?.value, "pw");
});
