import React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { KeyStat } from "../stats";
import type { MemoMeta } from "../memo";
import type { PageOneMemo } from "../page-one";

// Page one of the idea PDF: a one-page memo in the register of a Howard
// Marks note (John's mockup, 2026-07-07). Serif prose carries the argument;
// the chart, comps, and scenarios live in the attached full report. This
// page stopped being a dashboard.
const INK = "#111827";
const GREY = "#6b7280";
const RULE = "#d1d5db";

const S = StyleSheet.create({
  page: {
    backgroundColor: "#ffffff",
    paddingTop: 46,
    paddingBottom: 46,
    paddingHorizontal: 56,
    fontFamily: "Times-Roman",
    fontSize: 10.5,
    lineHeight: 1.5,
    color: INK,
  },
  wordmark: {
    fontFamily: "Helvetica",
    fontSize: 8,
    letterSpacing: 4,
    color: GREY,
    marginBottom: 14,
  },
  headLine: { fontSize: 11, lineHeight: 1.45 },
  headLabel: { fontFamily: "Times-Bold" },
  headRule: { borderBottomWidth: 0.75, borderBottomColor: INK, marginTop: 10, marginBottom: 8 },
  thesis: { fontFamily: "Times-Italic", fontSize: 11, lineHeight: 1.45, marginBottom: 5 },
  verdict: { fontFamily: "Helvetica", fontSize: 7.5, color: GREY, marginBottom: 8 },
  strip: {
    fontFamily: "Helvetica",
    fontSize: 7.5,
    color: INK,
    borderTopWidth: 0.5,
    borderTopColor: RULE,
    borderBottomWidth: 0.5,
    borderBottomColor: RULE,
    paddingVertical: 5,
    marginBottom: 12,
  },
  section: { marginBottom: 9 },
  body: { fontSize: 10.5, lineHeight: 1.5, textAlign: "justify" },
  lead: { fontFamily: "Times-Bold" },
  footer: {
    position: "absolute",
    bottom: 22,
    left: 56,
    right: 56,
    borderTopWidth: 0.5,
    borderTopColor: RULE,
    paddingTop: 6,
    fontFamily: "Times-Italic",
    fontSize: 6.5,
    color: GREY,
    lineHeight: 1.5,
  },
});

export interface TearSheetArgs {
  ticker: string;
  companyName?: string;
  /** Subscriber first name for the Memo to: line; null → "the desk". */
  firstName?: string | null;
  analystName: string;
  dateLine: string;
  meta?: MemoMeta | null;
  strip: KeyStat[];
  pageOne: PageOneMemo;
}

/** One titled serif paragraph — bold lead-in, justified body, Marks register. */
function Section({ title, text }: { title: string; text: string }) {
  if (!text) return null;
  return (
    <View style={S.section}>
      <Text style={S.body}>
        <Text style={S.lead}>{title}. </Text>
        {text}
      </Text>
    </View>
  );
}

export function TearSheet(args: TearSheetArgs) {
  const stripLine = args.strip.map((s) => `${s.label.toUpperCase()} ${s.value}`).join("   ·   ");
  const re = `${args.companyName ?? args.ticker} (${args.ticker})${args.pageOne.handle ? `, ${args.pageOne.handle}` : ""}`;

  return (
    <Document title={`${args.ticker} — memo`} author="Morningpick" creator="morningpick.ai">
      <Page size="A4" style={S.page}>
        <Text style={S.wordmark}>MORNINGPICK</Text>

        <Text style={S.headLine}>
          <Text style={S.headLabel}>Memo to: </Text>
          {args.firstName || "the desk"}
        </Text>
        <Text style={S.headLine}>
          <Text style={S.headLabel}>From: </Text>
          {args.analystName}, Morningpick
        </Text>
        <Text style={S.headLine}>
          <Text style={S.headLabel}>Re: </Text>
          {re}
        </Text>
        <Text style={S.headLine}>
          <Text style={S.headLabel}>Date: </Text>
          {args.dateLine}
        </Text>
        <View style={S.headRule} />

        {args.meta?.one_liner ? <Text style={S.thesis}>{args.meta.one_liner}</Text> : null}
        {args.meta && (
          <Text style={S.verdict}>
            Conviction {args.meta.conviction}/10 · Horizon {args.meta.horizon}
            {args.meta.style_tags.length ? ` · ${args.meta.style_tags.join(" · ")}` : ""}
          </Text>
        )}

        <Text style={S.strip}>{stripLine}</Text>

        <Section title="The trade" text={args.pageOne.trade} />
        <Section title="The business" text={args.pageOne.business} />
        <Section title="The valuation" text={args.pageOne.valuation} />
        <Section title="The variant view" text={args.pageOne.variant} />
        <Section title="Risks and catalyst" text={args.pageOne.risks} />

        <View style={S.footer} fixed>
          <Text>
            Full workings, the price chart, peer comparisons, scenarios, and sources: the attached
            full report. Data as of the {args.dateLine} close; balance-sheet figures as of the latest
            reported statement. Not investment advice — AI-generated, for information only, and may
            contain errors. Morningpick · morningpick.ai
          </Text>
        </View>
      </Page>
    </Document>
  );
}
