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

const VERIFY_SYSTEM = `You are a fact-checker for an investment memo before it is emailed to a subscriber. Your scope is NUMBERS AGAINST THE DATASET — nothing else.

- A figure attributed to the dataset (prices, market cap, multiples, margins, growth rates, EPS, balance-sheet items, insider transactions) must match the dataset within reasonable rounding (~1-2%).
- Derived arithmetic (e.g. "up 14% year over year" computed from two dataset numbers) should be checked by recomputing it.
- OUT OF SCOPE — never flag: claims about news and events (deals, announcements, bids, deadlines, corporate actions, people). The author had live web-search results that you CANNOT see; <web_sources> lists what they consulted. Absence from the dataset is NOT evidence a news claim is wrong. Only flag an event claim if it DIRECTLY CONTRADICTS the dataset.
- OUT OF SCOPE: figures attributed to a cited web source (a domain in parentheses).
- ATTRIBUTION CHECK (the one exception to numbers-only): specific EVENT claims — deal terms, consideration structures, deadlines, named dates, scheme conditions — must carry attribution: an inline markdown link, a source domain in parentheses, or a clear match to a <web_sources> title. Paragraph-level attribution covers that paragraph's claims. Flag as CRITICAL an event claim with specific numbers/dates/terms that has NO attribution anywhere near it AND no basis in the dataset — not because it is false (you cannot know), but because unattributed event specifics are the memo's highest hallucination risk. General market color needs no attribution.
- Flag as CRITICAL: dataset-attributed figures that contradict the dataset, invented figures presented as dataset facts, magnitude errors, wrong currency/units.
- Flag as MINOR: rounding beyond ~2%, vague attribution.
Do not comment on investment logic, style, or opinions — numbers against the dataset, plus the attribution check above.`;

/** Audit a memo's figures against the grounding dataset. Fail-open on errors. */
export async function verifyMemo(
  markdown: string,
  data: TickerData,
  webSources: { url: string; title: string }[] = [],
): Promise<VerificationResult> {
  try {
    const stream = anthropic().messages.stream({
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
          content:
            `<fmp_dataset>\n${JSON.stringify(data)}\n</fmp_dataset>\n\n` +
            (webSources.length > 0
              ? `<web_sources note="search results the author consulted — you cannot see their contents">\n${webSources.map((s) => `- ${s.title} (${s.url})`).join("\n")}\n</web_sources>\n\n`
              : "") +
            `<memo>\n${markdown}\n</memo>`,
        },
      ],
    });
    const response = await stream.finalMessage();
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
