import React from "react";
import { Document, Page, Text, View, Image, Link, StyleSheet } from "@react-pdf/renderer";
import { marked, type Token, type Tokens } from "marked";
import type { MemoSource, MemoMeta } from "../memo";
import type { CompTable } from "../comp-table";

// The full written argument, as a plain professional research PDF — the same
// restrained palette as the one-pager. No masthead, no brand colours: the
// document a competent analyst hands over, not a marketing artefact.
const INK = "#111827";
const GREY = "#6b7280";
const RULE = "#d1d5db";
const RULE_LIGHT = "#e5e7eb";
const LINKC = "#274b8f";

const S = StyleSheet.create({
  page: {
    backgroundColor: "#ffffff",
    paddingTop: 44,
    paddingBottom: 60,
    paddingHorizontal: 52,
    fontFamily: "Times-Roman",
    fontSize: 10.5,
    lineHeight: 1.55,
    color: INK,
  },
  headRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  company: { fontFamily: "Times-Bold", fontSize: 17 },
  subline: { fontFamily: "Helvetica", fontSize: 8, color: GREY, marginTop: 2 },
  headDate: { fontFamily: "Helvetica", fontSize: 8, color: GREY },
  rule: { borderBottomWidth: 1, borderBottomColor: INK, marginTop: 6, marginBottom: 10 },
  verdict: { fontFamily: "Helvetica", fontSize: 8, color: GREY, marginBottom: 8 },
  oneLiner: { fontFamily: "Times-Italic", fontSize: 11.5, lineHeight: 1.4, marginBottom: 12 },
  para: { marginBottom: 9 },
  bold: { fontFamily: "Times-Bold" },
  italic: { fontFamily: "Times-Italic" },
  h: {
    fontFamily: "Helvetica-Bold",
    fontSize: 7.5,
    letterSpacing: 1.5,
    color: GREY,
    marginTop: 14,
    marginBottom: 6,
    borderTopWidth: 0.5,
    borderTopColor: RULE_LIGHT,
    paddingTop: 8,
  },
  listItem: { flexDirection: "row", marginBottom: 6, paddingLeft: 8 },
  listMarker: { width: 16, fontFamily: "Times-Bold" },
  listBody: { flex: 1 },
  sourceLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 7,
    letterSpacing: 1.5,
    color: GREY,
    marginTop: 16,
    marginBottom: 6,
  },
  sourceLine: { marginBottom: 3, fontFamily: "Helvetica", fontSize: 7.5, color: GREY },
  compTr: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: RULE_LIGHT,
    paddingVertical: 3.5,
  },
  compTh: { fontFamily: "Helvetica-Bold", fontSize: 6.5, letterSpacing: 0.5, color: GREY },
  footer: {
    position: "absolute",
    bottom: 22,
    left: 52,
    right: 52,
    borderTopWidth: 0.5,
    borderTopColor: RULE,
    paddingTop: 6,
    fontFamily: "Helvetica",
    fontSize: 6,
    color: GREY,
    lineHeight: 1.5,
  },
});

export interface FullReportArgs {
  markdown: string;
  ticker: string;
  companyName?: string;
  sector?: string;
  dateLine?: string;
  meta?: MemoMeta | null;
  sources?: MemoSource[];
  // Full workings that moved off page one (the memo page): chart, comps,
  // scenarios. Page one carries the argument; this report carries the data.
  chartUrl?: string | null;
  compTable?: CompTable | null;
}

/** Truncate a company NAME if needed — never the ticker. Corporate suffixes
 * go first: "Caledonia Mining Corporation Plc" reads as "Caledonia Mining". */
function compRowLabel(name: string, ticker: string): string {
  let clean = name;
  if (clean.length > 26) {
    clean = clean
      .replace(/[,.]?\s+(PLC|Plc|plc|Ltd\.?|Limited|Corporation|Corp\.?|Inc\.?|Incorporated|S\.?A\.?|AG|NV|N\.V\.|SE|ASA|AB|Oyj|SpA|S\.p\.A\.)\.?\s*$/g, "")
      .replace(/[,.]?\s+(PLC|Plc|plc|Ltd\.?|Limited|Corporation|Corp\.?|Inc\.?)\.?\s*$/g, "")
      .trim();
  }
  const trimmed = clean.length > 26 ? `${clean.slice(0, 25).trimEnd()}…` : clean;
  return `${trimmed} (${ticker})`;
}

/** Render inline markdown tokens (bold/em/links/text) into nested Text. */
function inline(tokens: Token[] | undefined, keyPrefix: string): React.ReactNode[] {
  if (!tokens) return [];
  return tokens.map((t, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (t.type) {
      case "strong":
        return (
          <Text key={key} style={S.bold}>
            {inline((t as Tokens.Strong).tokens, key)}
          </Text>
        );
      case "em":
        return (
          <Text key={key} style={S.italic}>
            {inline((t as Tokens.Em).tokens, key)}
          </Text>
        );
      case "link":
        return (
          <Link key={key} src={(t as Tokens.Link).href} style={{ color: LINKC }}>
            {inline((t as Tokens.Link).tokens, key)}
          </Link>
        );
      case "codespan":
        return <Text key={key}>{(t as Tokens.Codespan).text}</Text>;
      default:
        return <Text key={key}>{"text" in t ? (t as Tokens.Text).text : ""}</Text>;
    }
  });
}

function blocks(markdown: string): React.ReactNode[] {
  const tokens = marked.lexer(markdown);
  const out: React.ReactNode[] = [];
  tokens.forEach((token, i) => {
    switch (token.type) {
      case "heading":
        if (token.depth === 1) return; // the H1 is the document title
        out.push(
          <Text key={i} style={S.h}>
            {token.text.toUpperCase()}
          </Text>,
        );
        return;
      case "paragraph":
        out.push(
          <Text key={i} style={S.para}>
            {inline(token.tokens, `p-${i}`)}
          </Text>,
        );
        return;
      case "list": {
        const list = token as Tokens.List;
        list.items.forEach((item, j) => {
          const marker = list.ordered ? `${(Number(list.start) || 1) + j}.` : "•";
          const itemTokens =
            item.tokens?.flatMap((t) =>
              t.type === "text" || t.type === "paragraph"
                ? ((t as Tokens.Text).tokens ?? [t])
                : [t],
            ) ?? [];
          out.push(
            <View key={`${i}-${j}`} style={S.listItem}>
              <Text style={S.listMarker}>{marker}</Text>
              <Text style={S.listBody}>{inline(itemTokens, `li-${i}-${j}`)}</Text>
            </View>,
          );
        });
        return;
      }
      default:
        return;
    }
  });
  return out;
}

/**
 * The full research note as an attached PDF — the complete argument, with the
 * arithmetic and sources the email cover note deliberately leaves out.
 */
export function FullReport(args: FullReportArgs) {
  const lexed = marked.lexer(args.markdown);
  const h1 = lexed.find((t) => t.type === "heading" && (t as Tokens.Heading).depth === 1) as
    | Tokens.Heading
    | undefined;
  const title = h1?.text ?? args.companyName ?? args.ticker;
  const subline = [args.ticker, args.sector].filter(Boolean).join("  ·  ");

  return (
    <Document title={title} author="Morningpick" creator="morningpick.ai">
      <Page size="A4" style={S.page}>
        <View style={S.headRow}>
          <View>
            <Text style={S.company}>{args.companyName ?? args.ticker}</Text>
            {subline ? <Text style={S.subline}>{subline}</Text> : null}
          </View>
          <Text style={S.headDate}>{args.dateLine}</Text>
        </View>
        <View style={S.rule} />

        {args.meta && (
          <Text style={S.verdict}>
            Conviction {args.meta.conviction}/10 · Horizon {args.meta.horizon}
            {args.meta.style_tags.length ? ` · ${args.meta.style_tags.join(" · ")}` : ""}
          </Text>
        )}
        {args.meta?.one_liner && <Text style={S.oneLiner}>{args.meta.one_liner}</Text>}

        {blocks(args.markdown)}

        {args.chartUrl && (
          <>
            <Text style={S.h}>SHARE PRICE — 5 YEARS</Text>
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            <Image src={args.chartUrl} style={{ marginTop: 2, borderWidth: 0.5, borderColor: RULE_LIGHT }} />
          </>
        )}

        {args.compTable && args.compTable.rows.length > 0 && (
          <>
            <Text style={S.h}>VALUATION VS PEERS — {args.compTable.groupLabel.toUpperCase()}</Text>
            <View style={[S.compTr, { borderBottomWidth: 0.75, borderBottomColor: INK }]}>
              <Text style={[S.compTh, { flex: 2.4 }]}> </Text>
              {args.compTable.columns.map((c) => (
                <Text key={c.key} style={[S.compTh, { flex: 1, textAlign: "right" }]}>
                  {c.label.toUpperCase()}
                </Text>
              ))}
            </View>
            {args.compTable.rows.map((r, i) => (
              <View key={i} style={S.compTr}>
                <View style={{ flex: 2.4 }}>
                  <Text
                    style={{
                      fontFamily: r.self ? "Helvetica-Bold" : "Helvetica",
                      fontSize: 8,
                      color: r.self ? INK : GREY,
                    }}
                  >
                    {/* Footnote marker sits INLINE, right after the ticker. */}
                    {compRowLabel(r.name, r.ticker)}
                    {r.marker ? ` ${r.marker}` : ""}
                  </Text>
                  {r.tag ? (
                    <Text style={{ fontFamily: "Helvetica", fontSize: 6, color: GREY, marginTop: 1 }}>{r.tag}</Text>
                  ) : null}
                </View>
                {r.cells.map((v, j) => (
                  <Text
                    key={j}
                    style={{
                      flex: 1,
                      textAlign: "right",
                      fontFamily: r.self ? "Helvetica-Bold" : "Helvetica",
                      fontSize: 8,
                      color: r.self ? INK : GREY,
                    }}
                  >
                    {v}
                  </Text>
                ))}
              </View>
            ))}
            {args.compTable.rationales.length > 0 && (
              <Text style={{ fontFamily: "Times-Roman", fontSize: 8.5, color: INK, marginTop: 6, lineHeight: 1.45 }}>
                <Text style={{ fontFamily: "Times-Bold" }}>Why each belongs: </Text>
                {args.compTable.rationales.join(" ")}
              </Text>
            )}
            {args.compTable.footnotes.length > 0 && (
              <View style={{ marginTop: 4 }}>
                {args.compTable.footnotes.map((f, i) => (
                  <Text key={i} style={{ fontFamily: "Helvetica", fontSize: 5.5, color: GREY, lineHeight: 1.5 }}>
                    {f}
                  </Text>
                ))}
              </View>
            )}
          </>
        )}

        {args.meta?.scenarios && (
          <>
            <Text style={S.h}>SCENARIOS</Text>
            {([
              ["Bear", args.meta.scenarios.bear],
              ["Base", args.meta.scenarios.base],
              ["Bull", args.meta.scenarios.bull],
            ] as const)
              .filter(([, v]) => v)
              .map(([tag, v], i) => (
                <View key={i} style={{ flexDirection: "row", marginBottom: 5 }}>
                  <Text style={{ width: 36, fontFamily: "Helvetica-Bold", fontSize: 8.5 }}>{tag}</Text>
                  <Text style={{ flex: 1, fontFamily: "Times-Roman", fontSize: 9.5, lineHeight: 1.35 }}>{v}</Text>
                </View>
              ))}
          </>
        )}

        {args.sources && args.sources.length > 0 && (
          <View>
            <Text style={S.sourceLabel}>SOURCES</Text>
            {args.sources.map((s, i) => (
              <Text key={i} style={S.sourceLine}>
                <Link src={s.url} style={{ color: GREY }}>
                  {s.title || s.url}
                </Link>
              </Text>
            ))}
          </View>
        )}

        <View style={S.footer} fixed>
          <Text>
            Not investment advice. This note is AI-generated research, for information only, and may
            contain errors. Figures are drawn from company filings and market data as of the date
            above; always do your own research. Morningpick · morningpick.ai
          </Text>
        </View>
      </Page>
    </Document>
  );
}
