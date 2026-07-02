import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic";
import { config } from "./config";
import type { Profile } from "./candidates";
import type { TickerData } from "./fmp";
import { MEMO_SYSTEM_PROMPT, buildMemoUserPrompt } from "./prompts/memo";

const MAX_CONTINUATIONS = 5;

function safeDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export interface GeneratedMemo {
  markdown: string;
  title: string;
  model: string;
}

/**
 * Generate a memo for one subscriber. Pure with respect to the DB — takes the
 * profile and grounding data, returns markdown. Web search (max 3 uses) covers
 * recent news; all figures must come from the provided FMP JSON.
 */
export async function generateMemo(args: {
  profile: Profile;
  ticker: string;
  companyName?: string;
  data: TickerData;
  selectionRationale: string;
}): Promise<GeneratedMemo> {
  const cfg = config();
  const userPrompt = buildMemoUserPrompt({
    profile: args.profile,
    ticker: args.ticker,
    companyName: args.companyName,
    data: args.data,
    today: new Date().toISOString().slice(0, 10),
    selectionRationale: args.selectionRationale,
  });

  const baseRequest = {
    model: cfg.MEMO_MODEL,
    // Generous: adaptive thinking (on by default for claude-sonnet-5) counts
    // against max_tokens, and a hard-thinking run can exceed 8k total.
    max_tokens: 16000,
    system: [
      {
        type: "text" as const,
        text: MEMO_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" as const },
      },
    ],
    tools: [
      { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 3 },
    ],
  };

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
  let response = await anthropic().messages.create({ ...baseRequest, messages });

  // Server-side web search can pause the turn; resume until end_turn.
  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < MAX_CONTINUATIONS) {
    messages.push({ role: "assistant", content: response.content });
    response = await anthropic().messages.create({ ...baseRequest, messages });
    continuations++;
  }

  if (response.stop_reason === "refusal") {
    throw new Error(`Memo generation refused for ${args.ticker}.`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`Memo generation for ${args.ticker} hit max_tokens — output truncated.`);
  }

  // Cited text arrives as separate text blocks mid-paragraph — join with no
  // separator to preserve sentence flow, and turn citation metadata into
  // inline (domain.com) attributions.
  const markdown = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => {
      const domains = [
        ...new Set(
          (b.citations ?? [])
            .map((c) => ("url" in c && c.url ? safeDomain(c.url) : null))
            .filter((d): d is string => Boolean(d)),
        ),
      ];
      const text = b.text.trim() === "" ? "" : b.text;
      return domains.length > 0 ? `${text} (${domains.join(", ")})` : text;
    })
    .join("")
    .trim();

  // Drop any working narration the model emitted before the memo itself —
  // the deliverable always starts at the H1.
  const h1Index = markdown.indexOf("# ");
  const cleaned = h1Index > 0 ? markdown.slice(h1Index) : markdown;
  if (!cleaned) {
    throw new Error(`Memo generation for ${args.ticker} returned no text.`);
  }

  const heading = cleaned.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = heading ?? `${args.ticker} — today's idea`;

  return { markdown: cleaned, title, model: cfg.MEMO_MODEL };
}
