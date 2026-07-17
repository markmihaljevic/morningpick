import { anthropic } from "./anthropic";
import { config } from "./config";
import type { TickerData } from "./fmp";
import type { ComputedFigure } from "./figures";
import type { KeyStat } from "./stats";
import { verifyMemo } from "./verify";
import { holdcoPromptBlock, holdcoAdjectiveIssues, holdcoDiscountSignal } from "./holdco";

/**
 * Page one of the idea PDF: a one-page memo in the register of a Howard
 * Marks note (John's spec, mockup 2026-07-07). Five titled serif sections,
 * 300-450 words, distilled from the ALREADY-VERIFIED full note plus the
 * one snapshot — then fact-checked again on its own, because this page
 * carries more numbers than the cover note and John reads them all.
 */

export interface PageOneMemo {
  /** The Re: line's one-line handle, e.g. "gold producer, TSX Venture". */
  handle: string;
  trade: string;
  business: string;
  valuation: string;
  variant: string;
  risks: string;
}

const PAGE_ONE_SCHEMA = {
  type: "object",
  properties: {
    handle: {
      type: "string",
      description:
        'Short handle for the Re: line, lowercase, 3-6 words: what it is and where it trades, e.g. "gold producer, TSX Venture" or "UK retail bank, LSE". No ticker (shown separately).',
    },
    trade: {
      type: "string",
      description: "2-3 sentences: what you buy, the absolute price you pay, why today.",
    },
    business: {
      type: "string",
      description:
        "3-4 sentences: what it does, where the money is made, run-rate economics from filings.",
    },
    valuation: {
      type: "string",
      description:
        "Absolute first: lead with P/TBV and what tangible book consists of, then earnings and free cash flow against the true EV. Name the figures and the statement date. NO peer relatives.",
    },
    variant: {
      type: "string",
      description: "What the market believes, and the specific reason it is wrong.",
    },
    risks: {
      type: "string",
      description:
        'Named risks with numbers, exactly ONE sentence starting "I am wrong if", then the dated catalyst.',
    },
  },
  required: ["handle", "trade", "business", "valuation", "variant", "risks"],
  additionalProperties: false,
} as const;

const PAGE_ONE_SYSTEM = `You distil a finished, fact-checked research note into PAGE ONE of the PDF: a one-page memo in the register of a Howard Marks note — measured, first person, absolute-valuation-first, no salesmanship. The page already carries a header, an italic thesis line, and a stat strip; you write the five prose sections.

HARD RULES:
- 300-450 words TOTAL across the five sections. Short beats complete.
- Plain prose, no markdown, no bullets, no links. Each section is flowing sentences.
- Absolute valuation first: the valuation section LEADS with P/TBV and what tangible book actually consists of, then earnings and free cash flow against the TRUE enterprise value, naming the balance-sheet statement date. NO peer names or peer multiples anywhere on this page — relatives live in the attached report.
- Rounded figures in prose: one decimal on multiples, whole millions ("about US$98M", "2.7x earnings"), never false precision. The strip carries the precision.
- Every number must come from the <stat_strip>, the <computed_figures>, or a figure already present in the full note (which is fact-checked). Where a figure is not available, write "n/a" — never estimate.
- The risks section contains EXACTLY ONE sentence starting "I am wrong if", and ends with the dated catalyst written as a month name, "Q3 2026", "H1 2026", "FY2026", or "6 August" — a checker literally scans for one of those forms, so "next quarter" or "this autumn" will bounce the page. If the full note itself names no dated event, use the next scheduled results date from the note or strip.
- The one-line handle: what it is and where it trades, e.g. "gold producer, TSX Venture".`;

/**
 * Structural gate (rule 3 is not a suggestion): word budget, exactly one
 * "I am wrong if", a dated catalyst, and NO peer names on the page. Returns
 * the violations as repair notes; empty = compliant.
 */
// Accepted dated-catalyst forms — mirrored VERBATIM in PAGE_ONE_SYSTEM and
// the repair note; a gate the writer has never been shown the shape of just
// burns attempts (observed: three 'dated catalyst' bounces on one build).
// Covers month names, Q3 2026 / 3Q26, H1 2026 / 1H26, FY2026 / FY26,
// '6 Aug', and ISO-ish 2026-08-06.
const DATED_CATALYST =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b|\bQ[1-4]\s?(20)?\d\d\b|\b[1-4]Q\s?(20)?\d\d\b|\bH[12]\s?(20)?\d\d\b|\b[12]H\s?(20)?\d\d\b|\bFY\s?(20)?\d\d\b|\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|\b20\d\d-\d\d-\d\d\b|\b(first|second|third|fourth)\s+quarter\b|\b(first|second)\s+half\b/i;

// Generic institution-y prefixes that misidentify prose as a peer mention —
// 'Bank of Ireland Group' must not flag 'Bank of England'.
const GENERIC_NAME_PREFIXES = /^(bank of|the bank|group|holdings?|first|national|general|standard|american|british)$/i;

export function pageOneStructuralIssues(
  memo: PageOneMemo,
  peers: { symbol: string; name: string }[],
  /** The source note — when IT carries no dated catalyst, the page can't
   * honestly invent one; the check is waived rather than deadlocked. */
  fullNoteMarkdown?: string,
): string[] {
  const issues: string[] = [];
  const sections = [memo.trade, memo.business, memo.valuation, memo.variant, memo.risks];
  const words = sections.join(" ").split(/\s+/).filter(Boolean).length;
  if (words > 500) issues.push(`Total length is ${words} words — the page allows 300-450. Cut, don't compress.`);
  if (words < 220) issues.push(`Total length is ${words} words — too thin; the page wants 300-450.`);

  const wrongIf = (memo.risks.match(/I am wrong if/g) ?? []).length;
  if (wrongIf !== 1) {
    issues.push(`The risks section must contain EXACTLY ONE sentence starting "I am wrong if" (found ${wrongIf}).`);
  }
  if (!DATED_CATALYST.test(memo.risks)) {
    // Only demand what the fact-checked source can support: a note with no
    // dated event anywhere would force the writer to invent one — waived.
    if (!fullNoteMarkdown || DATED_CATALYST.test(fullNoteMarkdown)) {
      issues.push(
        'The risks section must end with a DATED catalyst written as a month name, "Q3 2026", "H1 2026", "FY2026", or "6 August" — take the date from the full note.',
      );
    }
  }

  // No peer relatives on this page — peer names/tickers must not appear.
  // Word-boundary matching: a bare substring scan flagged 'SAN' inside
  // 'thousand' and 'Bank of Ireland' against 'Bank of England', handing the
  // writer phantom violations it could never fix.
  const text = sections.join(" ");
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const p of peers) {
    const bareSymbol = p.symbol.split(".")[0];
    const symbolRx = new RegExp(`\\b${esc(bareSymbol)}\\b`, "i");
    // Symbols of 1-2 chars collide with ordinary words/initials — names only.
    const symbolHit = bareSymbol.length >= 3 && symbolRx.test(text);
    const nameWords = p.name.split(/\s+/);
    const nameToken = nameWords.slice(0, 2).join(" ");
    const nameHit =
      nameToken.length > 5 &&
      !GENERIC_NAME_PREFIXES.test(nameToken) &&
      new RegExp(`\\b${esc(nameToken)}\\b`, "i").test(text);
    // Distinctive single first word (e.g. 'Eurazeo') — catch it too.
    const firstWord = nameWords[0] ?? "";
    const firstWordHit =
      firstWord.length >= 6 &&
      !GENERIC_NAME_PREFIXES.test(firstWord) &&
      new RegExp(`\\b${esc(firstWord)}\\b`, "i").test(text);
    if (symbolHit || nameHit || firstWordHit) {
      issues.push(
        `Peer "${p.name}" (${p.symbol}) appears on the page — NO peer relatives on page one; the comp table lives in the attached report.`,
      );
    }
  }
  return issues;
}

export async function writePageOneMemo(args: {
  fullNoteMarkdown: string;
  ticker: string;
  companyName?: string;
  industry?: string;
  exchange?: string;
  balanceSheetDate?: string | null;
  strip: KeyStat[];
  figures: ComputedFigure[];
  data: TickerData;
  verifySources: { url: string; title: string }[];
  /** Peer names/tickers — banned from the page; scanned, not just prompted. */
  peers?: { symbol: string; name: string }[];
  /** The comp table block — ground truth if a peer figure slips through. */
  peerComps?: string;
  /** Investment-holdco NAV frame (July 17) — the page's valuation section
   * reads from the live discount; the fact-check gets the computed bridge. */
  holdco?: import("./holdco").HoldcoContext | null;
}): Promise<PageOneMemo | null> {
  const cfg = config();
  const stripLine = args.strip.map((s) => `${s.label}: ${s.value}`).join(" | ");
  const figuresBlock = args.figures.map((f) => `${f.label}: ${f.value}`).join("\n");
  const holdcoBlockText = args.holdco ? holdcoPromptBlock(args.holdco) : null;
  const userContent = (repairNote: string) =>
    `<full_note ticker="${args.ticker}" company="${args.companyName ?? ""}">\n${args.fullNoteMarkdown}\n</full_note>\n\n` +
    `<stat_strip note="page one's own strip — the reader sees these exact values">\n${stripLine}\n</stat_strip>\n\n` +
    `<computed_figures note="the snapshot behind the strip, at today's close${args.balanceSheetDate ? `; balance sheet dated ${args.balanceSheetDate}` : ""}">\n${figuresBlock}\n</computed_figures>\n\n` +
    (holdcoBlockText
      ? `<holdco_valuation_frame note="this is an investment holding company — the valuation section reads from the LIVE discount below, never from consolidated P/E of revaluation earnings">\n${holdcoBlockText}\n</holdco_valuation_frame>\n\n`
      : "") +
    `Context for the handle: industry "${args.industry ?? "?"}", exchange "${args.exchange ?? "?"}".\n` +
    `${repairNote}Write the five sections and the handle.`;

  try {
    let repairNote = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await anthropic().messages.create({
        model: cfg.MEMO_MODEL,
        max_tokens: 3000,
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema: PAGE_ONE_SCHEMA }, effort: "medium" },
        system: PAGE_ONE_SYSTEM,
        messages: [{ role: "user", content: userContent(repairNote) }],
      });
      if (res.stop_reason === "refusal") return null;
      const text = res.content.find((b) => b.type === "text");
      const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as Partial<PageOneMemo>;
      if (!parsed.trade || !parsed.valuation || !parsed.risks) return null;
      const memo: PageOneMemo = {
        handle: (parsed.handle ?? "").trim().slice(0, 60),
        trade: (parsed.trade ?? "").trim(),
        business: (parsed.business ?? "").trim(),
        valuation: (parsed.valuation ?? "").trim(),
        variant: (parsed.variant ?? "").trim(),
        risks: (parsed.risks ?? "").trim(),
      };

      // Structural gate FIRST (cheap, deterministic): rule 3's constraints
      // are enforced in code, not just prompted.
      const structural = pageOneStructuralIssues(memo, args.peers ?? [], args.fullNoteMarkdown);
      if (structural.length > 0) {
        console.warn(`Page-one structural issues for ${args.ticker} (attempt ${attempt + 1}):`, structural);
        repairNote =
          `IMPORTANT — your previous draft broke the page's structure. Fix every item:\n` +
          structural.map((i) => `- ${i}`).join("\n") +
          "\n\n";
        continue;
      }

      // Then the fact-check: this is the densest page in the client's hands.
      // Repair rounds within the attempt budget; on final failure, no page
      // one (the verified full report still ships) — never a wrong number.
      const pageText = [
        `# ${args.ticker} — page one`,
        `## The trade\n${memo.trade}`,
        `## The business\n${memo.business}`,
        `## The valuation\n${memo.valuation}`,
        `## The variant view\n${memo.variant}`,
        `## Risks and catalyst\n${memo.risks}`,
      ].join("\n\n");
      const verification = await verifyMemo(
        pageText,
        args.data,
        args.verifySources,
        args.figures,
        args.peerComps,
        {
          holdcoBlock: holdcoBlockText ?? undefined,
          // The writer's contract says full-note figures are valid — the
          // checker must SEE that note or it disputes legitimate reuse.
          referenceNote: args.fullNoteMarkdown,
        },
      );
      // Rule 5: the page's discount words must match the computed class —
      // on whichever basis is live (look-through or dated published NAV).
      const signal = holdcoDiscountSignal(args.holdco);
      const wordIssues = signal
        ? holdcoAdjectiveIssues(pageText, signal.discountClass, signal.discountPct)
        : [];
      if (verification.passed && wordIssues.length === 0) return memo;
      verification.critical_issues.push(...wordIssues.map((p) => ({ claim: "valuation adjective", problem: p })));
      console.warn(
        `Page-one memo failed verification for ${args.ticker} (attempt ${attempt + 1}):`,
        verification.critical_issues,
      );
      repairNote =
        `IMPORTANT — a fact-checker disputed figures in your previous draft. For EACH disputed figure: DELETE it entirely — do not restate it, re-derive it, or replace it with a similar figure. The page must survive on the strip and computed figures alone; a shorter page beats a disputed number:\n` +
        verification.critical_issues.map((i) => `- "${i.claim}": ${i.problem}`).join("\n") +
        "\n\n";
    }
    return null;
  } catch (e) {
    console.error(`Page-one memo failed for ${args.ticker} (PDF ships without page one):`, e);
    return null;
  }
}
