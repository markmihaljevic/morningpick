import { marked } from "marked";
import { emailLayout, escapeHtml } from "./layout";
import type { MemoSource } from "../memo";
import type { ResearchLink } from "../research-links";

export interface MemoEmailArgs {
  markdown: string;
  unsubscribeToken: string;
  portalToken?: string;
  chartUrl?: string | null;
  researchLinks?: ResearchLink[];
  sources?: MemoSource[];
}

/** Convert the memo markdown + extras into the full HTML email. */
export function renderMemoEmail(args: MemoEmailArgs): string {
  const html = marked.parse(args.markdown, { async: false }) as string;
  // Light inline styling for email clients that ignore <style> blocks.
  const styled = html
    .replace(/<h1>/g, '<h1 style="font-size:24px;line-height:1.3;margin:0 0 16px;">')
    .replace(/<h2>/g, '<h2 style="font-size:19px;line-height:1.35;margin:24px 0 8px;">')
    .replace(/<h3>/g, '<h3 style="font-size:17px;line-height:1.4;margin:20px 0 6px;">')
    .replace(/<p>/g, '<p style="margin:0 0 14px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 14px;padding-left:22px;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 14px;padding-left:22px;">')
    .replace(/<li>/g, '<li style="margin:0 0 6px;">');

  const sections: string[] = [styled];

  if (args.chartUrl) {
    sections.push(
      `<div style="margin:24px 0;">
        <img src="${args.chartUrl}" alt="5-year price chart" width="600"
             style="max-width:100%;height:auto;border:1px solid #ddd8cc;" />
      </div>`,
    );
  }

  if (args.researchLinks && args.researchLinks.length > 0) {
    sections.push(
      `<div style="margin:28px 0 0;">
        <p style="margin:0 0 8px;font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:1.5px;color:#8a8578;">DIG DEEPER</p>
        <ul style="margin:0 0 14px;padding-left:22px;">
          ${args.researchLinks
            .map(
              (l) =>
                `<li style="margin:0 0 6px;"><a href="${l.url}" style="color:#b0532a;">${escapeHtml(l.label)}</a></li>`,
            )
            .join("\n")}
        </ul>
      </div>`,
    );
  }

  if (args.sources && args.sources.length > 0) {
    sections.push(
      `<div style="margin:20px 0 0;">
        <p style="margin:0 0 8px;font-family:Helvetica,Arial,sans-serif;font-size:12px;letter-spacing:1.5px;color:#8a8578;">SOURCES CITED</p>
        <ul style="margin:0 0 14px;padding-left:22px;font-size:13px;color:#8a8578;">
          ${args.sources
            .map(
              (s) =>
                `<li style="margin:0 0 4px;"><a href="${s.url}" style="color:#8a8578;">${escapeHtml(s.title || s.url)}</a></li>`,
            )
            .join("\n")}
        </ul>
      </div>`,
    );
  }

  return emailLayout(sections.join("\n"), args.unsubscribeToken, args.portalToken);
}
