import { marked } from "marked";
import { emailLayout, escapeHtml } from "./layout";
import { BRAND } from "../brand";

const MONO = "Menlo, Consolas, 'Courier New', monospace";

export interface AnswerEmailArgs {
  answerMarkdown: string;
  questions: string[];
  memoTitle: string | null;
  unsubscribeToken: string;
  /** When the same reply also updated their preferences. */
  feedbackLine: string | null;
}

/** In-thread research-desk answer to a subscriber's question(s). */
export function renderAnswerEmail(args: AnswerEmailArgs): string {
  const html = marked.parse(args.answerMarkdown, { async: false }) as string;
  const styled = html
    .replace(/<h2>([\s\S]*?)<\/h2>/g, (_, inner: string) =>
      `<div style="margin:24px 0 8px;"><span style="font-family:${MONO};font-size:11px;letter-spacing:2.5px;color:${BRAND.gold};font-weight:700;">${inner.toUpperCase()}</span></div>`,
    )
    .replace(/<p>/g, '<p style="margin:0 0 14px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 14px;padding-left:22px;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 14px;padding-left:22px;">')
    .replace(/<li>/g, '<li style="margin:0 0 7px;">')
    .replace(/<strong>/g, `<strong style="color:${BRAND.ink};">`);

  const body = `
    <p style="margin:0 0 6px;font-family:${MONO};font-size:10px;letter-spacing:2px;color:${BRAND.gold};font-weight:700;">FROM THE RESEARCH DESK</p>
    ${
      args.memoTitle
        ? `<p style="margin:0 0 16px;font-family:${BRAND.sans};font-size:12.5px;color:${BRAND.slate};">Re: ${escapeHtml(args.memoTitle)}</p>`
        : ""
    }
    <div style="border-left:3px solid ${BRAND.rule};padding:2px 0 2px 14px;margin:0 0 18px;">
      ${args.questions
        .map(
          (q) =>
            `<p style="margin:0 0 6px;font-family:${BRAND.serif};font-size:14.5px;font-style:italic;color:${BRAND.slate};">&ldquo;${escapeHtml(q)}&rdquo;</p>`,
        )
        .join("\n")}
    </div>
    ${styled}
    ${
      args.feedbackLine
        ? `<p style="margin:20px 0 0;font-family:${BRAND.sans};font-size:12.5px;color:${BRAND.slate};border-top:1px solid ${BRAND.rule};padding-top:12px;">
            <strong style="color:${BRAND.ink};">Also noted:</strong> ${escapeHtml(args.feedbackLine)}
          </p>`
        : ""
    }`;

  return emailLayout(body, { unsubscribeToken: args.unsubscribeToken });
}
