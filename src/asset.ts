/**
 * flow-asset — the core primitive.
 *
 * A FlowAsset is a self-describing, parameterized, self-healing capture of a
 * browser walkthrough, persisted as `.flow.json`. This module owns the
 * canonical shape (a Zod schema), plus read/write/validate helpers. Every
 * other module (record, replay, heal, params, editor) speaks this shape.
 *
 * The redundant `SelectorBundle` is the load-bearing design decision: instead
 * of betting a step on one brittle CSS selector, we capture a bundle of
 * independent locating clues (css / xpath / aria role+name / text / structural
 * nth-of-type). Replay tries them in priority order; when they all miss after
 * a site redesign, `--heal` (m2) re-locates the element against the live DOM
 * and rewrites the bundle — recording the change in `healHistory`.
 */
import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";

/** Schema version of the on-disk `.flow.json` format. */
export const FLOW_ASSET_VERSION = "1" as const;

/**
 * A bundle of redundant locating clues for a single element. The more clues
 * captured at record time, the more resilient replay is to incidental DOM
 * churn — and the more context `--heal` has when it must re-locate.
 */
export const SelectorBundleSchema = z
  .object({
    /** Primary CSS selector (preferred at replay time when present). */
    css: z.string().min(1).optional(),
    /** Absolute or relative XPath fallback. */
    xpath: z.string().min(1).optional(),
    /** ARIA role, e.g. "button", "textbox", "link". */
    role: z.string().min(1).optional(),
    /** Accessible name (label / text) paired with `role`. */
    name: z.string().min(1).optional(),
    /** Visible text content, used for text-anchored lookup. */
    text: z.string().min(1).optional(),
    /** Structural fallback: index among same-tag siblings (0-based). */
    nthOfType: z.number().int().nonnegative().optional(),
    /** Tag name captured for structural / heal context, e.g. "input". */
    tagName: z.string().min(1).optional(),
  })
  .refine(
    (b) =>
      Boolean(
        b.css ||
          b.xpath ||
          (b.role && b.name) ||
          b.text ||
          b.nthOfType !== undefined,
      ),
    {
      message:
        "SelectorBundle must carry at least one usable clue (css / xpath / role+name / text / nthOfType)",
    },
  );

export type SelectorBundle = z.infer<typeof SelectorBundleSchema>;

/** The actions a recorded step can perform. */
export const StepActionSchema = z.enum([
  "goto",
  "click",
  "fill",
  "select",
  "waitFor",
  "extract",
]);

export type StepAction = z.infer<typeof StepActionSchema>;

/** One audit record of a self-heal re-location (written by m2 `--heal`). */
export const HealRecordSchema = z.object({
  /** ISO-8601 timestamp of when the heal happened. */
  at: z.string().min(1),
  /** The bundle that failed to resolve. */
  from: SelectorBundleSchema,
  /** The bundle the heal produced. */
  to: SelectorBundleSchema,
  /** Human/LLM rationale for the re-location. */
  reason: z.string().optional(),
});

export type HealRecord = z.infer<typeof HealRecordSchema>;

/**
 * A single recorded step. `goto` carries a `url`; element actions carry a
 * `target` SelectorBundle. `value` may contain `{{param}}` references that
 * `params.ts` resolves at replay time.
 */
export const StepSchema = z
  .object({
    /** Stable id within the asset (e.g. "s1"), used by edit/heal/log. */
    id: z.string().min(1),
    action: StepActionSchema,
    /** For `goto`: the destination URL. */
    url: z.string().url().optional(),
    /** For element actions: the redundant locator bundle. */
    target: SelectorBundleSchema.optional(),
    /**
     * For `fill` / `select`: the value to enter (may be a `{{param}}` ref).
     * For `extract`: an optional attribute name to read (defaults to text).
     */
    value: z.string().optional(),
    /** Optional per-step timeout override in milliseconds. */
    timeoutMs: z.number().int().positive().optional(),
    /** Optional human-readable label shown in logs and the editor UI. */
    label: z.string().optional(),
    /** Audit trail of self-heal re-locations for this step. */
    healHistory: z.array(HealRecordSchema).optional(),
  })
  .superRefine((step, ctx) => {
    if (step.action === "goto") {
      if (!step.url) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "goto step requires a `url`",
          path: ["url"],
        });
      }
    } else if (!step.target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${step.action} step requires a \`target\` SelectorBundle`,
        path: ["target"],
      });
    }
    if ((step.action === "fill" || step.action === "select") && step.value === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${step.action} step requires a \`value\``,
        path: ["value"],
      });
    }
  });

export type Step = z.infer<typeof StepSchema>;

/** A declared parameter that `{{param}}` references resolve against. */
export const ParamSchema = z.object({
  key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
    message: "param key must be a valid identifier ([A-Za-z_][A-Za-z0-9_]*)",
  }),
  default: z.string().optional(),
  required: z.boolean().default(false),
  description: z.string().optional(),
});

export type Param = z.infer<typeof ParamSchema>;

/** The full on-disk flow-asset. */
export const FlowAssetSchema = z.object({
  version: z.literal(FLOW_ASSET_VERSION),
  name: z.string().min(1),
  /** Optional free-text describing what the flow does. */
  description: z.string().optional(),
  /** When the asset was first recorded (ISO-8601). */
  recordedAt: z.string().optional(),
  params: z.array(ParamSchema).default([]),
  steps: z.array(StepSchema).min(1, "a flow asset needs at least one step"),
});

export type FlowAsset = z.infer<typeof FlowAssetSchema>;

/**
 * Parse + validate an unknown value into a FlowAsset, throwing a readable
 * error with the offending path if it doesn't conform.
 */
export function parseFlowAsset(data: unknown): FlowAsset {
  const result = FlowAssetSchema.safeParse(data);
  if (!result.success) {
    const lines = result.error.issues.map((i) => {
      const path = i.path.length ? i.path.join(".") : "(root)";
      return `  - ${path}: ${i.message}`;
    });
    throw new Error(`Invalid flow asset:\n${lines.join("\n")}`);
  }
  return result.data;
}

/** Read and validate a `.flow.json` asset from disk. */
export async function readFlowAsset(path: string): Promise<FlowAsset> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `Cannot read flow asset at "${path}": ${(err as Error).message}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `"${path}" is not valid JSON: ${(err as Error).message}`,
    );
  }
  return parseFlowAsset(json);
}

/**
 * Serialize a FlowAsset to pretty JSON (stable 2-space indent, trailing
 * newline). Validates before writing so we never persist a malformed asset.
 */
export function serializeFlowAsset(asset: FlowAsset): string {
  const validated = parseFlowAsset(asset);
  return `${JSON.stringify(validated, null, 2)}\n`;
}

/** Validate and write a FlowAsset to disk as `.flow.json`. */
export async function writeFlowAsset(
  path: string,
  asset: FlowAsset,
): Promise<void> {
  await writeFile(path, serializeFlowAsset(asset), "utf8");
}

/** Build a fresh, empty-but-valid asset shell for the recorder to fill. */
export function emptyAsset(name: string): Omit<FlowAsset, "steps"> & {
  steps: Step[];
} {
  return {
    version: FLOW_ASSET_VERSION,
    name,
    recordedAt: new Date().toISOString(),
    params: [],
    steps: [],
  };
}
