import { marked } from "marked";
import { emailLayout, escapeHtml } from "./layout";
import { BRAND } from "../brand";
import type { MemoSource, MemoMeta } from "../memo";
import type { KeyStat } from "../stats";
import type { StreetItem } from "../street";
import type { PrimarySource } from "../enrich-sources";
import type { CompsRow } from "../comps";
import type { BookRow } from "../coverage";

const MONO = "Menlo, Consolas, 'Courier New', monospace";

const SOURCE_TYPE_LABEL: Record<PrimarySource["type"], string> = {
  interview: "INTERVIEW",
  earnings_call: "EARNINGS CALL",
  deep_dive: "DEEP DIVE",
  analysis: "ANALYSIS",
};

export interface MemoEmailArgs {
  markdown: string;
  /** True for a subscriber's very first note — renders the blank-slate intro. */
  firstNote?: boolean;
  unsubscribeToken: string;
  billingUrl?: string;
  upgradeUrl?: string;
  preparedFor?: string;
  dateLine?: string;
  stats?: KeyStat[];
  street?: StreetItem[];
  meta?: MemoMeta | null;
  primarySources?: PrimarySource[];
  chartUrl?: string | null;
  comps?: CompsRow[];
  /** Open calls, shown as the Monday ledger strip. */
  book?: BookRow[];
  sources?: MemoSource[];
  pdfUrl?: string | null;
}

function sectionLabel(text: string): string {
  return `<div style="margin:28px 0 10px;border-top:1px solid ${BRAND.rule};padding-top:14px;">
    <span style="font-family:${MONO};font-size:11px;letter-spacing:2.5px;color:${BRAND.gold};font-weight:700;">${text}</span>
  </div>`;
}

/** The memo email — the Morningpick research note. */
export function renderMemoEmail(args: MemoEmailArgs): string {
  const html = marked.parse(args.markdown, { async: false }) as string;
  const styled = html
    .replace(
      /<h1>/g,
      `<h1 style="font-size:26px;line-height:1.28;margin:4px 0 14px;font-weight:700;color:${BRAND.ink};">`,
    )
    .replace(/<h2>([\s\S]*?)<\/h2>/g, (_, inner: string) => sectionLabel(inner.toUpperCase()))
    .replace(/<h3>/g, `<h3 style="font-size:17px;line-height:1.4;margin:22px 0 6px;color:${BRAND.ink};">`)
    .replace(/<p>/g, '<p style="margin:0 0 15px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 15px;padding-left:22px;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 15px;padding-left:22px;">')
    .replace(/<li>/g, '<li style="margin:0 0 8px;">')
    .replace(/<strong>/g, `<strong style="color:${BRAND.ink};">`)
    .replace(/<a href=/g, `<a style="color:${BRAND.gold};font-weight:700;text-decoration:underline;text-decoration-color:${BRAND.rule};" href=`);

  const sections: string[] = [];

  if (args.firstNote) {
    sections.push(
      `<div style="border:1px solid ${BRAND.gold};padding:12px 16px;margin:0 0 20px;">
        <span style="font-family:${MONO};font-size:10px;letter-spacing:1.5px;color:${BRAND.gold};font-weight:700;">YOUR FIRST NOTE</span>
        <span style="font-family:${BRAND.sans};font-size:12.5px;color:${BRAND.slate};"> — written before knowing you. Reply and tell your analyst how you invest; every note from here on adapts.</span>
      </div>`,
    );
  }

  // ── Header block, injected after the H1 ─────────────────────────────────
  const headerParts: string[] = [];

  // Verdict strip: one dark bar, not a row of boxes.
  if (args.meta) {
    const parts = [
      `CONVICTION <span style="color:${BRAND.gold};">${args.meta.conviction}/10</span>`,
      `HORIZON <span style="color:${BRAND.paper};">${escapeHtml(args.meta.horizon.toUpperCase())}</span>`,
      ...args.meta.style_tags.map(
        (t) => `<span style="color:${BRAND.paper};">${escapeHtml(t.toUpperCase())}</span>`,
      ),
    ].map((p) => `<span style="white-space:nowrap;">${p}</span>`);
    headerParts.push(
      `<div style="background-color:${BRAND.ink};padding:8px 14px;margin:2px 0 14px;">
        <span style="font-family:${MONO};font-size:10.5px;letter-spacing:1.5px;line-height:2;color:#8FA0B0;">${parts.join('<span style="color:#3D4F60;">&nbsp;&nbsp;|&nbsp;&nbsp;</span>')}</span>
      </div>`,
    );
  }

  if (args.meta?.one_liner) {
    headerParts.push(
      `<div style="border-left:3px solid ${BRAND.gold};padding:2px 0 2px 14px;margin:0 0 18px;">
        <span style="font-family:${BRAND.serif};font-size:17px;font-style:italic;color:${BRAND.ink};line-height:1.5;">${escapeHtml(args.meta.one_liner)}</span>
      </div>`,
    );
  }

  // Key statistics — FT-style: horizontal rules only, right-aligned figures.
  if (args.stats && args.stats.length > 0) {
    const half = Math.ceil(args.stats.length / 2);
    const renderRow = (row: KeyStat[], last: boolean) =>
      `<tr>${row
        .map(
          (s) => `<td style="padding:8px 14px 8px 0;border-bottom:${last ? "2px solid " + BRAND.ink : "1px solid " + BRAND.rule};width:${Math.floor(100 / half)}%;white-space:nowrap;">
          <span style="font-family:${MONO};font-size:8.5px;letter-spacing:1.2px;color:${BRAND.slate};">${escapeHtml(s.label.toUpperCase())}</span><br/>
          <span style="font-family:${MONO};font-size:14px;font-weight:700;color:${BRAND.ink};">${escapeHtml(s.value)}</span>
        </td>`,
        )
        .join("")}</tr>`;
    const row2 = args.stats.slice(half);
    headerParts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border-top:2px solid ${BRAND.ink};margin:0 0 8px;">
        ${renderRow(args.stats.slice(0, half), row2.length === 0)}${row2.length > 0 ? renderRow(row2, true) : ""}
      </table>`,
    );
  }

  if (args.street && args.street.length > 0) {
    headerParts.push(
      `<p style="margin:0 0 8px;font-family:${MONO};font-size:10px;letter-spacing:0.5px;color:${BRAND.slate};line-height:2;">
        ${args.street
          .map(
            (s) =>
              `<span style="white-space:nowrap;">${escapeHtml(s.label.toUpperCase())} <strong style="color:${BRAND.ink};">${escapeHtml(s.value)}</strong></span>`,
          )
          .join(" &nbsp;·&nbsp; ")}
      </p>`,
    );
  }

  // Comps: the company against its peer set — small, dense, honest.
  if (args.comps && args.comps.length > 0) {
    headerParts.push(
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:2px 0 10px;">
        <tr>
          ${["", "P/E", "EV/EBITDA", "P/B", "P/S"]
            .map(
              (h, i) =>
                `<td style="padding:3px 0;border-bottom:1px solid ${BRAND.rule};font-family:${MONO};font-size:8.5px;letter-spacing:1.2px;color:${BRAND.slate};${i > 0 ? "text-align:right;" : ""}">${h || "VS PEERS"}</td>`,
            )
            .join("")}
        </tr>
        ${args.comps
          .map(
            (r) => `<tr>
            <td style="padding:4px 0;font-family:${MONO};font-size:11px;${r.self ? `font-weight:700;color:${BRAND.ink};` : `color:${BRAND.slate};`}">${escapeHtml(r.label)}</td>
            ${[r.pe, r.evEbitda, r.pb, r.ps]
              .map(
                (v) =>
                  `<td style="padding:4px 0;text-align:right;font-family:${MONO};font-size:11px;${r.self ? `font-weight:700;color:${BRAND.ink};` : `color:${BRAND.slate};`}">${escapeHtml(v)}</td>`,
              )
              .join("")}
          </tr>`,
          )
          .join("")}
      </table>`,
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

  // ── Evidence blocks ──────────────────────────────────────────────────────
  if (args.chartUrl) {
    sections.push(
      `<div style="margin:26px 0 0;">
        <img src="${args.chartUrl}" alt="5-year price chart" width="600"
             style="max-width:100%;height:auto;border:1px solid ${BRAND.rule};" />
      </div>`,
    );
  }

  // Worth your time: curated primary sources, only when something clears the bar.
  if (args.primarySources && args.primarySources.length > 0) {
    sections.push(
      `<div style="margin:28px 0 0;">
        ${sectionLabel("WORTH YOUR TIME")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          ${args.primarySources
            .map(
              (s) => `<tr>
                <td style="padding:0 0 12px;vertical-align:top;width:110px;">
                  <span style="display:inline-block;background:${BRAND.ink};color:${BRAND.gold};font-family:${MONO};font-size:8px;letter-spacing:1.2px;padding:3px 7px;">${SOURCE_TYPE_LABEL[s.type]}</span>
                </td>
                <td style="padding:0 0 12px;vertical-align:top;">
                  <a href="${s.url}" style="font-family:${BRAND.serif};font-size:15px;color:${BRAND.ink};font-weight:700;">${escapeHtml(s.title)}</a><br/>
                  <span style="font-family:${BRAND.sans};font-size:12.5px;color:${BRAND.slate};">${escapeHtml(s.note)}</span>
                </td>
              </tr>`,
            )
            .join("\n")}
        </table>
      </div>`,
    );
  }

  // The book: open calls marked to market — accountability, weekly.
  if (args.book && args.book.length > 0) {
    sections.push(
      `<div style="margin:26px 0 0;">
        ${sectionLabel("YOUR BOOK — OPEN CALLS")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          <tr>
            ${["", "PITCHED", "NOW", "RETURN", ""]
              .map(
                (h, i) =>
                  `<td style="padding:2px 0 6px;font-family:${MONO};font-size:8.5px;letter-spacing:1.2px;color:${BRAND.slate};${i > 0 && i < 4 ? "text-align:right;" : ""}">${h}</td>`,
              )
              .join("")}
          </tr>
          ${args.book
            .map((b) => {
              const ret = b.returnPct;
              const retColor = ret === null ? BRAND.slate : ret >= 0 ? "#2E6B4F" : "#9B3D3D";
              const fmt = (v: number | null) =>
                v === null ? "—" : v >= 100 ? v.toFixed(0) : v.toFixed(2);
              return `<tr>
              <td style="padding:4px 0;border-top:1px solid ${BRAND.rule};font-family:${MONO};font-size:11px;font-weight:700;color:${BRAND.ink};">${escapeHtml(b.ticker)}</td>
              <td style="padding:4px 0;border-top:1px solid ${BRAND.rule};text-align:right;font-family:${MONO};font-size:11px;color:${BRAND.slate};">${fmt(b.pitchPrice)} <span style="font-size:9px;">(${escapeHtml(b.date.slice(5))})</span></td>
              <td style="padding:4px 0;border-top:1px solid ${BRAND.rule};text-align:right;font-family:${MONO};font-size:11px;color:${BRAND.ink};">${fmt(b.priceNow)}</td>
              <td style="padding:4px 0;border-top:1px solid ${BRAND.rule};text-align:right;font-family:${MONO};font-size:11px;font-weight:700;color:${retColor};">${ret === null ? "—" : `${ret > 0 ? "+" : ""}${ret}%`}</td>
              <td style="padding:4px 0 4px 10px;border-top:1px solid ${BRAND.rule};font-family:${MONO};font-size:8.5px;letter-spacing:1px;color:${b.status === "watching" ? BRAND.gold : BRAND.slate};">${b.status === "watching" ? "WATCHING" : ""}</td>
            </tr>`;
            })
            .join("")}
        </table>
      </div>`,
    );
  }

  if (args.pdfUrl) {
    sections.push(
      `<div style="margin:28px 0 0;">
        <a href="${args.pdfUrl}"
           style="display:inline-block;background:${BRAND.ink};color:${BRAND.paper};font-family:${MONO};font-size:11px;letter-spacing:2px;padding:11px 22px;text-decoration:none;border-bottom:2px solid ${BRAND.gold};">
          DOWNLOAD PDF ↧
        </a>
      </div>`,
    );
  }

  if (args.sources && args.sources.length > 0) {
    sections.push(
      `<div style="margin:22px 0 0;">
        <p style="margin:0 0 6px;font-family:${MONO};font-size:9px;letter-spacing:2px;color:${BRAND.slate};">SOURCES CITED</p>
        <p style="margin:0;font-family:${BRAND.sans};font-size:11px;line-height:1.9;color:${BRAND.slate};">
          ${args.sources
            .map((s) => `<a href="${s.url}" style="color:${BRAND.slate};">${escapeHtml(s.title || s.url)}</a>`)
            .join(" · ")}
        </p>
      </div>`,
    );
  }

  return emailLayout(sections.join("\n"), {
    unsubscribeToken: args.unsubscribeToken,
    billingUrl: args.billingUrl,
    upgradeUrl: args.upgradeUrl,
    preparedFor: args.preparedFor,
    dateLine: args.dateLine,
  });
}
