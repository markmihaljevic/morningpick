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
import { buildComputedFigures, buildSnapshot } from "./figures";
import { snapshotReconcileInputs, reconciliationIssues, narrationIssues } from "./reconcile";
import { editMemo } from "./editor";
import type { ResearchBrief } from "./research";
import { holdcoPromptBlock, holdcoAdjectiveIssues, holdcoDiscountSignal, type HoldcoContext } from "./holdco";

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

/**
 * The report's Sources section = the day's research-brief sources (the actual
 * fact base — the writer runs WITHOUT web tools when a brief exists, so its
 * own citation set is nearly empty) merged with any writer citations. Dedup
 * by URL; a bare page title like "Home" falls back to the domain so the list
 * reads as sources, not tabs. (July 17: CGEO's report shipped one source
 * titled "Home" — the brief's sources never reached the PDF.)
 */
export function mergeMemoSources(
  briefSources: MemoSource[] | undefined,
  memoSources: MemoSource[],
  cap = 12,
): MemoSource[] {
  const byUrl = new Map<string, MemoSource>();
  for (const s of [...(briefSources ?? []), ...memoSources]) {
    if (!s?.url || byUrl.has(s.url)) continue;
    const domain = safeDomain(s.url);
    const title =
      s.title && s.title.trim().length > 4 && !/^(home|index|welcome)$/i.test(s.title.trim())
        ? s.title.trim()
        : (domain ?? s.url);
    byUrl.set(s.url, { url: s.url, title });
  }
  return [...byUrl.values()].slice(0, cap);
}

export interface GeneratedMemo {
  markdown: string;
  title: string;
  model: string;
  sources: MemoSource[];
  editorial: { revised: boolean; issueCount: number };
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
  recentProfileChange?: string;
  /** Shared fact base: when present the writer runs TOOLLESS — fast and cheap. */
  researchBrief?: ResearchBrief;
  portfolio?: { ticker: string; name: string | null; note: string | null }[];
  referenceLinks?: { label: string; url: string }[];
  /** Sector-aware comp table block — quoted verbatim, clean anchors only. */
  peerComps?: string;
  /** Investment-holdco NAV frame (lib/holdco.ts) — overrides multiple framing. */
  holdco?: HoldcoContext | null;
  /** The desk's ONE conviction (assessor) — the writer restates it verbatim. */
  conviction?: number | null;
  /** Final-attempt degradation: fewer tool rounds, no editorial — ship good over perfect. */
  light?: boolean;
}): Promise<GeneratedMemo> {
  const cfg = config();
  const snapshot = args.review ? null : await buildSnapshot(args.data);
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
    recentProfileChange: args.recentProfileChange,
    researchBrief: args.researchBrief,
    portfolio: args.portfolio,
    referenceLinks: args.referenceLinks,
    computedFigures: args.review ? undefined : await buildComputedFigures(args.data),
    peerComps: args.review ? undefined : args.peerComps,
    holdcoBlock: args.holdco && !args.review ? holdcoPromptBlock(args.holdco) : undefined,
    financialGroup: snapshot?.financialGroup,
    conviction: args.conviction,
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
    // With a research brief the writer is TOOLLESS — the desk already did
    // the digging once, for everyone. Without one (fallback), tools as before.
    tools: args.researchBrief
      ? []
      : [
          {
            type: "web_search_20260209" as const,
            name: "web_search" as const,
            max_uses: args.light ? 2 : 4,
          },
          {
            type: "web_fetch_20260209" as const,
            name: "web_fetch" as const,
            max_uses: args.light ? 2 : 4,
            max_content_tokens: args.light ? 15000 : 30000,
          },
        ],
  };

  // STREAMING, not polling a silent socket: long research turns hang
  // non-streaming requests (and SDK retries multiply every timeout). A
  // stream delivers events continuously — a stall is visible immediately
  // instead of after a timeout window. One retry for connection blips.
  const createWithRetry = async (
    req: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> => {
    const once = async () => {
      const stream = anthropic().messages.stream(req);
      return await stream.finalMessage();
    };
    try {
      return await once();
    } catch (e) {
      if (e instanceof Anthropic.APIConnectionError) {
        console.warn(`Anthropic connection error for ${args.ticker}; retrying once:`, e.message);
        return await once();
      }
      throw e;
    }
  };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
  let response = await createWithRetry({ ...baseRequest, messages });

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
    response = await createWithRetry({ ...baseRequest, messages });
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
  const editorial = args.light
    ? { markdown: cleaned, revised: false, issues: [] }
    : await editMemo(cleaned);
  if (editorial.revised) {
    console.log(`Editorial revision applied for ${args.ticker}: ${editorial.issues.join(" | ")}`);
  }
  cleaned = editorial.markdown;
  const editorialOutcome = { revised: editorial.revised, issueCount: editorial.issues.length };

  // Inline-link validation: any URL not in the author's verified source set
  // (its own search results + curated reference links) is stripped back to
  // plain text — hallucinated links are structurally impossible. Runs AFTER
  // the editorial pass so a revision can't smuggle a new URL through.
  const allowedUrls = new Set<string>(searchResults.keys());
  for (const l of args.referenceLinks ?? []) allowedUrls.add(l.url);
  for (const s of args.researchBrief?.sources ?? []) {
    allowedUrls.add(s.url);
    if (!searchResults.has(s.url)) searchResults.set(s.url, s);
  }
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
    editorial: editorialOutcome,
  };
}

export interface MemoMeta {
  one_liner: string;
  call_status?: "stands" | "watching" | "closed" | "n/a";
  close_reason?: string;
  conviction: number; // 1–10
  horizon: string; // e.g. "6–18 months"
  style_tags: string[]; // ≤3 short tags, e.g. ["Merger arb", "Net cash"]
  scenarios?: { bear: string; base: string; bull: string }; // short lines pulled from the note
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
    scenarios: {
      type: "object",
      description:
        "The bear/base/bull outcomes as the memo argues them — each a SHORT line with the number and the one assumption (e.g. 'to ~7p (-60%) if guidance slips and the multiple compresses'). Empty strings if the memo gives no explicit scenarios.",
      properties: {
        bear: { type: "string" },
        base: { type: "string" },
        bull: { type: "string" },
      },
      required: ["bear", "base", "bull"],
      additionalProperties: false,
    },
  },
  required: ["one_liner", "conviction", "horizon", "style_tags", "call_status", "scenarios"],
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
      scenarios:
        parsed.scenarios && (parsed.scenarios.bear || parsed.scenarios.base || parsed.scenarios.bull)
          ? {
              bear: (parsed.scenarios.bear ?? "").slice(0, 160),
              base: (parsed.scenarios.base ?? "").slice(0, 160),
              bull: (parsed.scenarios.bull ?? "").slice(0, 160),
            }
          : undefined,
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
  recentProfileChange?: string;
  researchBrief?: ResearchBrief;
  portfolio?: { ticker: string; name: string | null; note: string | null }[];
  referenceLinks?: { label: string; url: string }[];
  peerComps?: string;
  holdco?: HoldcoContext | null;
  /** The desk's ONE conviction (assessor) — enforced everywhere it prints. */
  conviction?: number | null;
  light?: boolean;
}): Promise<GeneratedMemo & { verification: VerificationResult; meta: MemoMeta | null }> {
  const MAX_REGENS = args.light ? 1 : 2;
  // The same precomputed figures the writer quotes — ground truth for the check.
  const figures = args.review ? [] : await buildComputedFigures(args.data);
  const gateSnapshot = args.review ? null : await buildSnapshot(args.data);
  const verifyOpts = {
    review: Boolean(args.review),
    priorReviews: args.review?.priorReviews,
    holdcoBlock: args.holdco && !args.review ? holdcoPromptBlock(args.holdco) : undefined,
    financialGroup: gateSnapshot?.financialGroup ?? false,
  };
  // Deterministic code gates ride INSIDE the verify loop — a mismatch is a
  // critical issue the regen machinery repairs, exactly like a wrong figure:
  // - July 17: holdco discount adjectives trace to the computed class.
  // - July 18 rule 4: price ÷ per-share ≡ printed multiple; ONE conviction.
  // - July 18 rule 5: self-corrected contradictions are build failures.
  const discountSignal = args.review ? null : holdcoDiscountSignal(args.holdco);
  const reconInputs = gateSnapshot
    ? snapshotReconcileInputs(gateSnapshot, args.conviction ?? null, args.peerComps)
    : null;
  const wordGate = (markdown: string): { claim: string; problem: string }[] => {
    const out: { claim: string; problem: string }[] = [];
    if (discountSignal) {
      out.push(
        ...holdcoAdjectiveIssues(markdown, discountSignal.discountClass, discountSignal.discountPct).map((p) => ({
          claim: "valuation adjective",
          problem: p,
        })),
      );
    }
    if (reconInputs) {
      out.push(...reconciliationIssues(markdown, reconInputs).map((p) => ({ claim: "reconciliation", problem: p })));
      out.push(...narrationIssues(markdown).map((p) => ({ claim: "self-corrected contradiction", problem: p })));
    }
    return out;
  };
  const withWordGate = (v: VerificationResult, markdown: string): VerificationResult => {
    const word = wordGate(markdown);
    return word.length === 0 ? v : { ...v, passed: false, critical_issues: [...v.critical_issues, ...word] };
  };
  let memo = await generateMemo(args);
  // The attribution check should recognize brief-sourced claims as sourced.
  const verifySources = args.researchBrief ? args.researchBrief.sources : memo.sources;
  let verification = withWordGate(
    await verifyMemo(memo.markdown, args.data, verifySources, figures, args.peerComps, verifyOpts),
    memo.markdown,
  );
  const priorIssues: { claim: string; problem: string }[] = [];
  for (let regen = 0; !verification.passed && regen < MAX_REGENS; regen++) {
    priorIssues.push(...verification.critical_issues);
    console.warn(
      `Verification found ${verification.critical_issues.length} critical issue(s) for ${args.ticker}; regenerating (${regen + 1}/${MAX_REGENS}).`,
      verification.critical_issues,
    );
    memo = await generateMemo({
      ...args,
      selectionRationale:
        `${args.selectionRationale}\n\nIMPORTANT — previous drafts contained factual errors you must not repeat. ` +
        `For each: fix it with a correct dataset figure, attribute it to a real source you actually consulted (inline link or domain), ` +
        `or REMOVE the claim entirely — an unattributed specific must never survive:\n${priorIssues
          .map((i) => `- "${i.claim}": ${i.problem}`)
          .join("\n")}`,
    });
    verification = withWordGate(
      await verifyMemo(memo.markdown, args.data, verifySources, figures, args.peerComps, verifyOpts),
      memo.markdown,
    );
  }
  if (!verification.passed) {
    throw new Error(
      `Memo for ${args.ticker} failed fact-verification ${MAX_REGENS + 1} times: ${verification.critical_issues
        .map((i) => i.problem)
        .join("; ")
        .slice(0, 500)}`,
    );
  }
  let meta = await extractMemoMeta(memo.markdown);
  // ONE conviction (July 18 rule 4): the assessor's number is the desk's —
  // the meta extractor must not invent its own (the RNR email said 4/10
  // while the PDF said 5/10). Body prose is gated in the loop above; the
  // meta field is ours to set.
  if (meta && typeof args.conviction === "number") {
    if (meta.conviction !== args.conviction) {
      console.warn(
        `Meta conviction ${meta.conviction}/10 != desk's ${args.conviction}/10 for ${args.ticker} — overriding to the desk number.`,
      );
    }
    meta = { ...meta, conviction: args.conviction };
  }
  // Rule 5 (July 17): the meta rides to the reader (tear-sheet thesis line,
  // scenario box, cover fallback) — it passes the same word gate as the body,
  // on WHICHEVER discount basis is live (look-through or published).
  if (meta && discountSignal) {
    const metaText = [meta.one_liner, meta.scenarios?.bear, meta.scenarios?.base, meta.scenarios?.bull]
      .filter(Boolean)
      .join("\n");
    const metaIssues = holdcoAdjectiveIssues(metaText, discountSignal.discountClass, discountSignal.discountPct);
    if (metaIssues.length > 0) {
      console.warn(`Meta word-gate issues for ${args.ticker} — re-extracting once:`, metaIssues);
      meta = await extractMemoMeta(
        `${memo.markdown}\n\n<!-- REPAIR: your previous extraction broke the discount register: ${metaIssues.join("; ")} — the computed class is "${discountSignal.discountClass}". -->`,
      );
      if (meta) {
        const still = holdcoAdjectiveIssues(
          [meta.one_liner, meta.scenarios?.bear, meta.scenarios?.base, meta.scenarios?.bull].filter(Boolean).join("\n"),
          discountSignal.discountClass,
          discountSignal.discountPct,
        );
        if (still.length > 0) meta = null; // correct-or-nothing: no meta beats a wrong adjective
      }
    }
  }
  return { ...memo, verification, meta };
}
