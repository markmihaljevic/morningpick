import React from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { config } from "./config";
import { TearSheet } from "./pdf/tear-sheet";
import { buildKeyStats } from "./stats";
import { buildCompsRows } from "./comps";
import { buildFiveYearChartUrl } from "./chart";
import type { TickerData } from "./fmp";
import type { MemoMeta } from "./memo";

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
}): Promise<Buffer | null> {
  try {
    const currency = ((): string | undefined => {
      const p = Array.isArray(args.data.profile) ? args.data.profile[0] : args.data.profile;
      return (p as { currency?: string } | undefined)?.currency;
    })();
    const chartUrl = await buildFiveYearChartUrl(args.ticker, currency);
    const buffer = await renderToBuffer(
      // TearSheet returns a <Document>; createElement can't see that through the fn type.
      React.createElement(TearSheet, {
        ticker: args.ticker,
        companyName: args.companyName,
        dateLine: args.dateLine,
        preparedFor: args.preparedFor,
        meta: args.meta,
        stats: buildKeyStats(args.data),
        comps: buildCompsRows(args.ticker, args.data),
        chartUrl,
        postalAddress: config().POSTAL_ADDRESS,
      }) as React.ReactElement<DocumentProps>,
    );
    return Buffer.from(buffer);
  } catch (e) {
    console.error(`Tear sheet build failed for ${args.ticker} (sending without it):`, e);
    return null;
  }
}
