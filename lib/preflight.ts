import { anthropic } from "./anthropic";
import { config } from "./config";
import type { TickerData } from "./fmp";
import type { Profile } from "./profile";

/**
 * The pre-flight check: after the full dataset is in hand but BEFORE the
 * expensive write, the head of research asks one question — is this still
 * worth the subscriber's morning? Selection committed on thin data (screener
 * rows + headlines); this is the veto with the real numbers on the desk.
 * Fails open ("write") — a missing check must never kill the morning note.
 */

const PREFLIGHT_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["write", "pass"],
      description: "pass ONLY when the setup is genuinely weak with the full data in view",
    },
    expected_conviction: {
      type: "integer",
      description: "1-10: the conviction an honest analyst could put behind this pitch today",
    },
    reason: { type: "string", description: "one sentence" },
  },
  required: ["verdict", "expected_conviction", "reason"],
  additionalProperties: false,
} as const;

const PREFLIGHT_SYSTEM =
  "You are the head of research at an investment desk. Selection chose this ticker from a " +
  "shortlist using thin screener data; you now have the full dataset. Decide whether the pitch " +
  "is worth a sophisticated subscriber's morning. verdict 'write' when an honest analyst could " +
  "pitch it at conviction 6+ — a live or upcoming catalyst, a real mispricing argument, or a " +
  "risk/reward worth underwriting. verdict 'pass' when the full data reveals the setup is weak: " +
  "the catalyst is stale or fully priced, the spread/upside is too thin to matter, the " +
  "cheapness is justified by the fundamentals, or the 'why now' has evaporated. Be honest, not " +
  "harsh — most selections should survive; you exist to catch the genuinely weak ones.";

export interface PreflightResult {
  write: boolean;
  expectedConviction: number;
  reason: string;
}

/** Compact dataset digest — the check needs the shape, not the transcript.
 * TTM vintages only: the annual ratio rows are stamped at fiscal-year-end
 * prices and would anchor the conviction judgment on stale valuations. */
function digestData(data: TickerData): string {
  const d = data as unknown as Record<string, unknown>;
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
  try {
    const response = await anthropic().messages.create({
      model: config().FEEDBACK_MODEL,
      max_tokens: 4000,
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema: PREFLIGHT_SCHEMA }, effort: "low" },
      system: PREFLIGHT_SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `Ticker: ${args.ticker}\n` +
            `Selection's rationale (from thin data): ${args.selectionRationale}\n\n` +
            `<subscriber_profile>${JSON.stringify(args.profile.structured)}</subscriber_profile>\n\n` +
            `<dataset_digest>\n${digestData(args.data)}\n</dataset_digest>`,
        },
      ],
    });
    if (response.stop_reason === "refusal") {
      return { write: true, expectedConviction: 6, reason: "preflight refused — fail open" };
    }
    const text = response.content.find((b) => b.type === "text");
    const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as {
      verdict?: string;
      expected_conviction?: number;
      reason?: string;
    };
    return {
      write: parsed.verdict !== "pass",
      expectedConviction: Math.min(10, Math.max(1, Math.round(parsed.expected_conviction ?? 6))),
      reason: (parsed.reason ?? "").slice(0, 300),
    };
  } catch (e) {
    console.error("Preflight failed (fail-open, writing):", e);
    return { write: true, expectedConviction: 6, reason: "preflight errored — fail open" };
  }
}
