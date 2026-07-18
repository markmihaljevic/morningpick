import React from "react";
import { renderToBuffer, type DocumentProps } from "@react-pdf/renderer";
import { TearSheet } from "./pdf/tear-sheet";
import { buildStatStrip } from "./stats";
import { buildComputedFigures, buildSnapshot } from "./figures";
import { snapshotReconcileInputs } from "./reconcile";
import { writePageOneMemo } from "./page-one";
import { config } from "./config";
import type { TickerData } from "./fmp";
import type { MemoMeta, MemoSource } from "./memo";
import type { HoldcoContext } from "./holdco";

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
  /** The comp table's prompt block — verification ground truth if a peer
   * figure slips onto the page (which the structural gate also bans). */
  peerComps?: string;
  /** The JUDGMENT-PICKED peers actually discussed in the note — the page-one
   * no-peer-names gate scans THESE (data.peers is dead; scanning the old
   * screen list would wave through every real peer). */
  peers?: { symbol: string; name: string }[];
  /** Investment-holdco NAV frame (July 17): NAV-led strip, and the page-one
   * fact-check gets the computed bridge as ground truth. */
  holdco?: HoldcoContext | null;
  /** July 18 rule 4: the desk's one conviction — every N/10 on the page must
   * equal it; figures must reconcile to the equity snapshot. */
  conviction?: number | null;
}): Promise<Buffer | null> {
  try {
    const p = (Array.isArray(args.data.profile) ? args.data.profile[0] : args.data.profile) as
      | { industry?: string; exchange?: string; exchangeShortName?: string }
      | undefined;
    const [strip, figures, snapshot] = await Promise.all([
      buildStatStrip(args.data, args.holdco),
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
      peers: args.peers ?? [],
      peerComps: args.peerComps,
      holdco: args.holdco,
      reconcile: snapshotReconcileInputs(snapshot, args.conviction ?? null, args.peerComps),
      financialGroup: snapshot.financialGroup,
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
        vendorEv: !snapshot.evFromBalanceSheet,
      }) as React.ReactElement<DocumentProps>,
    );
    return Buffer.from(buffer);
  } catch (e) {
    console.error(`Tear sheet build failed for ${args.ticker} (sending without it):`, e);
    return null;
  }
}
