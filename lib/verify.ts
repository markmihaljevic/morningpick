import { anthropic } from "./anthropic";
import { config } from "./config";
import { logEvent } from "./db";
import type { TickerData } from "./fmp";

export interface VerificationResult {
  passed: boolean;
  critical_issues: { claim: string; problem: string }[];
  minor_issues: { claim: string; problem: string }[];
}

const VERIFY_SCHEMA = {
  type: "object",
  properties: {
    critical_issues: {
      type: "array",
      description:
        "Fabricated or materially wrong figures: numbers that contradict the dataset, invented data attributed to the dataset, or wrong-by-magnitude claims",
      items: {
        type: "object",
        properties: {
          claim: { type: "string", description: "The exact claim from the memo" },
          problem: { type: "string", description: "What is wrong and what the data actually says" },
        },
        required: ["claim", "problem"],
        additionalProperties: false,
      },
    },
    minor_issues: {
      type: "array",
      description: "Rounding quibbles, ambiguous attribution, or stylistic imprecision — not blockers",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          problem: { type: "string" },
        },
        required: ["claim", "problem"],
        additionalProperties: false,
      },
    },
  },
  required: ["critical_issues", "minor_issues"],
  additionalProperties: false,
} as const;

const VERIFY_SYSTEM = `You are a fact-checker for an investment memo before it is emailed to a subscriber.

Audit every numerical claim in the memo against the provided FMP dataset:
- A figure attributed to the data (prices, market cap, multiples, margins, growth rates, EPS, balance-sheet items, insider transactions) must match the dataset within reasonable rounding (~1-2%).
- Figures explicitly attributed to a cited web source (a domain in parentheses) are OUT OF SCOPE — do not flag them; you cannot see those sources.
- Derived arithmetic (e.g. "up 14% year over year" computed from two dataset numbers) should be checked by recomputing it.
- Flag as CRITICAL: contradictions with the dataset, invented figures presented as dataset facts, magnitude errors, or wrong currency/units.
- Flag as MINOR: rounding beyond ~2%, vague attribution, stale phrasing.
Do not comment on investment logic, style, or opinions — numbers only.`;

/** Audit a memo's figures against the grounding dataset. Fail-open on errors. */
export async function verifyMemo(
  markdown: string,
  data: TickerData,
): Promise<VerificationResult> {
  try {
    const response = await anthropic().messages.create({
      model: config().FEEDBACK_MODEL,
      max_tokens: 12000,
      output_config: {
        format: { type: "json_schema", schema: VERIFY_SCHEMA },
        effort: "medium",
      },
      system: VERIFY_SYSTEM,
      messages: [
        {
          role: "user",
          content: `<fmp_dataset>\n${JSON.stringify(data)}\n</fmp_dataset>\n\n<memo>\n${markdown}\n</memo>`,
        },
      ],
    });
    if (response.stop_reason === "refusal") {
      return { passed: true, critical_issues: [], minor_issues: [] };
    }
    const text = response.content.find((b) => b.type === "text");
    const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as {
      critical_issues: { claim: string; problem: string }[];
      minor_issues: { claim: string; problem: string }[];
    };
    return {
      passed: (parsed.critical_issues ?? []).length === 0,
      critical_issues: parsed.critical_issues ?? [],
      minor_issues: parsed.minor_issues ?? [],
    };
  } catch (e) {
    // Verification must never block a send on its own infrastructure failure —
    // but a fail-open means an UNCHECKED memo shipped, so make it visible in
    // the daily digest rather than silent.
    console.error("Verification pass errored (fail-open):", e);
    try {
      await logEvent("verify_failopen", {
        payload: { error: e instanceof Error ? e.message.slice(0, 300) : String(e) },
      });
    } catch {
      /* never let telemetry break the pipeline */
    }
    return { passed: true, critical_issues: [], minor_issues: [] };
  }
}
