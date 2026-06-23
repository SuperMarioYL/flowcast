/**
 * params — `{{param}}` resolution and injection.
 *
 * Recorded step values may contain `{{key}}` references. At replay time the
 * user supplies overrides (`--param key=value`); we merge those with the
 * asset's declared defaults, validate that every required param is satisfied,
 * and substitute references inside step values. Normal replay performs zero
 * LLM calls — this is pure, deterministic string work.
 */
import type { FlowAsset, Param } from "./asset.js";

/** Matches `{{ key }}` with optional surrounding whitespace. */
const PARAM_REF = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Resolved param values keyed by name. */
export type ParamValues = Record<string, string>;

/**
 * Parse `key=value` CLI pairs into a record. Splits only on the first `=`, so
 * values may themselves contain `=`. Throws on a malformed pair.
 */
export function parseParamPairs(pairs: readonly string[]): ParamValues {
  const out: ParamValues = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `Invalid --param "${pair}": expected key=value (e.g. account=alice)`,
      );
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(
        `Invalid --param key "${key}": must be a valid identifier`,
      );
    }
    out[key] = value;
  }
  return out;
}

/** Every distinct `{{param}}` key referenced anywhere in the asset's steps. */
export function referencedParamKeys(asset: FlowAsset): string[] {
  const keys = new Set<string>();
  for (const step of asset.steps) {
    if (typeof step.value === "string") {
      for (const match of step.value.matchAll(PARAM_REF)) {
        const key = match[1];
        if (key) keys.add(key);
      }
    }
  }
  return [...keys];
}

/**
 * Merge declared defaults with CLI overrides, then verify completeness:
 * - every `required` declared param must end up with a value;
 * - every `{{param}}` referenced in steps must be resolvable.
 * Returns the fully-resolved value map or throws a single readable error.
 */
export function resolveParams(
  asset: FlowAsset,
  overrides: ParamValues = {},
): ParamValues {
  const declared = new Map<string, Param>(asset.params.map((p) => [p.key, p]));
  const resolved: ParamValues = {};

  // Seed from declared defaults.
  for (const p of asset.params) {
    if (p.default !== undefined) resolved[p.key] = p.default;
  }
  // Apply CLI overrides on top.
  for (const [k, v] of Object.entries(overrides)) {
    resolved[k] = v;
  }

  const missing: string[] = [];

  // Required declared params must have a value.
  for (const p of asset.params) {
    if (p.required && resolved[p.key] === undefined) missing.push(p.key);
  }
  // Any referenced-but-unresolved param is also missing (catches undeclared
  // `{{key}}` refs that have no default and no override).
  for (const key of referencedParamKeys(asset)) {
    if (resolved[key] === undefined && !missing.includes(key)) {
      const isDeclared = declared.has(key);
      if (!isDeclared || declared.get(key)?.default === undefined) {
        missing.push(key);
      }
    }
  }

  if (missing.length > 0) {
    const hints = missing
      .map((k) => {
        const d = declared.get(k)?.description;
        return d ? `  - ${k} (${d})` : `  - ${k}`;
      })
      .join("\n");
    throw new Error(
      `Missing required parameter(s):\n${hints}\n` +
        `Supply them with --param ${missing[0]}=<value>`,
    );
  }

  return resolved;
}

/**
 * Substitute every `{{key}}` in a string with its resolved value. Throws if a
 * reference has no resolved value (resolveParams should have caught this, but
 * this guards direct callers).
 */
export function injectValue(template: string, values: ParamValues): string {
  return template.replace(PARAM_REF, (_, key: string) => {
    const v = values[key];
    if (v === undefined) {
      throw new Error(`Unresolved parameter "{{${key}}}"`);
    }
    return v;
  });
}

/** True if the string contains at least one `{{param}}` reference. */
export function hasParamRef(value: string): boolean {
  PARAM_REF.lastIndex = 0;
  return PARAM_REF.test(value);
}
