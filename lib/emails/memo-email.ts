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
  profileUrl?: string;
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
  // A typed memo's heading: bold serif, sentence case, no chrome.
  const title = text.charAt(0) + text.slice(1).toLowerCase();
  return `<h3 style="font-family:${BRAND.serif};font-size:17px;line-height:1.4;margin:26px 0 8px;color:${BRAND.ink};font-weight:700;">${title}</h3>`;
}

/** The memo email — the Morningpick research note. */
export function renderMemoEmail(args: MemoEmailArgs): string {
  const html = marked.parse(args.markdown, { async: false }) as string;
  const styled = html
    .replace(
      /<h1>/g,
      `<p style="margin:0 0 18px;">Good morning,</p><h1 style="font-family:${BRAND.serif};font-size:20px;line-height:1.4;margin:0 0 14px;font-weight:700;color:${BRAND.ink};">`,
    )
    .replace(/<h2>([\s\S]*?)<\/h2>/g, (_, inner: string) => sectionLabel(inner))
    .replace(/<h3>/g, `<h3 style="font-size:17px;line-height:1.4;margin:22px 0 6px;color:${BRAND.ink};">`)
    .replace(/<p>/g, '<p style="margin:0 0 15px;">')
    .replace(/<ol>/g, '<ol style="margin:0 0 15px;padding-left:22px;">')
    .replace(/<ul>/g, '<ul style="margin:0 0 15px;padding-left:22px;">')
    .replace(/<li>/g, '<li style="margin:0 0 8px;">')
    .replace(/<strong>/g, `<strong style="color:${BRAND.ink};">`)
    .replace(/<a href=/g, `<a style="color:${BRAND.ink};text-decoration:underline;text-decoration-color:#C9CFD4;" href=`);

  const sections: string[] = [];

  if (args.firstNote) {
    sections.push(
      `<p style="margin:0 0 18px;font-style:italic;color:${BRAND.slate};font-size:14.5px;">A word before we start: this is your first note, written before I know you. Reply and tell me how you invest — everything from here on adapts.</p>`,
    );
  }

  // ── Header block, injected after the H1 ─────────────────────────────────
  const headerParts: string[] = [];

  // Verdict strip: one dark bar, not a row of boxes.
  if (args.meta) {
    const parts = [
      `CONVICTION <span style="color:${BRAND.ink};font-weight:700;">${args.meta.conviction}/10</span>`,
      `HORIZON <span style="color:${BRAND.ink};">${escapeHtml(args.meta.horizon.toUpperCase())}</span>`,
      ...args.meta.style_tags.map(
        (t) => `<span style="color:${BRAND.ink};">${escapeHtml(t.toUpperCase())}</span>`,
      ),
    ].map((p) => `<span style="white-space:nowrap;">${p}</span>`);
    headerParts.push(
      `<p style="margin:0 0 14px;font-family:${MONO};font-size:10px;letter-spacing:1px;line-height:2;color:${BRAND.slate};">${parts.join('<span style="color:${BRAND.rule};">&nbsp;·&nbsp;</span>')}</p>`,
    );
  }

  if (args.meta?.one_liner) {
    headerParts.push(
      `<p style="margin:0 0 18px;font-family:${BRAND.serif};font-size:16.5px;font-style:italic;color:${BRAND.ink};line-height:1.55;">${escapeHtml(args.meta.one_liner)}</p>`,
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
      `<div style="margin:26px 0 0;">
        ${sectionLabel("Worth your time")}
        ${args.primarySources
          .map(
            (s) =>
              `<p style="margin:0 0 10px;font-size:15px;"><a href="${s.url}" style="color:${BRAND.ink};font-weight:700;">${escapeHtml(s.title)}</a> <span style="font-family:${MONO};font-size:9px;letter-spacing:1px;color:${BRAND.slate};">${SOURCE_TYPE_LABEL[s.type]}</span><br/><span style="font-family:${BRAND.sans};font-size:12.5px;color:${BRAND.slate};">${escapeHtml(s.note)}</span></p>`,
          )
          .join("\n")}
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

  // The sign-off: a letter ends with a person, not a button.
  sections.push(
    `<p style="margin:26px 0 0;">— Your analyst</p>${
      args.pdfUrl
        ? `<p style="margin:14px 0 0;font-family:${BRAND.sans};font-size:12.5px;"><a href="${args.pdfUrl}" style="color:${BRAND.slate};">Keep the PDF ↧</a></p>`
        : ""
    }`,
  );

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
    profileUrl: args.profileUrl,
    preparedFor: args.preparedFor,
    dateLine: args.dateLine,
  });
}
