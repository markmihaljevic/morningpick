import React from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { TearSheet } from "./pdf/tear-sheet";
import { buildKeyStats } from "./stats";
import { buildFiveYearChartUrl } from "./chart";
import type { TickerData } from "./fmp";
import type { MemoMeta } from "./memo";
import type { CompTable } from "./comp-table";

/**
 * Build the one-page tear-sheet PDF for a note: key figures, 5-year chart,
 * peer comps, and the scenario math. Returns null on any failure so a bad
 * attachment never blocks the note itself.
 */
export async function buildTearSheet(args: {
  ticker: string;
  companyName?: string;
  dateLine: string;
  preparedFor?: string;
  data: TickerData;
  meta: MemoMeta | null;
  /** Built once per note and shared with the writer — same table everywhere. */
  compTable?: CompTable | null;
}): Promise<Buffer | null> {
  try {
    const p = (Array.isArray(args.data.profile) ? args.data.profile[0] : args.data.profile) as
      | { currency?: string; description?: string; sector?: string; industry?: string }
      | undefined;
    const currency = p?.currency;
    const rawDescr = (p?.description ?? "").trim();
    // First two sentences, capped — enough to say what the business is.
    const companyDescription =
      rawDescr
        .split(/(?<=[.!?])\s+/)
        .slice(0, 2)
        .join(" ")
        .slice(0, 300) || undefined;
    const sector = p?.sector || p?.industry || undefined;
    const [chartUrl, stats] = await Promise.all([
      buildFiveYearChartUrl(args.ticker, currency),
      buildKeyStats(args.data),
    ]);
    const buffer = await renderToBuffer(
      // TearSheet returns a <Document>; createElement can't see that through the fn type.
      React.createElement(TearSheet, {
        ticker: args.ticker,
        companyName: args.companyName,
        companyDescription,
        sector,
        dateLine: args.dateLine,
        meta: args.meta,
        stats,
        compTable: args.compTable ?? null,
        chartUrl,
      }) as React.ReactElement<DocumentProps>,
    );
    return Buffer.from(buffer);
  } catch (e) {
    console.error(`Tear sheet build failed for ${args.ticker} (sending without it):`, e);
    return null;
  }
}
