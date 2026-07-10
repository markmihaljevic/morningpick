import React from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { TearSheet } from "./pdf/tear-sheet";
import { buildStatStrip } from "./stats";
import { buildComputedFigures, buildSnapshot } from "./figures";
import { writePageOneMemo } from "./page-one";
import { config } from "./config";
import type { TickerData } from "./fmp";
import type { MemoMeta, MemoSource } from "./memo";

/**
 * Build page one of the idea PDF: the one-page memo (header block, thesis,
 * stat strip, five serif sections) distilled from the verified full note.
 * Returns null on any failure — including a page-one draft that cannot pass
 * its own fact-check — so a bad page never blocks or pollutes the send; the
 * verified full report still ships.
 */
export async function buildTearSheet(args: {
  ticker: string;
  companyName?: string;
  firstName?: string | null;
  dateLine: string;
  data: TickerData;
  meta: MemoMeta | null;
  fullNoteMarkdown: string;
  verifySources?: MemoSource[];
}): Promise<Buffer | null> {
  try {
    const p = (Array.isArray(args.data.profile) ? args.data.profile[0] : args.data.profile) as
      | { industry?: string; exchange?: string; exchangeShortName?: string }
      | undefined;
    const [strip, figures, snapshot] = await Promise.all([
      buildStatStrip(args.data),
      buildComputedFigures(args.data),
      buildSnapshot(args.data),
    ]);
    const pageOne = await writePageOneMemo({
      fullNoteMarkdown: args.fullNoteMarkdown,
      ticker: args.ticker,
      companyName: args.companyName,
      industry: p?.industry,
      exchange: p?.exchange ?? p?.exchangeShortName,
      balanceSheetDate: snapshot.balanceSheetDate,
      strip,
      figures,
      data: args.data,
      verifySources: args.verifySources ?? [],
    });
    if (!pageOne) {
      console.warn(`No page-one memo for ${args.ticker}; sending the full report alone.`);
      return null;
    }
    const buffer = await renderToBuffer(
      // TearSheet returns a <Document>; createElement can't see that through the fn type.
      React.createElement(TearSheet, {
        ticker: args.ticker,
        companyName: args.companyName,
        firstName: args.firstName ?? null,
        analystName: config().ANALYST_NAME,
        dateLine: args.dateLine,
        meta: args.meta,
        strip,
        pageOne,
      }) as React.ReactElement<DocumentProps>,
    );
    return Buffer.from(buffer);
  } catch (e) {
    console.error(`Tear sheet build failed for ${args.ticker} (sending without it):`, e);
    return null;
  }
}
