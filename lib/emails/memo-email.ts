import { marked } from "marked";
import { emailLayout } from "./layout";
import { BRAND } from "../brand";
import type { MemoSource, MemoMeta } from "../memo";
import type { KeyStat } from "../stats";
import type { StreetItem } from "../street";
import type { PrimarySource } from "../enrich-sources";
import type { CompsRow } from "../comps";
import type { BookRow } from "../coverage";

export interface MemoEmailArgs {
  markdown: string;
  /** First name for the salutation — "Good morning, Mark,". Null → "Good morning,". */
  greetingName?: string | null;
  /** True for a subscriber's very first note — renders the blank-slate intro. */
  firstNote?: boolean;
  unsubscribeToken: string;
  billingUrl?: string;
  upgradeUrl?: string;
  profileUrl?: string;
  preparedFor?: string;
  dateLine?: string;
  // Retained for callers/record-keeping; no longer rendered. The email is a
  // plain letter now — the numbers live in the prose, not in attached tables.
  stats?: KeyStat[];
  street?: StreetItem[];
  meta?: MemoMeta | null;
  primarySources?: PrimarySource[];
  chartUrl?: string | null;
  comps?: CompsRow[];
  book?: BookRow[];
  sources?: MemoSource[];
  pdfUrl?: string | null;
}

/**
 * The morning note as a plain letter: an analyst emailing his boss one idea.
 * Just prose — greeting, the argument in flowing paragraphs, a sign-off.
 * No tables, no charts, no verdict chrome; that scaffolding is what made it
 * read like a website and break on phones. The writing carries everything.
 */
export function renderMemoEmail(args: MemoEmailArgs): string {
  const html = marked.parse(args.markdown, { async: false }) as string;

  // Drop the H1 (the subject line already carries the ticker + hook), and
  // style the remaining prose minimally — this is a letter, not a document.
  const body = html
    .replace(/<h1>[\s\S]*?<\/h1>/, "")
    .replace(
      /<h2>([\s\S]*?)<\/h2>/g,
      (_, inner: string) =>
        `<p style="margin:22px 0 4px;font-weight:700;color:${BRAND.ink};">${inner}</p>`,
    )
    .replace(
      /<h3>([\s\S]*?)<\/h3>/g,
      (_, inner: string) =>
        `<p style="margin:20px 0 4px;font-weight:700;color:${BRAND.ink};">${inner}</p>`,
    )
    .replace(/<p>/g, '<p style="margin:0 0 15px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 15px;padding-left:20px;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 15px;padding-left:20px;">')
    .replace(/<li>/g, '<li style="margin:0 0 7px;">')
    .replace(/<strong>/g, `<strong style="color:${BRAND.ink};">`)
    .replace(
      /<a href=/g,
      `<a style="color:${BRAND.ink};text-decoration:underline;text-decoration-color:#C9CFD4;" href=`,
    )
    .trim();

  const salutation = `<p style="margin:0 0 15px;">Good morning${
    args.greetingName ? `, ${args.greetingName}` : ""
  },</p>`;

  const firstNoteAside = args.firstNote
    ? `<p style="margin:0 0 16px;font-style:italic;color:${BRAND.slate};">A quick word before we start: this is your first note, written before I really know you. Reply and tell me how you invest — anything at all — and every note from here adapts.</p>`
    : "";

  const letter = `${salutation}${firstNoteAside}${body}<p style="margin:22px 0 0;">— Your analyst</p>`;

  return emailLayout(letter, {
    unsubscribeToken: args.unsubscribeToken,
    billingUrl: args.billingUrl,
    upgradeUrl: args.upgradeUrl,
    profileUrl: args.profileUrl,
    preparedFor: args.preparedFor,
    dateLine: args.dateLine,
  });
}
