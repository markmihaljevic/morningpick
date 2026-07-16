import { anthropic } from "./anthropic";
import { config } from "./config";
import type { TickerData } from "./fmp";
import { sanitizeDatasetForPrompt } from "./figures";
import type { Profile } from "./profile";

/**
 * The conviction assessment: after the full dataset is in hand, the head of
 * research reads the name ONCE — never to veto it (John's July 16 rule 4:
 * "conviction carries the quality signal, not silence"). The subscriber pays
 * for a funnel and does his own diligence; the scorer decided what ships.
 * This step produces the honest conviction number the note carries ("best of
 * a quiet list, 4/10") and names what would change it. Fails open to a
 * neutral 6/10 — a missing assessment must never kill the morning note.
 */

const ASSESS_SCHEMA = {
  type: "object",
  properties: {
    conviction: {
      type: "integer",
      description: "1-10: the conviction an honest analyst could put behind this pitch today",
    },
    reason: { type: "string", description: "one sentence: what drives the number" },
    what_would_change: {
      type: "string",
      description:
        "one sentence: the concrete development that would move this conviction up (a filing, a result, a corporate event — dated where possible)",
    },
  },
  required: ["conviction", "reason", "what_would_change"],
  additionalProperties: false,
} as const;

const ASSESS_SYSTEM =
  "You are the head of research at an investment desk. The screening and scoring funnel has " +
  "already decided this name ships this morning — you do NOT get a veto, and low liquidity, a " +
  "quiet tape, sparse analyst coverage, or the absence of a near-term catalyst are NOT marks " +
  "against it (for a deep-value buyer, illiquidity is often where the discount comes from). " +
  "Your job is the honest conviction number the note will carry: 8-10 a live mispricing with a " +
  "hard catalyst, 6-7 solid value that needs patience, 4-5 statistically cheap but the case is " +
  "thin today, 1-3 the data suggests the cheapness is deserved. Say what drives the number and " +
  "name the concrete development that would raise it. Honest, not harsh — and never inflate: a " +
  "4 written as a 4 is the product working.";

export interface PreflightResult {
  expectedConviction: number;
  reason: string;
  /** The concrete development that would raise the conviction — rule 4's
   * "name what would change it". */
  whatWouldChange: string;
}

/** Compact dataset digest — the check needs the shape, not the transcript.
 * TTM vintages only: the annual ratio rows are stamped at fiscal-year-end
 * prices and would anchor the conviction judgment on stale valuations. */
function digestData(data: TickerData): string {
  const d = sanitizeDatasetForPrompt(data) as unknown as Record<string, unknown>;
  const pick: Record<string, unknown> = {};
  for (const key of ["profile", "quote", "keyMetricsTTM", "ratiosTTM", "street", "earnings"]) {
    if (key in d) pick[key] = d[key];
  }
  return JSON.stringify(pick).slice(0, 18_000);
}

export async function preflightCheck(args: {
  ticker: string;
  data: TickerData;
  selectionRationale: string;
  profile: Profile;
}): Promise<PreflightResult> {
  const failOpen: PreflightResult = {
    expectedConviction: 6,
    reason: "assessment unavailable — neutral conviction",
    whatWouldChange: "",
  };
  try {
    const response = await anthropic().messages.create({
      model: config().FEEDBACK_MODEL,
      max_tokens: 4000,
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema: ASSESS_SCHEMA }, effort: "low" },
      system: ASSESS_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `Ticker: ${args.ticker}\n` +
            `How it got here: ${args.selectionRationale}\n\n` +
            `<subscriber_profile>${JSON.stringify(args.profile.structured)}</subscriber_profile>\n\n` +
            `<dataset_digest>\n${digestData(args.data)}\n</dataset_digest>`,
        },
      ],
    });
    if (response.stop_reason === "refusal") return failOpen;
    const text = response.content.find((b) => b.type === "text");
    const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as {
      conviction?: number;
      reason?: string;
      what_would_change?: string;
    };
    return {
      expectedConviction: Math.min(10, Math.max(1, Math.round(parsed.conviction ?? 6))),
      reason: (parsed.reason ?? "").slice(0, 300),
      whatWouldChange: (parsed.what_would_change ?? "").slice(0, 300),
    };
  } catch (e) {
    console.error("Conviction assessment failed (fail-open):", e);
    return failOpen;
  }
}
