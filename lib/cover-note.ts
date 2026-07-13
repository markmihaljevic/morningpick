import { anthropic } from "./anthropic";
import { config } from "./config";
import type { MemoMeta } from "./memo";

/**
 * The short cover note that IS the morning email, written AS IF FROM MEMORY,
 * file closed (John's register rules, July 13): the pitch in plain words,
 * rounded numbers the way a person speaks, three short paragraphs. Exact
 * figures (512.6p, €43.99, 3.6%) belong in the attached PDF, never here.
 * Distilled from the ALREADY-VERIFIED full note, so every number it carries
 * inherits that note's fact-check.
 */

const COVER_SCHEMA = {
  type: "object",
  properties: {
    subject: {
      type: "string",
      description:
        "Email subject that says what the email IS. Idea days: bare ticker + colon + specific hook " +
        "('BARC: the add, not the hold'). Review days: 'Your book — ' + hook ('Your book — quiet week, one name I'd add to'). " +
        "Never generic. A single-ticker subject promises a fresh idea — never use one on a review.",
    },
    body: {
      type: "string",
      description:
        "The email body: about three short paragraphs of 2-3 sentences each, separated by BLANK LINES, " +
        "120-180 words total, one thought per paragraph. NO greeting, NO sign-off, NO reply invitation " +
        "(all added around it).",
    },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

const COVER_SYSTEM = `You are an investment analyst writing the short morning email to a client — the note that goes ON TOP of the attached PDF. Write it AS IF FROM MEMORY, FILE CLOSED: you know the book cold and you're telling them what matters, the way a person speaks. The precision lives in the PDF; the email is between people.

REGISTER RULES (every one is checked):
1. FROM MEMORY: the pitch in plain words, then rounded numbers the way a person speaks — "about 510p", "roughly 14% below my pitch", "just above tangible book", "near 10x this year's earnings". NEVER exact figures: no "512.6p", no "€43.99", no "3.6%" — decimals belong in the PDF. At most two or three numbers for the ONE name you'd act on; at most one number for anyone else.
2. VALUATION ANCHORS, ABSOLUTE NOT RELATIVE: one or two of your numbers must be P/TBV, P/E, or FCF yield. Never make a price move the headline without the multiple it produced — "down 3%" only matters as "still just above tangible book".
3. SHAPE: about three short paragraphs of two or three sentences each, 120-180 words total, ONE thought per paragraph, blank line between paragraphs. Never a single block.
4. The SUBJECT says what the email is. Idea day → "TICKER: hook" (bare ticker, no exchange suffix). Review day → "Your book — hook". A ticker subject promises a fresh idea; never put one on a review.
5. Do NOT write a greeting, sign-off, or reply invitation — the template adds all three. Start with your first real sentence.

ALSO:
- Plain prose. No markdown, bullets, headers, bold, links, or URLs.
- No internal plumbing ("dataset", field names, currency-conversion asides).
- Company names come from the note verbatim — never infer a name from a ticker.
- Every fact must already be in the full note below; you are compressing a fact-checked note from memory, not adding to it.
- End with the attachment line ONLY as instructed in the user message.`;

export interface CoverNote {
  subject: string;
  body: string;
}

/** Deterministic register checks (rules 1, 3, 4) — violations become repair notes. */
export function coverNoteRegisterIssues(
  subject: string,
  body: string,
  isReview: boolean,
): string[] {
  const issues: string[] = [];
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > 185) issues.push(`Body is ${words} words — the email allows 120-180. Cut a thought, don't compress the prose.`);
  if (words < 105) issues.push(`Body is ${words} words — too thin; aim for 120-180.`);

  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length < 2) {
    issues.push("Single-block email — write about three short paragraphs separated by blank lines, one thought each.");
  }
  if (paragraphs.length > 4) issues.push(`${paragraphs.length} paragraphs — collapse to about three.`);

  // Rule 1: decimal precision belongs in the PDF. Decimal PRICES ("512.6p",
  // "€43.99", "$1.05") and decimal PERCENTS ("3.6%") are banned; one-decimal
  // MULTIPLES ("2.4x") read as speech and pass.
  const decimalPrices = body.match(/(?:[£€$]|C\$|A\$)\s?\d+\.\d+|\b\d+\.\d+\s?p\b/g) ?? [];
  const decimalPercents = body.match(/\b\d+\.\d+\s?%/g) ?? [];
  for (const m of [...decimalPrices, ...decimalPercents]) {
    issues.push(`Exact figure "${m}" — round it the way a person speaks ("about ${m.replace(/\.\d+/, "")}"); the decimals live in the PDF.`);
  }

  // Rule 1: number budget. Count numeric tokens, excluding bare years and
  // calendar dates ("July 28") which are dates, not figures.
  const numericCount = (body.match(/\b\d[\d,.]*(?:x|%|p|m|bn|k)?\b/gi) ?? []).filter((t) => {
    const clean = t.replace(/[,.]/g, "");
    if (/^(19|20)\d\d$/.test(clean)) return false; // year
    if (/^\d{1,2}$/.test(clean)) return false; // day-of-month / small ordinal
    return true;
  }).length;
  if (numericCount > 8) {
    issues.push(`${numericCount} numeric tokens — someone writing from memory uses a handful (2-3 for the actionable name, at most 1 each elsewhere).`);
  }

  if (isReview && !/^your book\b/i.test(subject.trim())) {
    issues.push(`Review-day subject must lead with "Your book — " (got "${subject.slice(0, 50)}"). A ticker subject promises a fresh idea.`);
  }

  // Rule 5: template adds the invitation — the body must not duplicate it.
  if (/i read everything|reply to this email/i.test(body)) {
    issues.push("Do not write the reply invitation — the template adds it.");
  }
  return issues;
}

/**
 * Distil the finished, verified full note into the cover email, register-
 * checked with a repair loop. Fail-open: on any error returns null and the
 * caller falls back to a plain subject + one-liner.
 */
export async function writeCoverNote(args: {
  fullNoteMarkdown: string;
  ticker: string;
  meta: MemoMeta | null;
  /** Review days subject differently ("Your book —") and never a ticker. */
  isReview?: boolean;
  /** What is ACTUALLY attached — the closing line must never promise a PDF
   * that failed its gate. Omitted → assume both (legacy callers). */
  attachments?: { onePager: boolean; fullReport: boolean };
}): Promise<CoverNote | null> {
  const cfg = config();
  const att = args.attachments ?? { onePager: true, fullReport: true };
  const attachNote =
    !att.onePager && !att.fullReport
      ? "This email has NO attachments — do not mention any attached one-pager or report."
      : att.onePager && att.fullReport
        ? "Attachments ARE included (the one-page memo + the full report) — close by noting they're attached, briefly."
        : att.fullReport
          ? "ONLY the full report is attached (no one-pager today) — the closing line mentions the full report alone."
          : "ONLY the one-page memo is attached — the closing line mentions it alone.";
  const kindNote = args.isReview
    ? 'This is a REVIEW DAY (a read-through of the book, no fresh pick): the subject MUST lead with "Your book — ".'
    : 'This is an IDEA DAY: the subject is "TICKER: hook" with the bare ticker.';

  try {
    let repairNote = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await anthropic().messages.create({
        model: cfg.MEMO_MODEL,
        max_tokens: 2000,
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema: COVER_SCHEMA }, effort: "medium" },
        system: COVER_SYSTEM,
        messages: [
          {
            role: "user",
            content: `<full_note ticker="${args.ticker}">\n${args.fullNoteMarkdown}\n</full_note>\n\n${kindNote}\n${attachNote}\n\n${repairNote}Write the morning email (subject + body).`,
          },
        ],
      });
      if (res.stop_reason === "refusal") return null;
      const text = res.content.find((b) => b.type === "text");
      const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as Partial<CoverNote>;
      let subject = (parsed.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!args.isReview) {
        // Enforce "bare ticker: hook" — strip any exchange suffix the model
        // left on (CJ.TO: → CJ:).
        const bare = bareTicker(args.ticker);
        subject = subject.replace(
          new RegExp(`^${bare.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\.[A-Za-z]{1,4}\\b`),
          bare,
        );
      }
      const body = (parsed.body ?? "").trim();
      if (!subject || body.length < 150) return null; // too thin to trust — fall back

      const issues = coverNoteRegisterIssues(subject, body, Boolean(args.isReview));
      if (issues.length === 0) return { subject, body };
      console.warn(`Cover-note register issues (attempt ${attempt + 1}):`, issues);
      repairNote = `IMPORTANT — your previous draft broke the register. Fix every item:\n${issues
        .map((i) => `- ${i}`)
        .join("\n")}\n\n`;
    }
    return null; // three register failures — the fallback subject/body is safer
  } catch (e) {
    console.error("Cover-note write failed (fail-open):", e);
    return null;
  }
}

/** The ticker without its exchange suffix — "BARC.L" → "BARC" — for subjects. */
export function bareTicker(ticker: string): string {
  return ticker.split(".")[0].toUpperCase();
}
