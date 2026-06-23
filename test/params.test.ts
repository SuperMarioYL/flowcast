import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseParamPairs,
  referencedParamKeys,
  resolveParams,
  injectValue,
  hasParamRef,
} from "../src/params.js";
import type { FlowAsset } from "../src/asset.js";

function asset(partial: Partial<FlowAsset>): FlowAsset {
  return {
    version: "1",
    name: "t",
    params: [],
    steps: [{ id: "s1", action: "goto", url: "https://x.io" }],
    ...partial,
  };
}

test("parseParamPairs splits on the first =", () => {
  assert.deepEqual(parseParamPairs(["account=alice", "token=a=b=c"]), {
    account: "alice",
    token: "a=b=c",
  });
});

test("parseParamPairs rejects a pair without =", () => {
  assert.throws(() => parseParamPairs(["nope"]), /expected key=value/);
});

test("parseParamPairs rejects a bad key", () => {
  assert.throws(() => parseParamPairs(["1x=y"]), /valid identifier/);
});

test("referencedParamKeys finds all {{refs}}", () => {
  const a = asset({
    steps: [
      { id: "s1", action: "fill", target: { css: "#u" }, value: "{{account}}" },
      { id: "s2", action: "fill", target: { css: "#p" }, value: "{{ pass }}" },
      { id: "s3", action: "click", target: { css: "#b" } },
    ],
  });
  assert.deepEqual(referencedParamKeys(a).sort(), ["account", "pass"]);
});

test("resolveParams seeds defaults then applies overrides", () => {
  const a = asset({
    params: [
      { key: "account", default: "bob", required: true },
      { key: "env", default: "prod", required: false },
    ],
    steps: [
      { id: "s1", action: "fill", target: { css: "#u" }, value: "{{account}}" },
    ],
  });
  const resolved = resolveParams(a, { account: "alice" });
  assert.equal(resolved.account, "alice");
  assert.equal(resolved.env, "prod");
});

test("resolveParams throws when a required param is unset", () => {
  const a = asset({
    params: [{ key: "account", required: true }],
    steps: [
      { id: "s1", action: "fill", target: { css: "#u" }, value: "{{account}}" },
    ],
  });
  assert.throws(() => resolveParams(a), /Missing required parameter/);
});

test("resolveParams throws on an undeclared referenced param", () => {
  const a = asset({
    steps: [
      { id: "s1", action: "fill", target: { css: "#u" }, value: "{{ghost}}" },
    ],
  });
  assert.throws(() => resolveParams(a), /ghost/);
});

test("injectValue substitutes refs", () => {
  assert.equal(
    injectValue("user {{account}} on {{env}}", { account: "alice", env: "prod" }),
    "user alice on prod",
  );
});

test("injectValue throws on unresolved ref", () => {
  assert.throws(() => injectValue("{{x}}", {}), /Unresolved parameter/);
});

test("hasParamRef detects refs", () => {
  assert.equal(hasParamRef("{{x}}"), true);
  assert.equal(hasParamRef("plain"), false);
});
