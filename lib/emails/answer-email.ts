import { marked } from "marked";
import { emailLayout, escapeHtml } from "./layout";
import { config } from "../config";

export interface AnswerEmailArgs {
  answerMarkdown: string;
  questions: string[];
  memoTitle: string | null;
  unsubscribeToken: string;
  profileUrl?: string;
  /** When the same reply also updated their preferences. */
  feedbackLine: string | null;
}

/** In-thread research-desk answer — a plain reply, like a person would send. */
export function renderAnswerEmail(args: AnswerEmailArgs): string {
  const html = marked.parse(args.answerMarkdown, { async: false }) as string;
  const styled = html
    .replace(/<h2>([\s\S]*?)<\/h2>/g, (_, inner: string) => `<p style="margin:16px 0 4px;"><b>${inner}</b></p>`)
    .replace(/<p>/g, '<p style="margin:0 0 14px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 14px;padding-left:22px;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 14px;padding-left:22px;">')
    .replace(/<li>/g, '<li style="margin:0 0 6px;">')
    .replace(/<a href=/g, `<a style="color:#1155cc;" href=`);

  const quoted = args.questions
    .map((q) => `<p style="margin:0 0 6px;color:#5f6368;">&gt; ${escapeHtml(q)}</p>`)
    .join("\n");

  const body = `
    <p style="margin:0 0 14px;">Good question —</p>
    ${quoted}
    <div style="margin:14px 0 0;">${styled}</div>
    ${
      args.feedbackLine
        ? `<p style="margin:18px 0 0;color:#5f6368;">(Also noted: ${escapeHtml(args.feedbackLine)} — that goes into how I pick for you from here.)</p>`
        : ""
    }
    <p style="margin:18px 0 0;">— ${config().ANALYST_NAME}</p>`;

  return emailLayout(body, { unsubscribeToken: args.unsubscribeToken, profileUrl: args.profileUrl });
}
