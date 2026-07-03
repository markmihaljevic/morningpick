import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic";
import { config } from "./config";

export interface PrimarySource {
  url: string;
  title: string;
  type: "interview" | "earnings_call" | "deep_dive" | "analysis";
  note: string; // why it's worth the reader's time, one line
}

const DISCOVERY_SCHEMA = {
  type: "object",
  properties: {
    sources: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string", description: "EXACT url copied from a search result" },
          title: { type: "string" },
          type: { type: "string", enum: ["interview", "earnings_call", "deep_dive", "analysis"] },
          note: {
            type: "string",
            description: "Why this is worth the reader's time, max 90 chars, specific not generic",
          },
        },
        required: ["url", "title", "type", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["sources"],
  additionalProperties: false,
} as const;

/**
 * Hunt for genuinely useful primary material on the company: a recent
 * management interview, earnings-call coverage or transcript, a quality
 * long-form deep dive. Returns 0–3 items; returning nothing is the correct
 * answer for most small caps. Every URL is validated against the actual
 * search results, so links cannot be hallucinated.
 */
export async function discoverPrimarySources(
  ticker: string,
  companyName: string,
): Promise<PrimarySource[]> {
  try {
    const baseRequest = {
      model: config().FEEDBACK_MODEL,
      max_tokens: 6000,
      output_config: {
        format: { type: "json_schema" as const, schema: DISCOVERY_SCHEMA },
        effort: "low" as const,
      },
      tools: [
        { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 3 },
      ],
      system:
        "You find primary-source material an investor should consume before acting on a stock " +
        "idea: recent (≤12 months) management/CEO interviews (YouTube, podcasts), earnings-call " +
        "transcripts or coverage, and genuinely deep long-form analyses (Substack, fund letters, " +
        "serious blogs). QUALITY BAR IS HIGH: return at most 3 items, only things a professional " +
        "would actually open. Promotional fluff, listicles, generic news wires: exclude. If " +
        "nothing clears the bar, return an empty array — that is a good answer. Only use URLs " +
        "that appear in your search results, copied exactly.",
    };
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `Find primary sources for ${companyName} (ticker ${ticker}). Search for: management interview, earnings call, and one deep-dive analysis.`,
      },
    ];

    let response = await anthropic().messages.create({ ...baseRequest, messages });
    const seenUrls = new Set<string>();
    const collect = (content: Anthropic.ContentBlock[]) => {
      for (const block of content) {
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) {
            if (r.type === "web_search_result" && r.url) seenUrls.add(r.url);
          }
        }
      }
    };
    collect(response.content);
    let continuations = 0;
    while (response.stop_reason === "pause_turn" && continuations < 4) {
      messages.push({ role: "assistant", content: response.content });
      response = await anthropic().messages.create({ ...baseRequest, messages });
      collect(response.content);
      continuations++;
    }
    if (response.stop_reason === "refusal") return [];

    const text = response.content.filter((b) => b.type === "text").at(-1);
    const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as {
      sources: PrimarySource[];
    };

    // Hard guarantee: only URLs that actually appeared in search results.
    return (parsed.sources ?? [])
      .filter((s) => s.url && seenUrls.has(s.url))
      .slice(0, 3)
      .map((s) => ({
        url: s.url,
        title: String(s.title ?? "").slice(0, 90),
        type: (["interview", "earnings_call", "deep_dive", "analysis"] as const).includes(s.type)
          ? s.type
          : "analysis",
        note: String(s.note ?? "").replace(/<[^>]*>/g, "").slice(0, 110),
      }));
  } catch (e) {
    console.error(`Primary source discovery failed for ${ticker} (non-fatal):`, e);
    return [];
  }
}
