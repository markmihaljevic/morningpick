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
        "The email body: three short paragraphs of about 2 sentences each, separated by BLANK LINES, " +
        "target ~150 words and never over 180, one thought per paragraph. NO greeting, NO sign-off, NO reply invitation " +
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
3. SHAPE: three short paragraphs, TWO sentences each (a third sentence only if the sentences are short) — aim for about 150 words, never more than 180. One thought per paragraph, blank line between them, never a single block. Before you finish, count the words in your body; if it runs over 170, cut a WHOLE sentence (a quiet name, an aside) and count again — do not shave words from every line.
4. The SUBJECT says what the email is. Idea day → "TICKER: hook" (bare ticker, no exchange suffix). Review day → "Your book — hook". A ticker subject promises a fresh idea; never put one on a review.
5. Do NOT write a greeting, sign-off, or reply invitation — the template adds all three. Start with your first real sentence.

ALSO:
- Plain prose. No markdown, bullets, headers, bold, links, or URLs.
- No internal plumbing ("dataset", field names, currency-conversion asides).
- Company names come from the note verbatim — never infer a name from a ticker.
- Every fact must already be in the full note below (the one exception: a PLACING LINE instruction in the user message supplies desk funnel numbers to use verbatim); you are compressing a fact-checked note from memory, not adding to it.
- End with the attachment line ONLY as instructed in the user message.`;

export interface CoverNote {
  subject: string;
  body: string;
}

/**
 * The exact decimal figures in a string — the ones that belong in the PDF, not
 * the email. A decimal passes (is NOT returned) only when it reads as speech: a
 * multiple ("2.4x", "2.4 times") or a rounded magnitude ("£1.5bn", "10.5
 * million"). Everything else is exact, whatever the notation: percents ("3.6%"),
 * symbol prices ("€43.99"), pence ("512.6p"), code prices ("SEK 43.99"), worded
 * ("43.99 euros"), bare ("closed at 43.99"). Shared by the gate (rule 1) and the
 * fallback (so a one-liner reading "1.0x tangible book" survives, but "512.6p"
 * does not).
 */
const SPOKEN_DECIMAL_SUFFIX = /^(x|times|k|m|bn|million|billion|trillion)$/i;
export function exactDecimalFigures(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\d+(?:,\d{3})*\.\d+\s?([a-z%]+)?/gi)) {
    if (m[1] && SPOKEN_DECIMAL_SUFFIX.test(m[1])) continue;
    out.push(m[0].trim());
  }
  return out;
}

/** Deterministic register checks (rules 1, 3, 4) — violations become repair notes. */
export function coverNoteRegisterIssues(
  subject: string,
  body: string,
  isReview: boolean,
): string[] {
  const issues: string[] = [];
  const words = body.split(/\s+/).filter(Boolean).length;
  // John's target is 120-180; the writer is told to aim for ~150. But the
  // model reliably overshoots and oscillates around 190, so a HARD reject at
  // 185 sent well-formed 188-word notes to the boilerplate fallback ("My latest
  // idea for you.") — strictly worse than shipping the good, slightly-long
  // note. Reject only genuine bloat (>200); the prompt does the pull toward 150.
  if (words > 200)
    issues.push(
      `Body is ${words} words — well over John's 120-180. Cut to about 160 by removing WHOLE sentences (a quiet name, an aside); do not shave words from every sentence — that just flattens the prose.`,
    );
  if (words < 105) issues.push(`Body is ${words} words — too thin; aim for 120-180.`);

  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length < 2) {
    issues.push("Single-block email — write about three short paragraphs separated by blank lines, one thought each.");
  }
  if (paragraphs.length > 4) issues.push(`${paragraphs.length} paragraphs — collapse to about three.`);

  // Rule 1: decimal precision belongs in the PDF (see exactDecimalFigures).
  for (const m of exactDecimalFigures(body)) {
    issues.push(`Exact figure "${m}" — round it the way a person speaks; the decimals live in the PDF.`);
  }

  // Rule 1: number budget. Count numeric tokens — prices ("£40", "510p"),
  // percents ("14%"), multiples ("10x"), magnitudes ("1.5bn") — excluding bare
  // years and calendar dates ("July 28"), which are dates, not figures.
  // No trailing \b: a word boundary cannot exist after "%", so it silently
  // dropped the suffix and "14%" counted as an excluded bare "14".
  const numericCount = (
    body.match(
      /(?:[£€$¥]\s?)?\b\d[\d,]*(?:\.\d+)?\s?(?:%|x\b|p\b|pence\b|times\b|k\b|m\b|bn\b|million\b|billion\b)?/gi,
    ) ?? []
  ).filter((t) => {
    const clean = t.replace(/[\s,]/g, "");
    if (/^(19|20)\d\d$/.test(clean)) return false; // year
    if (/^\d{1,2}$/.test(clean)) return false; // day-of-month / small ordinal
    return true;
  }).length;
  // A register-compliant review legitimately carries more tokens than an idea
  // day: 2-3 for the add plus one per quiet name.
  const budget = isReview ? 10 : 8;
  if (numericCount > budget) {
    issues.push(`${numericCount} numeric tokens — someone writing from memory uses a handful (2-3 for the actionable name, at most 1 each elsewhere).`);
  }

  // Rule 4, both directions: "Your book" prefix ONLY on review days,
  // ticker-led subjects ONLY on idea days — the subject is the visible check
  // that the calendar decision held.
  if (isReview && !/^your book\b/i.test(subject.trim())) {
    issues.push(`Review-day subject must lead with "Your book — " (got "${subject.slice(0, 50)}"). A ticker subject promises a fresh idea.`);
  }
  if (!isReview && /^your book\b/i.test(subject.trim())) {
    issues.push(`"Your book" leads REVIEW subjects only — this is an idea-slot email; lead with the ticker.`);
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
  /** Idea days (July 16): the placing line — "first of the N names that
   * cleared your filters this morning" — plus the honest conviction signal
   * on a quiet list. */
  funnel?: {
    rank: number | null;
    cleared: number;
    blockedAhead: number;
    quietList: boolean;
    conviction: number;
    convictionReason: string;
    whatWouldChange: string;
  };
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
  // The placing line (July 16): one line placing the name in this morning's
  // funnel. Desk facts supplied here — they are not in the full note. Branch
  // on RANK, never on blockedAhead alone: a technical fetch skip also moves
  // the shipped name off rank 1, and "first of N" would then be false.
  const f = args.funnel;
  let placing = "";
  if (f) {
    const skippedAhead = (f.rank ?? 1) - 1;
    const technicalAhead = Math.max(0, skippedAhead - f.blockedAhead);
    placing =
      skippedAhead === 0
        ? `is the first of the ${f.cleared} names that cleared your filters this morning`
        : technicalAhead === 0
          ? `is the top of the ${f.cleared} names that cleared your filters this morning, once I set aside ${f.blockedAhead} you already hold`
          : f.blockedAhead === 0
            ? `is the top of the ${f.cleared} names that cleared your filters this morning, after ${technicalAhead} I couldn't verify data for today`
            : `is the top of the ${f.cleared} names that cleared your filters this morning, once I set aside ${f.blockedAhead} you already hold and ${technicalAhead} I couldn't verify data for today`;
  }
  // Rule 4: conviction carries the quality signal, not silence — spoken
  // plainly when the LIST is weak (quiet list) or the NAME is (low absolute
  // conviction on a normal list).
  const speakConviction = f ? f.quietList || f.conviction <= 4 : false;
  const funnelNote = f
    ? `PLACING LINE (desk facts, not in the note below — use these numbers verbatim): include ONE short line placing the name: it ${placing}.${
        speakConviction
          ? ` ${
              f.quietList
                ? "QUIET LIST: today's list is weaker than usual — say plainly this is the best of a quiet list"
                : "THIN CASE: the conviction here is honestly low — say so plainly"
            }, carry the conviction as "${f.conviction}/10", and give one line on what would raise it${
              f.whatWouldChange ? ` (${f.whatWouldChange})` : ""
            }. Honest, never apologetic.`
          : ""
      }`
    : "";

  try {
    let repairNote = "";
    // Four attempts: dense idea names (a bank with a dozen metrics) often need
    // two compression passes to land inside 180 words (BARC went 213→197→…).
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await anthropic().messages.create({
        model: cfg.MEMO_MODEL,
        max_tokens: 2000,
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema: COVER_SCHEMA }, effort: "medium" },
        system: COVER_SYSTEM,
        messages: [
          {
            role: "user",
            content: `<full_note ticker="${args.ticker}">\n${args.fullNoteMarkdown}\n</full_note>\n\n${kindNote}\n${attachNote}${funnelNote ? `\n${funnelNote}` : ""}\n\n${repairNote}Write the morning email (subject + body).`,
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
    return null; // four register failures — the fallback subject/body is safer
  } catch (e) {
    console.error("Cover-note write failed (fail-open):", e);
    return null;
  }
}

/**
 * Register-safe fallback body for when writeCoverNote returns null (refusal,
 * three register failures, or API error). Review days get a static book
 * read-through framing — never "my latest idea" under a "Your book —" subject.
 * The one_liner never went through the register gate, so it is used only when
 * it carries no decimal figure. Deliberately short: on the degraded path a
 * thin honest note beats a wrong one.
 */
export function fallbackCoverBody(args: {
  isReview: boolean;
  oneLiner: string | null | undefined;
  onePager: boolean;
  fullReport: boolean;
}): string {
  const attachLine =
    args.onePager && args.fullReport
      ? "The one-page memo and the full report are attached — the complete argument, the numbers, and the sources are all in there."
      : args.fullReport
        ? "The full report is attached — the complete argument, the numbers, and the sources are all in there."
        : args.onePager
          ? "The one-page memo is attached — the argument and the numbers are in there."
          : "";
  if (args.isReview) {
    const lead =
      "A read-through of the book this morning rather than a fresh idea — where each name stands and whether anything has changed since I wrote it up.";
    return attachLine ? `${lead}\n\n${attachLine}` : `${lead}\n\nNothing here changes my mind on the names you hold.`;
  }
  // The one-liner never went through the gate, so use it only when it carries
  // no EXACT decimal figure — but a spoken multiple like "1.0x tangible book"
  // is fine and must survive (a blunt \d+\.\d+ test wrongly nuked it to
  // boilerplate, which is what happened to the BARC demo).
  const oneLiner = args.oneLiner?.trim();
  const safeOneLiner = oneLiner && exactDecimalFigures(oneLiner).length === 0 ? oneLiner : "My latest idea for you.";
  return attachLine ? `${safeOneLiner}\n\n${attachLine}` : safeOneLiner;
}

/** One walk skip, as logged by the funnel — input to the empty-funnel note. */
export interface NoIdeaAttempt {
  ticker: string;
  expectedConviction: number;
  reason: string;
}

/** The funnel numbers the rule-5 email states (shape mirrors FunnelStats). */
export interface NoIdeaFunnel {
  perScreen: { label: string; count: number }[];
  poolAfterDedup: number;
  domicileDropped: number;
  /** Named examples per cut — a name the client cannot check is not information. */
  domicileDroppedSample?: { ticker: string; name?: string; country?: string }[];
  sectorDropped?: number;
  sectorDroppedSample?: { ticker: string; name?: string; sector?: string }[];
  allowedCountries: string[] | null;
  eligible: number;
  ranked: number;
  quarantined: number;
  quarantinedSample?: { ticker: string; name?: string; reason?: string }[];
  blockedAhead: { ticker: string; name?: string; priorTicker: string; priorDate: string }[];
}

const NO_IDEA_SYSTEM = `You are an investment analyst writing the short morning email to a client on the ONLY legitimate empty morning (the client's own July 16 rule 5): the screen itself returned zero shippable survivors. That means the client's own filters are too tight today — the email states the funnel in numbers, names names, and asks whether to loosen one. Plain, factual, never apologetic — a funnel report between people, not a confession.

REGISTER RULES (checked in code):
1. The SUBJECT must begin exactly "Nothing cleared your filters this morning" (optionally " — " and a short factual hook).
2. Two or three short paragraphs, 60-180 words, blank line between. State the funnel in NUMBERS: how many names the screens returned, and which filter took it to zero (geography, the cap band, data quality, or every survivor already held). Whole numbers are the content here; NEVER exact decimals.
3. NAME COMPANIES: "a Japanese name" the client cannot check is not information. If survivors were skipped because the client already holds them, name the tickers. If a filter dropped names, use the SAMPLE examples in the funnel data (domicileDroppedSample, sectorDroppedSample, quarantinedSample) — two or three, each with its ticker and the reason it fell.
4. END WITH THE QUESTION: ask plainly whether to loosen ONE named filter ("Widen the cap band above two billion, or add a geography? Reply and I'll adjust."). One question, concrete options.
5. Do NOT write a greeting, sign-off, or reply invitation — the template adds them. No markdown. "Filters", "screens", and "cap band" are the client's own words and belong here; internal machinery ("pre-flight", "factor table", "pipeline") does not.`;

const NO_IDEA_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: 'Must begin "Nothing cleared your filters this morning".' },
    body: { type: "string", description: "2-3 short paragraphs, 60-180 words, blank-line separated, ending with the loosen-one-filter question." },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

/** Deterministic register checks for the empty-funnel note (July 16 rule 5). */
export function noIdeaRegisterIssues(subject: string, body: string): string[] {
  const issues: string[] = [];
  if (!/^nothing cleared your filters this morning\b/i.test(subject.trim())) {
    issues.push(`Subject must begin "Nothing cleared your filters this morning" (got "${subject.slice(0, 60)}").`);
  }
  // The subject conventions stay the visible check: no ticker-led subject
  // (that promises an idea), no "Your book" (reviews only).
  if (/^your book\b/i.test(subject.trim())) issues.push('"Your book" leads review subjects only.');
  const words = body.split(/\s+/).filter(Boolean).length;
  if (words > 185) issues.push(`Body is ${words} words — this note allows 60-180. Cut a detail, not the numbers.`);
  if (words < 50) issues.push(`Body is ${words} words — too thin to state the funnel in numbers; aim for 60-180.`);
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length < 2) issues.push("Single-block email — two or three short paragraphs, blank line between.");
  if (paragraphs.length > 4) issues.push(`${paragraphs.length} paragraphs — collapse to two or three.`);
  if (!/\d/.test(body)) issues.push("No numbers on the page — rule 5 says state the funnel in numbers.");
  if (!/\?/.test(body)) issues.push("No question — the email must ask whether to loosen one named filter.");
  for (const m of exactDecimalFigures(body)) {
    issues.push(`Exact figure "${m}" — whole numbers carry this email; round decimals away.`);
  }
  if (/i read everything|reply to this email in plain language/i.test(body)) {
    issues.push("Do not write the reply invitation — the template adds it.");
  }
  if (/pre-?flight|pipeline|conviction gate|factor (score|table)/i.test(body)) {
    issues.push("Internal plumbing on the page — filters, screens, and the cap band are the client's words; machinery is not.");
  }
  return issues;
}

/**
 * Write the empty-funnel morning email from the actual funnel numbers
 * (rule 5: state how many names in, which filter cut to zero, name names,
 * ask whether to loosen one). Register-gated with a repair loop. Fail-open:
 * null → the caller uses the static fallback.
 */
export async function writeNoIdeaNote(args: {
  attempts: NoIdeaAttempt[];
  funnel?: NoIdeaFunnel;
  reason: string;
}): Promise<CoverNote | null> {
  const cfg = config();
  try {
    let repairNote = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await anthropic().messages.create({
        model: cfg.MEMO_MODEL,
        max_tokens: 1500,
        thinking: { type: "disabled" },
        output_config: { format: { type: "json_schema", schema: NO_IDEA_SCHEMA }, effort: "medium" },
        system: NO_IDEA_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Why the funnel came back empty: ${args.reason}\n\n<funnel_numbers>\n${JSON.stringify(args.funnel ?? {})}\n</funnel_numbers>\n\n<walk_skips note="survivors skipped and why (already-held names etc.)">\n${JSON.stringify(args.attempts)}\n</walk_skips>\n\n${repairNote}Write the morning email (subject + body).`,
          },
        ],
      });
      if (res.stop_reason === "refusal") return null;
      const text = res.content.find((b) => b.type === "text");
      const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as Partial<CoverNote>;
      const subject = (parsed.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const body = (parsed.body ?? "").trim();
      if (!subject || body.length < 100) return null;

      const issues = noIdeaRegisterIssues(subject, body);
      if (issues.length === 0) return { subject, body };
      console.warn(`Empty-funnel note register issues (attempt ${attempt + 1}):`, issues);
      repairNote = `IMPORTANT — your previous draft broke the register. Fix every item:\n${issues
        .map((i) => `- ${i}`)
        .join("\n")}\n\n`;
    }
    return null;
  } catch (e) {
    console.error("Empty-funnel note write failed (fail-open):", e);
    return null;
  }
}

/** Static register-safe fallback when even the empty-funnel writer fails. */
export function fallbackNoIdeaBody(funnel?: NoIdeaFunnel): { subject: string; body: string } {
  const screened = funnel?.poolAfterDedup;
  const held = (funnel?.blockedAhead ?? []).map((b) => b.ticker);
  const first =
    screened !== undefined && screened > 0
      ? `Your screens returned ${screened} names this morning, and not one cleared to shippable: ${
          held.length > 0
            ? `every survivor is a company you already hold (${held.slice(0, 6).join(", ")}) with nothing new reported`
            : `after the geography and data-quality cuts, the list was empty`
        }.`
      : `Your ${funnel?.perScreen.length ?? "several"} screens returned 0 names this morning — the filters as set didn't return a single company.`;
  return {
    subject: "Nothing cleared your filters this morning",
    body: `${first}\n\nThat usually means the filters are set too tight for the current tape, not that the desk stopped looking. Worth loosening one — the cap band or a geography? Reply in plain language and I'll adjust tomorrow's run.`,
  };
}

/** The ticker without its exchange suffix — "BARC.L" → "BARC" — for subjects. */
export function bareTicker(ticker: string): string {
  return ticker.split(".")[0].toUpperCase();
}
