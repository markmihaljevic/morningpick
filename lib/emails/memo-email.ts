import { marked } from "marked";
import { emailLayout } from "./layout";

/** Convert the memo markdown into the full HTML email. */
export function renderMemoEmail(markdown: string, unsubscribeToken: string): string {
  const html = marked.parse(markdown, { async: false }) as string;
  // Light inline styling for email clients that ignore <style> blocks.
  const styled = html
    .replace(/<h1>/g, '<h1 style="font-size:24px;line-height:1.3;margin:0 0 16px;">')
    .replace(/<h2>/g, '<h2 style="font-size:19px;line-height:1.35;margin:24px 0 8px;">')
    .replace(/<h3>/g, '<h3 style="font-size:17px;line-height:1.4;margin:20px 0 6px;">')
    .replace(/<p>/g, '<p style="margin:0 0 14px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 14px;padding-left:22px;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 14px;padding-left:22px;">')
    .replace(/<li>/g, '<li style="margin:0 0 6px;">');
  return emailLayout(styled, unsubscribeToken);
}
