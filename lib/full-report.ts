import React from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { FullReport } from "./pdf/full-report";
import type { TickerData } from "./fmp";
import type { MemoMeta, MemoSource } from "./memo";

/**
 * Build the full-report PDF for a note: the complete written argument, with
 * the arithmetic and sources the email cover note leaves out. Returns null on
 * any failure so a bad attachment never blocks the note itself.
 */
export async function buildFullReport(args: {
  markdown: string;
  ticker: string;
  companyName?: string;
  dateLine: string;
  data: TickerData;
  meta: MemoMeta | null;
  sources?: MemoSource[];
}): Promise<Buffer | null> {
  try {
    const p = (Array.isArray(args.data.profile) ? args.data.profile[0] : args.data.profile) as
      | { sector?: string; industry?: string }
      | undefined;
    const sector = p?.sector || p?.industry || undefined;
    const buffer = await renderToBuffer(
      React.createElement(FullReport, {
        markdown: args.markdown,
        ticker: args.ticker,
        companyName: args.companyName,
        sector,
        dateLine: args.dateLine,
        meta: args.meta,
        sources: args.sources,
      }) as React.ReactElement<DocumentProps>,
    );
    return Buffer.from(buffer);
  } catch (e) {
    console.error(`Full report build failed for ${args.ticker} (sending without it):`, e);
    return null;
  }
}
