import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic";
import { config } from "./config";
import { db } from "./db";
import type { TickerData } from "./fmp";
import { sanitizeDatasetForPrompt } from "./figures";

/**
 * The shared research layer: one sourced, verified fact base per ticker per
 * day, built by the expensive tool-using pipeline exactly ONCE — every
 * subscriber's personalized note is then a fast, toolless writing pass over
 * this brief. Research once, write per subscriber: this is what makes a
 * thousand daily notes affordable without lowering the evidence bar.
 */

export interface ResearchBrief {
  markdown: string;
  sources: { url: string; title: string }[];
}

const BRIEF_SYSTEM = `You are the research desk at Morningpick preparing the morning FACT BASE on one stock. Writing analysts will compose subscriber-facing notes exclusively from your brief plus the numeric dataset — anything you omit, they cannot use; anything you state, they will trust. Rigor over flourish.

Rules (non-negotiable):
- Every event claim (deals, announcements, guidance, corporate actions, dates, terms) MUST carry an inline markdown link to the exact source you consulted — [the announcement](url). Use EXACT urls from your search/fetch results. An unsourced event claim is worse than no claim.
- Use web_fetch to READ the primary documents that matter (announcements, RNS, filings) — precise terms beat headline summaries.
- Quote management ONLY verbatim from the provided transcript excerpt, attributed with where it was said.
- Numbers from the dataset don't need links; numbers from documents do.
- If something can't be established, write "could not verify" — the writers must know the boundary of the fact base.
- No investment opinion, no recommendation — facts, catalysts, tensions, and dates. The writers own the view.

Output ONLY the brief, markdown:
# Research brief: {TICKER} — {date}
## Live situation
What is happening with this company right now — the events of the last month, each sourced.
## From the documents
The load-bearing specifics you pulled from primary sources (terms, conditions, figures) — each sourced.
## Management's words
2-4 verbatim transcript quotes that matter, with context on what was asked.
## The bull's raw material
Facts (not arguments) a bull would build on — sourced where not from the dataset.
## The bear's raw material
Facts a bear would build on — same rules.
## The calendar
Dated upcoming events: earnings, deadlines, decisions — each sourced or marked as from the dataset.`;

/** Build a fresh brief (tool-using, streamed, expensive — call via getOrBuildBrief). */
export async function buildResearchBrief(
  ticker: string,
  companyName: string | undefined,
  data: TickerData,
): Promise<ResearchBrief> {
  const cfg = config();
  const baseRequest = {
    model: cfg.MEMO_MODEL,
    max_tokens: 16000,
    output_config: { effort: "high" as const },
    system: [
      { type: "text" as const, text: BRIEF_SYSTEM, cache_control: { type: "ephemeral" as const } },
    ],
    tools: [
      { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 4 },
      {
        type: "web_fetch_20260209" as const,
        name: "web_fetch" as const,
        max_uses: 4,
        max_content_tokens: 30000,
      },
    ],
  };
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Today's date: ${new Date().toISOString().slice(0, 10)}\n` +
        `Ticker: ${ticker}${companyName ? ` (${companyName})` : ""}\n\n` +
        `<dataset note="vendor-precomputed price ratios stripped — never cite a P/E, P/B, or yield from memory; the memo layer computes them fresh">\n${JSON.stringify(sanitizeDatasetForPrompt(data))}\n</dataset>\n\n` +
        `Prepare the research brief. Use at most 4 searches and 4 fetches on what matters most.`,
    },
  ];

  const sources = new Map<string, { url: string; title: string }>();
  const collect = (content: Anthropic.ContentBlock[]) => {
    for (const block of content) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r.type === "web_search_result" && r.url && !sources.has(r.url)) {
            sources.set(r.url, { url: r.url, title: r.title ?? r.url });
          }
        }
      } else if (block.type === "web_fetch_tool_result") {
        const f = block.content;
        if (f && f.type === "web_fetch_result" && f.url && !sources.has(f.url)) {
          const doc = f.content;
          const title = (doc && "title" in doc && doc.title) || f.url;
          sources.set(f.url, { url: f.url, title: String(title) });
        }
      }
    }
  };

  let response = await anthropic().messages.stream({ ...baseRequest, messages }).finalMessage();
  collect(response.content);
  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < 5) {
    messages.push({ role: "assistant", content: response.content });
    response = await anthropic().messages.stream({ ...baseRequest, messages }).finalMessage();
    collect(response.content);
    continuations++;
  }
  if (response.stop_reason === "refusal") throw new Error(`Brief refused for ${ticker}.`);

  const markdown = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!markdown.includes("# Research brief")) {
    throw new Error(`Brief for ${ticker} came back malformed.`);
  }

  // Strip links whose URL isn't in the actually-consulted set.
  const allowed = new Set(sources.keys());
  const cleaned = markdown.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) =>
    allowed.has(url) ? m : text,
  );
  return { markdown: cleaned, sources: [...sources.values()] };
}

const BRIEF_WAIT_MS = 8 * 60 * 1000;
const BRIEF_POLL_MS = 10 * 1000;

/**
 * Get today's brief for a ticker, building it if nobody has. Concurrent
 * workers coordinate through the (ticker, date) row: exactly one builds,
 * the rest wait for `ready`. Returns null on failure — callers fall back
 * to the legacy self-researched path.
 */
export async function getOrBuildBrief(
  ticker: string,
  companyName: string | undefined,
  data: TickerData,
  builtBy = "worker",
): Promise<ResearchBrief | null> {
  const briefDate = new Date().toISOString().slice(0, 10);
  try {
    const { data: claimed } = await db()
      .from("research_briefs")
      .insert({ ticker, brief_date: briefDate, status: "building", built_by: builtBy })
      .select("ticker")
      .maybeSingle();

    if (claimed) {
      // We hold the build lock.
      try {
        const brief = await buildResearchBrief(ticker, companyName, data);
        await db()
          .from("research_briefs")
          .update({
            status: "ready",
            brief_md: brief.markdown,
            sources: brief.sources,
            ready_at: new Date().toISOString(),
          })
          .eq("ticker", ticker)
          .eq("brief_date", briefDate);
        return brief;
      } catch (e) {
        await db()
          .from("research_briefs")
          .update({ status: "failed" })
          .eq("ticker", ticker)
          .eq("brief_date", briefDate);
        console.error(`Brief build failed for ${ticker} (falling back):`, e);
        return null;
      }
    }

    // Someone else is building (or it's done) — wait for ready.
    const deadline = Date.now() + BRIEF_WAIT_MS;
    while (Date.now() < deadline) {
      const { data: row } = await db()
        .from("research_briefs")
        .select("status, brief_md, sources")
        .eq("ticker", ticker)
        .eq("brief_date", briefDate)
        .maybeSingle();
      if (row?.status === "ready" && row.brief_md) {
        return {
          markdown: row.brief_md,
          sources: (row.sources ?? []) as { url: string; title: string }[],
        };
      }
      if (!row || row.status === "failed") return null;
      await new Promise((r) => setTimeout(r, BRIEF_POLL_MS));
    }
    console.warn(`Brief wait timed out for ${ticker}; falling back to self-research.`);
    return null;
  } catch (e) {
    console.error(`Brief coordination failed for ${ticker} (falling back):`, e);
    return null;
  }
}
