import React from "react";
import { Document, Page, Text, View, Image, StyleSheet } from "@react-pdf/renderer";
import { BRAND } from "../brand";
import type { KeyStat } from "../stats";
import type { CompsRow } from "../comps";
import type { MemoMeta } from "../memo";

const S = StyleSheet.create({
  page: {
    backgroundColor: "#FFFFFF",
    paddingTop: 44,
    paddingBottom: 56,
    paddingHorizontal: 48,
    fontFamily: "Helvetica",
    fontSize: 9,
    color: BRAND.ink,
  },
  masthead: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 32,
    backgroundColor: BRAND.ink,
    borderBottomWidth: 2,
    borderBottomColor: BRAND.gold,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 48,
  },
  wordmark: { fontFamily: "Helvetica-Bold", fontSize: 9, letterSpacing: 3, color: "#FBFAF6" },
  mastRight: { fontFamily: "Helvetica", fontSize: 6.5, letterSpacing: 1.5, color: "#8FA0B0" },
  kicker: { fontFamily: "Helvetica", fontSize: 6.5, letterSpacing: 1.5, color: BRAND.slate, marginTop: 4 },
  title: { fontFamily: "Times-Bold", fontSize: 17, marginTop: 8 },
  company: { fontFamily: "Helvetica", fontSize: 9, color: BRAND.slate, marginTop: 2, marginBottom: 10 },
  chips: { flexDirection: "row", gap: 5, marginBottom: 10 },
  chip: { borderWidth: 0.75, borderColor: BRAND.rule, paddingVertical: 3, paddingHorizontal: 6 },
  chipGold: { borderColor: BRAND.gold, backgroundColor: "#FAF3E3" },
  chipLabel: { fontSize: 4.5, letterSpacing: 1, color: BRAND.slate },
  chipValue: { fontFamily: "Helvetica-Bold", fontSize: 8, marginTop: 1 },
  oneLiner: {
    fontFamily: "Times-Italic",
    fontSize: 11,
    borderLeftWidth: 2,
    borderLeftColor: BRAND.gold,
    paddingLeft: 8,
    paddingVertical: 3,
    marginBottom: 14,
  },
  sectionLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 7,
    letterSpacing: 2,
    color: BRAND.gold,
    marginTop: 14,
    marginBottom: 6,
    borderTopWidth: 0.75,
    borderTopColor: BRAND.rule,
    paddingTop: 8,
  },
  statsRow: { flexDirection: "row" },
  statCell: { flex: 1, borderWidth: 0.75, borderColor: BRAND.rule, paddingVertical: 5, paddingHorizontal: 6 },
  statLabel: { fontSize: 5, letterSpacing: 1, color: BRAND.slate },
  statValue: { fontFamily: "Helvetica-Bold", fontSize: 10, marginTop: 2 },
  chart: { marginTop: 4, borderWidth: 0.75, borderColor: BRAND.rule },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: BRAND.rule, paddingVertical: 3 },
  th: { fontFamily: "Helvetica-Bold", fontSize: 6, letterSpacing: 1, color: BRAND.slate },
  scenarioRow: { flexDirection: "row", marginBottom: 5 },
  scenarioTag: { width: 34, fontFamily: "Helvetica-Bold", fontSize: 8 },
  scenarioText: { flex: 1, fontFamily: "Times-Roman", fontSize: 9.5, lineHeight: 1.35 },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 48,
    right: 48,
    borderTopWidth: 0.75,
    borderTopColor: BRAND.rule,
    paddingTop: 6,
    fontSize: 5.5,
    color: BRAND.slate,
    lineHeight: 1.5,
  },
});

export interface TearSheetArgs {
  ticker: string;
  companyName?: string;
  dateLine: string;
  preparedFor?: string;
  meta?: MemoMeta | null;
  stats: KeyStat[];
  comps: CompsRow[];
  chartUrl?: string | null;
  postalAddress: string;
}

/**
 * The one-page tear sheet — the analyst's model, attached. Everything visual
 * that would clutter the prose email (chart, key stats, peer comps, the
 * scenario math) lives here instead, at a glance.
 */
export function TearSheet(args: TearSheetArgs) {
  const half = Math.ceil(args.stats.length / 2);
  const scen = args.meta?.scenarios;

  return (
    <Document title={`${args.ticker} — tear sheet`} author="Morningpick" creator="morningpick.ai">
      <Page size="A4" style={S.page}>
        <View style={S.masthead} fixed>
          <Text style={S.wordmark}>MORNINGPICK</Text>
          <Text style={S.mastRight}>TEAR SHEET · {args.dateLine.toUpperCase()}</Text>
        </View>

        {args.preparedFor && (
          <Text style={S.kicker}>THE WORKUP BEHIND THIS MORNING&apos;S NOTE · FOR {args.preparedFor.toUpperCase()}</Text>
        )}
        <Text style={S.title}>{args.ticker}</Text>
        {args.companyName && <Text style={S.company}>{args.companyName}</Text>}

        {args.meta && (
          <View style={S.chips}>
            {[
              ["CONVICTION", `${args.meta.conviction}/10`, true],
              ["HORIZON", args.meta.horizon.toUpperCase(), false],
              ...args.meta.style_tags.map((t) => ["STYLE", t.toUpperCase(), false] as const),
            ].map(([label, value, gold], i) => (
              <View key={i} style={gold ? [S.chip, S.chipGold] : S.chip}>
                <Text style={S.chipLabel}>{label}</Text>
                <Text style={S.chipValue}>{value}</Text>
              </View>
            ))}
          </View>
        )}

        {args.meta?.one_liner && <Text style={S.oneLiner}>{args.meta.one_liner}</Text>}

        {args.stats.length > 0 && (
          <>
            <Text style={S.sectionLabel}>KEY FIGURES</Text>
            <View style={S.statsRow}>
              {args.stats.slice(0, half).map((s, i) => (
                <View key={i} style={S.statCell}>
                  <Text style={S.statLabel}>{s.label.toUpperCase()}</Text>
                  <Text style={S.statValue}>{s.value}</Text>
                </View>
              ))}
            </View>
            {args.stats.length > half && (
              <View style={S.statsRow}>
                {args.stats.slice(half).map((s, i) => (
                  <View key={i} style={S.statCell}>
                    <Text style={S.statLabel}>{s.label.toUpperCase()}</Text>
                    <Text style={S.statValue}>{s.value}</Text>
                  </View>
                ))}
              </View>
            )}
          </>
        )}

        {args.chartUrl && (
          <>
            <Text style={S.sectionLabel}>FIVE YEARS</Text>
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            <Image src={args.chartUrl} style={S.chart} />
          </>
        )}

        {args.comps.length > 0 && (
          <>
            <Text style={S.sectionLabel}>VERSUS PEERS</Text>
            <View style={[S.tr, { borderBottomWidth: 0.75, borderBottomColor: BRAND.ink }]}>
              <Text style={[S.th, { flex: 2 }]}> </Text>
              {["P/E", "EV/EBITDA", "P/B", "P/S"].map((h) => (
                <Text key={h} style={[S.th, { flex: 1, textAlign: "right" }]}>
                  {h}
                </Text>
              ))}
            </View>
            {args.comps.map((r, i) => (
              <View key={i} style={S.tr}>
                <Text
                  style={{
                    flex: 2,
                    fontFamily: r.self ? "Helvetica-Bold" : "Helvetica",
                    fontSize: 8.5,
                    color: r.self ? BRAND.ink : BRAND.slate,
                  }}
                >
                  {r.label}
                </Text>
                {[r.pe, r.evEbitda, r.pb, r.ps].map((v, j) => (
                  <Text
                    key={j}
                    style={{
                      flex: 1,
                      textAlign: "right",
                      fontFamily: r.self ? "Helvetica-Bold" : "Helvetica",
                      fontSize: 8.5,
                      color: r.self ? BRAND.ink : BRAND.slate,
                    }}
                  >
                    {v}
                  </Text>
                ))}
              </View>
            ))}
          </>
        )}

        {scen && (
          <>
            <Text style={S.sectionLabel}>SCENARIOS</Text>
            {([
              ["Bear", scen.bear],
              ["Base", scen.base],
              ["Bull", scen.bull],
            ] as const)
              .filter(([, v]) => v)
              .map(([tag, v], i) => (
                <View key={i} style={S.scenarioRow}>
                  <Text style={S.scenarioTag}>{tag}</Text>
                  <Text style={S.scenarioText}>{v}</Text>
                </View>
              ))}
          </>
        )}

        <View style={S.footer} fixed>
          <Text>
            The tear sheet is the data behind the note in your inbox — read the note for the
            argument. Not investment advice; AI-generated, may contain errors; do your own research.
            {" "}
            {args.postalAddress} · morningpick.ai
          </Text>
        </View>
      </Page>
    </Document>
  );
}
