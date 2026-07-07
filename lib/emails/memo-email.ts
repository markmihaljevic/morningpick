import { emailLayout, escapeHtml } from "./layout";

export interface MemoEmailArgs {
  /** The cover note prose — plain text, blank-line-separated paragraphs. */
  coverNote: string;
  /** First name for the salutation — "Good morning, Mark,". Null → "Good morning,". */
  greetingName?: string | null;
  /** The analyst persona's first name — signs every note, the same each day. */
  signOffName: string;
  /** True for a subscriber's very first note — renders the blank-slate intro. */
  firstNote?: boolean;
  unsubscribeToken: string;
  billingUrl?: string;
  upgradeUrl?: string;
  profileUrl?: string;
  preparedFor?: string;
  dateLine?: string;
}

/**
 * The morning email as a short cover note from a human analyst. Just the
 * greeting, a 120-180 word note in plain paragraphs, and a first-name sign-off.
 * The full argument, the arithmetic, and the sources ride along as attached
 * PDFs — this reads like a normal email a person typed, nothing more.
 */
export function renderMemoEmail(args: MemoEmailArgs): string {
  // The cover note is plain prose (no markdown, no links by design). Escape it
  // and split blank-line-separated paragraphs — never trust it as HTML.
  const paragraphs = args.coverNote
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(
      (p) => `<p style="margin:0 0 14px;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`,
    )
    .join("\n");

  const salutation = `<p style="margin:0 0 14px;">Good morning${
    args.greetingName ? `, ${args.greetingName}` : ""
  },</p>`;

  const firstNoteAside = args.firstNote
    ? `<p style="margin:0 0 14px;color:#5f6368;">(A quick word before we start — this is your first note, written before I really know you. Just reply and tell me how you invest, and every note from here adapts.)</p>`
    : "";

  const signOff = `<p style="margin:22px 0 0;">— ${escapeHtml(args.signOffName)}</p>`;

  const letter = `${salutation}${firstNoteAside}${paragraphs}${signOff}`;

  return emailLayout(letter, {
    unsubscribeToken: args.unsubscribeToken,
    billingUrl: args.billingUrl,
    upgradeUrl: args.upgradeUrl,
    profileUrl: args.profileUrl,
    preparedFor: args.preparedFor,
    dateLine: args.dateLine,
  });
}
