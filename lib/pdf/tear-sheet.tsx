import React from "react";
import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";
import type { KeyStat } from "../stats";
import type { CompTable } from "../comp-table";
import type { MemoMeta } from "../memo";

// A restrained, professional palette — no brand colours. Reads like a broker
// fact sheet, not a marketing one-pager.
const INK = "#111827";
const GREY = "#6b7280";
const RULE = "#d1d5db";
const RULE_LIGHT = "#e5e7eb";

const S = StyleSheet.create({
  page: {
    backgroundColor: "#ffffff",
    paddingTop: 40,
    paddingBottom: 46,
    paddingHorizontal: 46,
    fontFamily: "Helvetica",
    fontSize: 9,
    color: INK,
  },
  headRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end" },
  company: { fontFamily: "Times-Bold", fontSize: 16 },
  subline: { fontFamily: "Helvetica", fontSize: 8, color: GREY, marginTop: 2 },
  headDate: { fontFamily: "Helvetica", fontSize: 8, color: GREY },
  rule: { borderBottomWidth: 1, borderBottomColor: INK, marginTop: 6, marginBottom: 10 },
  descr: { fontFamily: "Times-Roman", fontSize: 9.5, lineHeight: 1.4, marginBottom: 10, color: "#374151" },
  callLine: { fontFamily: "Times-Italic", fontSize: 11, lineHeight: 1.4, marginBottom: 4 },
  verdict: { fontFamily: "Helvetica", fontSize: 8, color: GREY, marginBottom: 14 },
  h: {
    fontFamily: "Helvetica-Bold",
    fontSize: 7.5,
    letterSpacing: 1.5,
    color: GREY,
    marginTop: 15,
    marginBottom: 5,
  },
  statsWrap: { flexDirection: "row", flexWrap: "wrap" },
  statCell: {
    width: "25%",
    borderTopWidth: 0.5,
    borderTopColor: RULE_LIGHT,
    paddingVertical: 5,
    paddingRight: 8,
  },
  statLabel: { fontSize: 6, letterSpacing: 0.5, color: GREY },
  statValue: { fontFamily: "Helvetica-Bold", fontSize: 11, marginTop: 2 },
  chart: { marginTop: 2, borderWidth: 0.5, borderColor: RULE_LIGHT },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: RULE_LIGHT, paddingVertical: 3.5 },
  th: { fontFamily: "Helvetica-Bold", fontSize: 6.5, letterSpacing: 0.5, color: GREY },
  scRow: { flexDirection: "row", marginBottom: 5 },
  scTag: { width: 36, fontFamily: "Helvetica-Bold", fontSize: 8.5 },
  scText: { flex: 1, fontFamily: "Times-Roman", fontSize: 9.5, lineHeight: 1.35 },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 46,
    right: 46,
    borderTopWidth: 0.5,
    borderTopColor: RULE,
    paddingTop: 6,
    fontSize: 6,
    color: GREY,
    lineHeight: 1.5,
  },
});

export interface TearSheetArgs {
  ticker: string;
  companyName?: string;
  companyDescription?: string;
  sector?: string;
  dateLine: string;
  meta?: MemoMeta | null;
  stats: KeyStat[];
  compTable?: CompTable | null;
  chartUrl?: string | null;
}

/** Truncate a company NAME if needed — never the ticker (John's rule 1).
 * Corporate suffixes go first: "Caledonia Mining Corporation Plc" reads
 * better as "Caledonia Mining" than as "Caledonia Mining Corporat…". */
function rowLabel(name: string, ticker: string): string {
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

/**
 * A one-page company fact sheet — the workup behind the morning note.
 * Deliberately plain and professional: the kind of tear sheet a competent
 * analyst assembles, not a branded artefact.
 */
export function TearSheet(args: TearSheetArgs) {
  const scen = args.meta?.scenarios;
  const subline = [args.ticker, args.sector].filter(Boolean).join("  ·  ");

  return (
    <Document title={`${args.ticker} — fact sheet`} author="Morningpick" creator="morningpick.ai">
      <Page size="A4" style={S.page}>
        <View style={S.headRow}>
          <View>
            <Text style={S.company}>{args.companyName ?? args.ticker}</Text>
            {subline ? <Text style={S.subline}>{subline}</Text> : null}
          </View>
          <Text style={S.headDate}>{args.dateLine}</Text>
        </View>
        <View style={S.rule} />

        {args.companyDescription ? <Text style={S.descr}>{args.companyDescription}</Text> : null}

        {args.meta?.one_liner && <Text style={S.callLine}>{args.meta.one_liner}</Text>}
        {args.meta && (
          <Text style={S.verdict}>
            Conviction {args.meta.conviction}/10 · Horizon {args.meta.horizon}
            {args.meta.style_tags.length ? ` · ${args.meta.style_tags.join(" · ")}` : ""}
          </Text>
        )}

        {args.stats.length > 0 && (
          <>
            <Text style={S.h}>KEY FIGURES</Text>
            <View style={S.statsWrap}>
              {args.stats.map((s, i) => (
                <View key={i} style={S.statCell}>
                  <Text style={S.statLabel}>{s.label.toUpperCase()}</Text>
                  <Text style={S.statValue}>{s.value}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {args.chartUrl && (
          <>
            <Text style={S.h}>SHARE PRICE — 5 YEARS</Text>
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            <Image src={args.chartUrl} style={S.chart} />
          </>
        )}

        {args.compTable && args.compTable.rows.length > 0 && (
          <>
            <Text style={S.h}>VALUATION VS PEERS — {args.compTable.groupLabel.toUpperCase()}</Text>
            <View style={[S.tr, { borderBottomWidth: 0.75, borderBottomColor: INK }]}>
              <Text style={[S.th, { flex: 2.4 }]}> </Text>
              {args.compTable.columns.map((c) => (
                <Text key={c.key} style={[S.th, { flex: 1, textAlign: "right" }]}>
                  {c.label.toUpperCase()}
                </Text>
              ))}
            </View>
            {args.compTable.rows.map((r, i) => (
              <View key={i} style={S.tr}>
                <View style={{ flex: 2.4 }}>
                  <Text
                    style={{
                      fontFamily: r.self ? "Helvetica-Bold" : "Helvetica",
                      fontSize: 8,
                      color: r.self ? INK : GREY,
                    }}
                  >
                    {rowLabel(r.name, r.ticker)}
                  </Text>
                  {r.tag ? (
                    <Text style={{ fontSize: 6, color: GREY, marginTop: 1 }}>{r.tag}</Text>
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
            {args.compTable.footnotes.length > 0 && (
              <Text style={{ fontSize: 5.5, color: GREY, marginTop: 3, lineHeight: 1.5 }}>
                {args.compTable.footnotes.join("  ·  ")}
              </Text>
            )}
          </>
        )}

        {scen && (
          <>
            <Text style={S.h}>SCENARIOS</Text>
            {([
              ["Bear", scen.bear],
              ["Base", scen.base],
              ["Bull", scen.bull],
            ] as const)
              .filter(([, v]) => v)
              .map(([tag, v], i) => (
                <View key={i} style={S.scRow}>
                  <Text style={S.scTag}>{tag}</Text>
                  <Text style={S.scText}>{v}</Text>
                </View>
              ))}
          </>
        )}

        <View style={S.footer} fixed>
          <Text>
            Sources: company filings and market data. The argument is in the accompanying note; this
            sheet is the underlying data. Not investment advice — for information only, may contain
            errors. Morningpick · morningpick.ai
          </Text>
        </View>
      </Page>
    </Document>
  );
}
