import { marked } from "marked";
import { emailLayout, escapeHtml } from "./layout";
import { BRAND } from "../brand";
import type { MemoSource, MemoMeta } from "../memo";
import type { ResearchLink } from "../research-links";
import type { KeyStat } from "../stats";
import type { StreetItem } from "../street";

const MONO = "Menlo, Consolas, 'Courier New', monospace";

/** A rough sector word for the reply-teaching examples; safe fallback. */
function inferSectorWord(markdown: string): string {
  const m = markdown.toLowerCase();
  for (const [word, hints] of [
    ["banks", ["bank", "lender"]],
    ["oil & gas", ["oil", "gas", "e&p", "energy"]],
    ["miners", ["mining", "miner"]],
    ["biotech", ["biotech", "pharma", "clinical"]],
    ["insurers", ["insurance", "insurer"]],
    ["retailers", ["retail"]],
  ] as [string, string[]][]) {
    if (hints.some((h) => m.includes(h))) return word;
  }
  return "this sector";
}

export interface MemoEmailArgs {
  markdown: string;
  unsubscribeToken: string;
  preparedFor?: string;
  dateLine?: string;
  stats?: KeyStat[];
  street?: StreetItem[];
  meta?: MemoMeta | null;
  chartUrl?: string | null;
  researchLinks?: ResearchLink[];
  sources?: MemoSource[];
  pdfUrl?: string | null;
}

function sectionLabel(text: string): string {
  return `<p style="margin:0 0 10px;font-family:${MONO};font-size:11px;letter-spacing:2.5px;color:${BRAND.gold};font-weight:700;">${text}</p>`;
}

/** Verdict chips: conviction, horizon, style tags. */
function verdictRow(meta: MemoMeta): string {
  const chip = (label: string, value: string, emphasis = false) =>
    `<td style="padding:0 8px 0 0;"><div style="border:1px solid ${emphasis ? BRAND.gold : BRAND.rule};background:${emphasis ? "#faf3e3" : "#ffffff"};padding:6px 11px;white-space:nowrap;">
      <span style="font-family:${MONO};font-size:8px;letter-spacing:1.5px;color:${BRAND.slate};">${escapeHtml(label)}</span><br/>
      <span style="font-family:${MONO};font-size:12px;font-weight:700;color:${BRAND.ink};">${escapeHtml(value)}</span>
    </div></td>`;
  const cells = [
    chip("CONVICTION", `${meta.conviction}/10`, true),
    chip("HORIZON", meta.horizon.toUpperCase()),
    ...meta.style_tags.map((t) => chip("STYLE", t.toUpperCase())),
  ].join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px;"><tr>${cells}</tr></table>`;
}

/** The memo email — Morningpick research-note format. */
export function renderMemoEmail(args: MemoEmailArgs): string {
  const html = marked.parse(args.markdown, { async: false }) as string;
  // H2 section names ("The idea", "Thesis"…) render as mono gold labels over
  // a hairline rule — the section system of the note.
  const styled = html
    .replace(
      /<h1>/g,
      `<h1 style="font-size:27px;line-height:1.25;margin:6px 0 14px;font-weight:700;color:${BRAND.ink};">`,
    )
    .replace(
      /<h2>([\s\S]*?)<\/h2>/g,
      (_, inner: string) =>
        `<div style="margin:28px 0 10px;border-top:1px solid ${BRAND.rule};padding-top:14px;">
          <span style="font-family:${MONO};font-size:11px;letter-spacing:2.5px;color:${BRAND.gold};font-weight:700;">${inner.toUpperCase()}</span>
        </div>`,
    )
    .replace(/<h3>/g, `<h3 style="font-size:17px;line-height:1.4;margin:22px 0 6px;color:${BRAND.ink};">`)
    .replace(/<p>/g, '<p style="margin:0 0 15px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 15px;padding-left:22px;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 15px;padding-left:22px;">')
    .replace(/<li>/g, '<li style="margin:0 0 8px;">')
    .replace(/<strong>/g, `<strong style="color:${BRAND.ink};">`);

  const sections: string[] = [];

  // Header block, injected after the H1 so the title leads:
  // verdict chips → one-liner → key stats → street line.
  const headerParts: string[] = [];

  if (args.meta) headerParts.push(verdictRow(args.meta));

  if (args.meta?.one_liner) {
    headerParts.push(
      `<div style="border-left:3px solid ${BRAND.gold};background:#faf3e3;padding:11px 14px;margin:0 0 18px;">
        <span style="font-family:${BRAND.serif};font-size:16px;font-style:italic;color:${BRAND.ink};">${escapeHtml(args.meta.one_liner)}</span>
      </div>`,
    );
  }

  if (args.stats && args.stats.length > 0) {
    const half = Math.ceil(args.stats.length / 2);
    const renderRow = (row: KeyStat[]) =>
      `<tr>${row
        .map(
          (s) => `<td style="padding:9px 11px;border:1px solid ${BRAND.rule};background:#ffffff;width:${Math.floor(100 / half)}%;">
          <div style="font-family:${MONO};font-size:8px;letter-spacing:1.5px;color:${BRAND.slate};">${escapeHtml(s.label.toUpperCase())}</div>
          <div style="font-family:${MONO};font-size:13px;font-weight:700;color:${BRAND.ink};margin-top:2px;white-space:nowrap;">${escapeHtml(s.value)}</div>
        </td>`,
        )
        .join("")}</tr>`;
    const row2 = args.stats.slice(half);
    headerParts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 10px;">
        ${renderRow(args.stats.slice(0, half))}${row2.length > 0 ? renderRow(row2) : ""}
      </table>`,
    );
  }

  if (args.street && args.street.length > 0) {
    headerParts.push(
      `<p style="margin:0 0 20px;font-family:${MONO};font-size:10px;letter-spacing:0.5px;color:${BRAND.slate};">
        ${args.street
          .map(
            (s) =>
              `<span style="white-space:nowrap;">${escapeHtml(s.label.toUpperCase())} <strong style="color:${BRAND.ink};">${escapeHtml(s.value)}</strong></span>`,
          )
          .join(" &nbsp;·&nbsp; ")}
      </p>`,
    );
  }

  const header = headerParts.join("\n");
  const h1End = styled.indexOf("</h1>");
  if (h1End !== -1 && header) {
    sections.push(styled.slice(0, h1End + 5) + header + styled.slice(h1End + 5));
  } else {
    if (header) sections.push(header);
    sections.push(styled);
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

  // Teach the killer feature: the reply loop.
  sections.push(
    `<div style="margin:30px 0 0;border:1px dashed ${BRAND.rule};padding:13px 16px;">
      <p style="margin:0;font-family:${MONO};font-size:10.5px;letter-spacing:0.5px;color:${BRAND.slate};line-height:1.8;">
        <span style="color:${BRAND.gold};font-weight:700;">YOUR ANALYST LISTENS.</span>
        Reply to this email — in plain language:<br/>
        &nbsp;&nbsp;"more like this" · "go deeper on the risks next time" · "never pitch me ${escapeHtml(inferSectorWord(args.markdown))} again"
      </p>
    </div>`,
  );

  return emailLayout(sections.join("\n"), {
    unsubscribeToken: args.unsubscribeToken,
    preparedFor: args.preparedFor,
    dateLine: args.dateLine,
  });
}
