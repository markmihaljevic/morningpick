import { anthropic } from "./anthropic";
import { config } from "./config";
import type { MemoMeta } from "./memo";

/**
 * The short cover note that now IS the email. The full argument ships as an
 * attached PDF; this is the two-paragraph note a human analyst types on top of
 * it when sending a write-up to a client. Distilled from the ALREADY-VERIFIED
 * full note, so every number it carries inherits that note's fact-check — it
 * states clean conclusions and never re-derives anything.
 */

const COVER_SCHEMA = {
  type: "object",
  properties: {
    subject: {
      type: "string",
      description:
        "Email subject: the ticker (WITHOUT any exchange suffix like .L) then a colon then a specific hook. " +
        "E.g. 'BARC: buyback done, still the cheapest UK bank on book'. Never generic, never 'today's idea'.",
    },
    body: {
      type: "string",
      description:
        "The cover note itself: 120-180 words of plain prose. NO greeting line, NO sign-off (both are added around it).",
    },
  },
  required: ["subject", "body"],
  additionalProperties: false,
} as const;

const COVER_SYSTEM = `You are an investment analyst. You have just finished a full research note on a stock and you are writing the SHORT cover email that goes on top of it — the note you'd actually type to a client when sending the full write-up. The full report and a one-page fact sheet are attached to this email; the reader can open them for the complete argument, the arithmetic, and the sources.

Write ONLY the cover note. 120-180 words. First person, informal but precise — the way a sharp analyst emails a client, not a press release.

Shape (as flowing prose, NOT labelled sections):
1. Why this name today — 1-2 sentences.
2. The thesis — 3-4 sentences, carrying only the numbers that actually matter.
3. The main risk and the level or event that would make you walk away — 2 sentences.
4. One closing line noting that the one-pager and full report are attached — ONLY if the user message says attachments are included; otherwise end after the risk without mentioning attachments.

HARD RULES:
- Plain prose only. No markdown, no bullet points, no headers, no bold.
- Do NOT write a greeting ("Good morning" / "Hi") or a sign-off — those are added for you. Start with your first real sentence.
- NO inline arithmetic. Write "1.07x tangible book", never "529.5/495.7 = 1.07x". Write "about 110m shares at an average of 454p", never "110,060,483 shares at 454.2957p". Round big numbers.
- NO source URLs and no links — sources live in the attached PDF.
- NEVER mention internal plumbing: no "dataset", no field names, no "reportedCurrency", no unit-conversion asides. State conclusions; the data caveats live in the report.
- Every figure you use must already appear in the full note below — you are summarising a finished, fact-checked note, not adding anything new.

Also produce the SUBJECT in "TICKER: hook" form (ticker without exchange suffix).`;

export interface CoverNote {
  subject: string;
  body: string;
}

/**
 * Distil the finished, verified full note into the cover email. Fail-open:
 * on any error returns null and the caller falls back to a plain subject +
 * the note's own opening. `ticker`/`hook` seed a sensible fallback subject.
 */
export async function writeCoverNote(args: {
  fullNoteMarkdown: string;
  ticker: string;
  meta: MemoMeta | null;
  /** False on notes that ship without PDFs (reviews) — no "attached" line. */
  hasAttachments?: boolean;
}): Promise<CoverNote | null> {
  const cfg = config();
  const attachNote =
    args.hasAttachments === false
      ? "This email has NO attachments — do not mention any attached one-pager or report."
      : "Attachments ARE included (one-pager + full report) — close by noting they're attached.";
  try {
    const res = await anthropic().messages.create({
      model: cfg.MEMO_MODEL,
      max_tokens: 2000,
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema", schema: COVER_SCHEMA }, effort: "medium" },
      system: COVER_SYSTEM,
      messages: [
        {
          role: "user",
          content: `<full_note ticker="${args.ticker}">\n${args.fullNoteMarkdown}\n</full_note>\n\n${attachNote}\n\nWrite the cover note and subject.`,
        },
      ],
    });
    if (res.stop_reason === "refusal") return null;
    const text = res.content.find((b) => b.type === "text");
    const parsed = JSON.parse(text && "text" in text ? text.text : "{}") as Partial<CoverNote>;
    let subject = (parsed.subject ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    // Enforce John's "bare ticker: hook" — strip any exchange suffix the model
    // left on (CJ.TO: → CJ:), which it does often enough to guard against.
    const bare = bareTicker(args.ticker);
    subject = subject.replace(
      new RegExp(`^${bare.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\.[A-Za-z]{1,4}\\b`),
      bare,
    );
    const body = (parsed.body ?? "").trim();
    if (!subject || body.length < 200) return null; // too thin to trust — fall back
    return { subject, body };
  } catch (e) {
    console.error("Cover-note write failed (fail-open):", e);
    return null;
  }
}

/** The ticker without its exchange suffix — "BARC.L" → "BARC" — for subjects. */
export function bareTicker(ticker: string): string {
  return ticker.split(".")[0].toUpperCase();
}
