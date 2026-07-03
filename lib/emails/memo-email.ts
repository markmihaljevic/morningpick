import { marked } from "marked";
import { emailLayout, escapeHtml } from "./layout";
import { BRAND } from "../brand";
import type { MemoSource } from "../memo";
import type { ResearchLink } from "../research-links";
import type { KeyStat } from "../stats";

export interface MemoEmailArgs {
  markdown: string;
  unsubscribeToken: string;
  preparedFor?: string;
  dateLine?: string;
  stats?: KeyStat[];
  chartUrl?: string | null;
  researchLinks?: ResearchLink[];
  sources?: MemoSource[];
  pdfUrl?: string | null;
}

function sectionLabel(text: string): string {
  return `<p style="margin:0 0 10px;font-family:${BRAND.sans};font-size:11px;letter-spacing:2.5px;color:${BRAND.gold};font-weight:700;">${text}</p>`;
}

/** The memo email — Morningpick research-note format. */
export function renderMemoEmail(args: MemoEmailArgs): string {
  const html = marked.parse(args.markdown, { async: false }) as string;
  const styled = html
    .replace(
      /<h1>/g,
      `<h1 style="font-size:27px;line-height:1.25;margin:6px 0 18px;font-weight:700;color:${BRAND.ink};">`,
    )
    .replace(/<h2>/g, `<h2 style="font-size:19px;line-height:1.35;margin:26px 0 8px;color:${BRAND.ink};">`)
    .replace(/<h3>/g, `<h3 style="font-size:17px;line-height:1.4;margin:22px 0 6px;color:${BRAND.ink};">`)
    .replace(/<p>/g, '<p style="margin:0 0 15px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 15px;padding-left:22px;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 15px;padding-left:22px;">')
    .replace(/<li>/g, '<li style="margin:0 0 8px;">')
    .replace(/<strong>/g, `<strong style="color:${BRAND.ink};">`);

  const sections: string[] = [];

  // Key statistics strip — a research note leads with the numbers.
  if (args.stats && args.stats.length > 0) {
    const half = Math.ceil(args.stats.length / 2);
    const renderRow = (row: KeyStat[]) =>
      `<tr>${row
        .map(
          (s) => `<td style="padding:10px 12px;border:1px solid ${BRAND.rule};background:#ffffff;width:${Math.floor(100 / half)}%;">
          <div style="font-family:${BRAND.sans};font-size:9px;letter-spacing:1.5px;color:${BRAND.slate};">${escapeHtml(s.label.toUpperCase())}</div>
          <div style="font-family:${BRAND.sans};font-size:14px;font-weight:700;color:${BRAND.ink};margin-top:2px;white-space:nowrap;">${escapeHtml(s.value)}</div>
        </td>`,
        )
        .join("")}</tr>`;
    const row2 = args.stats.slice(half);
    sections.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 22px;">
        ${renderRow(args.stats.slice(0, half))}${row2.length > 0 ? renderRow(row2) : ""}
      </table>`,
    );
  }

  // Memo body — inject the stats strip right after the H1 so the title leads.
  const h1End = styled.indexOf("</h1>");
  if (h1End !== -1 && sections.length > 0) {
    sections[0] = styled.slice(0, h1End + 5) + sections[0] + styled.slice(h1End + 5);
  } else {
    sections.unshift(styled);
  }

  if (args.chartUrl) {
    sections.push(
      `<div style="margin:26px 0 0;">
        <img src="${args.chartUrl}" alt="5-year price chart" width="604"
             style="max-width:100%;height:auto;border:1px solid ${BRAND.rule};" />
      </div>`,
    );
  }

  if (args.pdfUrl) {
    sections.push(
      `<div style="margin:26px 0 0;">
        <a href="${args.pdfUrl}"
           style="display:inline-block;background:${BRAND.ink};color:${BRAND.paper};font-family:${BRAND.sans};font-size:12px;letter-spacing:2px;padding:11px 22px;text-decoration:none;border-bottom:2px solid ${BRAND.gold};">
          DOWNLOAD PDF ↧
        </a>
      </div>`,
    );
  }

  if (args.researchLinks && args.researchLinks.length > 0) {
    sections.push(
      `<div style="margin:30px 0 0;">
        ${sectionLabel("DIG DEEPER")}
        <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          ${args.researchLinks
            .map(
              (l) => `<tr><td style="padding:0 0 7px;font-family:${BRAND.serif};font-size:15px;">
                <span style="color:${BRAND.gold};">→</span>&nbsp;
                <a href="${l.url}" style="color:${BRAND.ink};">${escapeHtml(l.label)}</a>
              </td></tr>`,
            )
            .join("\n")}
        </table>
      </div>`,
    );
  }

  if (args.sources && args.sources.length > 0) {
    sections.push(
      `<div style="margin:26px 0 0;">
        ${sectionLabel("SOURCES CITED")}
        <ul style="margin:0;padding-left:18px;font-family:${BRAND.sans};font-size:12px;color:${BRAND.slate};">
          ${args.sources
            .map(
              (s) =>
                `<li style="margin:0 0 5px;"><a href="${s.url}" style="color:${BRAND.slate};">${escapeHtml(s.title || s.url)}</a></li>`,
            )
            .join("\n")}
        </ul>
      </div>`,
    );
  }

  return emailLayout(sections.join("\n"), {
    unsubscribeToken: args.unsubscribeToken,
    preparedFor: args.preparedFor,
    dateLine: args.dateLine,
  });
}
