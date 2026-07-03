import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic";
import { config } from "./config";
import type { Profile } from "./profile";
import type { TickerData } from "./fmp";
import {
  MEMO_SYSTEM_PROMPT,
  buildMemoUserPrompt,
  type FollowupContext,
  type SecondLookContext,
  type ReviewContext,
} from "./prompts/memo";
import { verifyMemo, type VerificationResult } from "./verify";
import { editMemo } from "./editor";

const MAX_CONTINUATIONS = 5;

function safeDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export interface MemoSource {
  url: string;
  title: string;
}

export interface GeneratedMemo {
  markdown: string;
  title: string;
  model: string;
  sources: MemoSource[];
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
  coverage?: unknown[];
  followup?: FollowupContext;
  secondLook?: SecondLookContext;
  review?: ReviewContext;
  referenceLinks?: { label: string; url: string }[];
}): Promise<GeneratedMemo> {
  const cfg = config();
  const userPrompt = buildMemoUserPrompt({
    profile: args.profile,
    ticker: args.ticker,
    companyName: args.companyName,
    data: args.data,
    today: new Date().toISOString().slice(0, 10),
    selectionRationale: args.selectionRationale,
    coverage: args.coverage,
    followup: args.followup,
    secondLook: args.secondLook,
    review: args.review,
    referenceLinks: args.referenceLinks,
  });

  const baseRequest = {
    model: cfg.MEMO_MODEL,
    // Generous: adaptive thinking (on by default for claude-sonnet-5) counts
    // against max_tokens, and a hard-thinking run truncated at both 8k and
    // 16k in production. Memo text is ~2k tokens; the rest is thinking room.
    max_tokens: 24000,
    output_config: { effort: "high" as const },
    system: [
      {
        type: "text" as const,
        text: MEMO_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" as const },
      },
    ],
    tools: [
      { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 4 },
      {
        type: "web_fetch_20260209" as const,
        name: "web_fetch" as const,
        max_uses: 4,
        // Approximate cap on fetched page text entering the context — cost guard.
        max_content_tokens: 30000,
      },
    ],
  };

  // 24k max_tokens trips the SDK's "streaming required over 10 minutes"
  // estimate — an explicit timeout opts out (real calls finish in 2-4 min).
  const requestOptions = { timeout: 10 * 60 * 1000 };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
  let response = await anthropic().messages.create({ ...baseRequest, messages }, requestOptions);

  // Accumulate web-search results and fetched pages across the whole turn
  // (including paused continuations) — they're the URL/title lookup for the
  // sources footer and the whitelist for inline links.
  const searchResults = new Map<string, MemoSource>();
  const collectSearchResults = (content: Anthropic.ContentBlock[]) => {
    for (const block of content) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const result of block.content) {
          if (result.type === "web_search_result" && result.url) {
            if (!searchResults.has(result.url)) {
              searchResults.set(result.url, { url: result.url, title: result.title ?? result.url });
            }
          }
        }
      } else if (block.type === "web_fetch_tool_result") {
        const fetched = block.content;
        if (fetched && fetched.type === "web_fetch_result" && fetched.url) {
          if (!searchResults.has(fetched.url)) {
            const doc = fetched.content;
            const title = (doc && "title" in doc && doc.title) || safeDomain(fetched.url) || fetched.url;
            searchResults.set(fetched.url, { url: fetched.url, title: String(title) });
          }
        }
      }
    }
  };
  collectSearchResults(response.content);

  // Server-side web search can pause the turn; resume until end_turn.
  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < MAX_CONTINUATIONS) {
    messages.push({ role: "assistant", content: response.content });
    response = await anthropic().messages.create({ ...baseRequest, messages }, requestOptions);
    collectSearchResults(response.content);
    continuations++;
  }

  if (response.stop_reason === "refusal") {
    throw new Error(`Memo generation refused for ${args.ticker}.`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(`Memo generation for ${args.ticker} hit max_tokens — output truncated.`);
  }

  // Cited text arrives as separate text blocks mid-paragraph — join with no
  // separator to preserve sentence flow, turn citation metadata into inline
  // (domain.com) attributions, and collect full source URLs for the footer.
  const sourceByUrl = new Map<string, MemoSource>();
  const markdown = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => {
      const domains = new Set<string>();
      for (const c of b.citations ?? []) {
        if ("url" in c && c.url) {
          const domain = safeDomain(c.url);
          if (domain) domains.add(domain);
          if (!sourceByUrl.has(c.url)) {
            sourceByUrl.set(c.url, {
              url: c.url,
              title: ("title" in c && c.title ? String(c.title) : domain) ?? c.url,
            });
          }
        }
      }
      const text = b.text.trim() === "" ? "" : b.text;
      return domains.size > 0 ? `${text} (${[...domains].join(", ")})` : text;
    })
    .join("")
    .trim();

  // Drop any working narration the model emitted before the memo itself —
  // the deliverable always starts at the H1. Also strip literal <cite> tags
  // the web-search tool sometimes embeds (they'd render as raw HTML in email).
  const h1Index = markdown.indexOf("# ");
  let cleaned = (h1Index > 0 ? markdown.slice(h1Index) : markdown)
    .replace(/<cite[^>]*>([\s\S]*?)<\/cite>/g, "$1")
    .replace(/<\/?antml?[^>]*>/g, "");

  if (!cleaned) {
    throw new Error(`Memo generation for ${args.ticker} returned no text.`);
  }

  // Editorial desk: critique the writing, revise once if it materially helps.
  // Facts/links are contractually untouched; the verify pass still runs on
  // whatever comes out.
  const editorial = await editMemo(cleaned);
  if (editorial.revised) {
    console.log(`Editorial revision applied for ${args.ticker}: ${editorial.issues.join(" | ")}`);
  }
  cleaned = editorial.markdown;

  // Inline-link validation: any URL not in the author's verified source set
  // (its own search results + curated reference links) is stripped back to
  // plain text — hallucinated links are structurally impossible. Runs AFTER
  // the editorial pass so a revision can't smuggle a new URL through.
  const allowedUrls = new Set<string>(searchResults.keys());
  for (const l of args.referenceLinks ?? []) allowedUrls.add(l.url);
  cleaned = cleaned.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, text: string, url: string) =>
    allowedUrls.has(url) ? match : text,
  );

  const heading = cleaned.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = heading ?? `${args.ticker} — today's idea`;

  // Sources = citation metadata, plus any search result whose domain the memo
  // references inline (the model often paraphrases with "(domain.com)" and no
  // citation block).
  const mentionedDomains = new Set(
    [...cleaned.matchAll(/\(([a-z0-9.-]+\.[a-z]{2,}(?:\.[a-z]{2})?(?:,\s*[a-z0-9.-]+\.[a-z]{2,}(?:\.[a-z]{2})?)*)\)/g)]
      .flatMap((m) => m[1].split(",").map((d) => d.trim().replace(/^www\./, ""))),
  );
  for (const source of searchResults.values()) {
    const domain = safeDomain(source.url);
    if (domain && mentionedDomains.has(domain) && !sourceByUrl.has(source.url)) {
      sourceByUrl.set(source.url, source);
    }
  }

  return {
    markdown: cleaned,
    title,
    model: cfg.MEMO_MODEL,
    sources: [...sourceByUrl.values()].slice(0, 10),
  };
}

export interface MemoMeta {
  one_liner: string;
  call_status?: "stands" | "watching" | "closed" | "n/a";
  close_reason?: string;
  conviction: number; // 1–10
  horizon: string; // e.g. "6–18 months"
  style_tags: string[]; // ≤3 short tags, e.g. ["Merger arb", "Net cash"]
}

const META_SCHEMA = {
  type: "object",
  properties: {
    one_liner: {
      type: "string",
      description: "The whole idea in one punchy sentence, max 140 characters, no ticker prefix",
    },
    call_status: {
      type: "string",
      enum: ["stands", "watching", "closed", "n/a"],
      description:
        "FOLLOW-UP notes only (Scorecard section present): does the original call stand, need watching, or is it closed (played out or broken)? 'n/a' for any other note type.",
    },
    close_reason: {
      type: "string",
      description: "One line, only when call_status is closed",
    },
    conviction: {
      type: "integer",
      description:
        "1-10: how strong this setup is on the evidence in the memo (risk-adjusted, honest — most ideas are 5-7)",
    },
    horizon: { type: "string", description: 'Expected timeframe, e.g. "6-18 months"' },
    style_tags: {
      type: "array",
      items: { type: "string" },
      description: "Up to 3 two-word style tags, e.g. 'Deep value', 'Merger arb', 'Quality compounder'",
    },
  },
  required: ["one_liner", "conviction", "horizon", "style_tags", "call_status"],
  additionalProperties: false,
} as const;

/** Distill the verdict block (one-liner, conviction, horizon, tags) from a finished memo. */
export async function extractMemoMeta(markdown: string): Promise<MemoMeta | null> {
  try {
    const response = await anthropic().messages.create({
      model: config().FEEDBACK_MODEL,
      max_tokens: 4000,
      thinking: { type: "disabled" },
      output_config: {
        format: { type: "json_schema", schema: META_SCHEMA },
        effort: "low",
      },
      system:
        "You distill a finished investment memo into its verdict block. Be honest — conviction " +
        "reflects the memo's own risk discussion, not salesmanship. Calibrate the 1-10 scale: " +
        "8-10 table-pounding asymmetry, 6-7 a solid pick with real caveats, 5 and below a " +
        "cautionary or watchlist note. Score the risk/reward the memo actually argues, at " +
        "today's price. The one-liner should make a busy reader stop scrolling.",
      messages: [{ role: "user", content: `<memo>\n${markdown}\n</memo>` }],
    });
    if (response.stop_reason === "refusal") return null;
    const text = response.content.find((b) => b.type === "text");
    const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as MemoMeta;
    return {
      one_liner: (parsed.one_liner ?? "").replace(/<[^>]*>/g, "").slice(0, 160),
      call_status: parsed.call_status ?? "n/a",
      close_reason: (parsed.close_reason ?? "").slice(0, 200),
      conviction: Math.min(10, Math.max(1, Math.round(parsed.conviction ?? 5))),
      horizon: (parsed.horizon ?? "").slice(0, 30),
      style_tags: (parsed.style_tags ?? []).slice(0, 3).map((t) => String(t).slice(0, 24)),
    };
  } catch (e) {
    console.error("Memo meta extraction failed (non-fatal):", e);
    return null;
  }
}

/**
 * Generate a memo and fact-check its figures against the dataset. One
 * critical-issue regeneration attempt (with the auditor's findings fed back);
 * a second failure throws so the delivery retries/alerts rather than sending
 * fabricated numbers.
 */
export async function generateVerifiedMemo(args: {
  profile: Profile;
  ticker: string;
  companyName?: string;
  data: TickerData;
  selectionRationale: string;
  coverage?: unknown[];
  followup?: FollowupContext;
  secondLook?: SecondLookContext;
  review?: ReviewContext;
  referenceLinks?: { label: string; url: string }[];
}): Promise<GeneratedMemo & { verification: VerificationResult; meta: MemoMeta | null }> {
  let memo = await generateMemo(args);
  let verification = await verifyMemo(memo.markdown, args.data, memo.sources);
  if (!verification.passed) {
    console.warn(
      `Verification found ${verification.critical_issues.length} critical issue(s) for ${args.ticker}; regenerating once.`,
      verification.critical_issues,
    );
    memo = await generateMemo({
      ...args,
      selectionRationale:
        `${args.selectionRationale}\n\nIMPORTANT — a previous draft of this memo contained factual errors ` +
        `that you must not repeat:\n${verification.critical_issues
          .map((i) => `- "${i.claim}": ${i.problem}`)
          .join("\n")}`,
    });
    verification = await verifyMemo(memo.markdown, args.data, memo.sources);
    if (!verification.passed) {
      throw new Error(
        `Memo for ${args.ticker} failed fact-verification twice: ${verification.critical_issues
          .map((i) => i.problem)
          .join("; ")
          .slice(0, 500)}`,
      );
    }
  }
  const meta = await extractMemoMeta(memo.markdown);
  return { ...memo, verification, meta };
}
