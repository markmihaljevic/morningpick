import type { TickerData } from "./fmp";
import { buildSnapshot } from "./figures";
import { resolveMetricGroup } from "./comp-table";
import type { HoldcoContext } from "./holdco";

export interface KeyStat {
  label: string;
  value: string;
}

/** Groups where EV/EBITDA, FCF yield, and net cash are meaningless (deposit-
 * funded balance sheets) — the strip swaps in the bank-native columns. */
const BALANCE_SHEET_BUSINESS = new Set(["banks", "insurance_carriers", "capital_markets_ib", "specialty_finance_credit"]);

/**
 * The page-one stat strip (John's spec): Price, Market cap, P/TBV, P/E,
 * EV/EBITDA, FCF yield, Net cash — one row, small type, P/TBV always present
 * and always the FIRST multiple. Every figure from the one snapshot at the
 * day's close. EV and net cash are balance-sheet-true whenever a statement
 * exists; when none does, the EV-family cells carry a * (vendor-derived) so
 * the degradation is never silent. The strip carries the precision.
 */
export async function buildStatStrip(data: TickerData, holdco?: HoldcoContext | null): Promise<KeyStat[]> {
  const s = await buildSnapshot(data);
  const money = (v: number | null, cur: string) => {
    if (v === null) return "n/a";
    const sign = v < 0 ? "-" : "";
    const a = Math.abs(v);
    if (a >= 1e9) return `${sign}${cur}${(a / 1e9).toFixed(1)}B`;
    return `${sign}${cur}${(a / 1e6).toFixed(0)}M`;
  };
  const x = (v: number | null, dp = 1) => (v !== null && v > 0 && v <= 1000 ? `${v.toFixed(dp)}x` : "n/a");

  // Investment holdco (July 17): the frame is NAV and the discount to it —
  // consolidated P/E and EV/EBITDA of revaluation earnings NEVER appear in
  // the strip, live frame or not. Live look-through figures lead; when live
  // marking failed, the PUBLISHED NAV (dated) frames instead — the strip
  // must never revert to P/E just because a stake quote was unavailable.
  if (holdco?.liveNav || holdco?.publishedListing) {
    const priceStr = s.price !== null ? `${s.listCur}${s.price >= 100 ? s.price.toFixed(0) : s.price.toFixed(2)}` : "n/a";
    const items: KeyStat[] = [
      { label: "Price", value: priceStr },
      { label: "Mkt cap", value: money(s.marketCap, s.listCurMajor) },
    ];
    if (holdco.liveNav) {
      const n = holdco.liveNav;
      items.push(
        { label: "P/Live NAV", value: `${n.pToNav.toFixed(2)}x` },
        {
          label: n.discountPct >= 0 ? "Disc. to live NAV" : "Prem. to live NAV",
          value: `${Math.abs(n.discountPct).toFixed(0)}%`,
        },
        { label: "Live NAV/sh", value: `${n.listingCurrency} ${n.perShare.toFixed(2)}` },
      );
      if (n.publishedPerShare && n.publishedAsOf) {
        items.push({
          label: `NAV/sh (pub. ${n.publishedAsOf.slice(5)})`,
          value: `${n.listingCurrency} ${n.publishedPerShare.toFixed(2)}`,
        });
      }
    } else if (holdco.publishedListing) {
      const p = holdco.publishedListing;
      const discPct = (1 - p.pToNav) * 100;
      items.push(
        { label: `P/NAV (pub. ${p.asOf.slice(5)})`, value: `${p.pToNav.toFixed(2)}x` },
        {
          label: discPct >= 0 ? "Disc. to pub. NAV" : "Prem. to pub. NAV",
          value: `${Math.abs(discPct).toFixed(0)}%`,
        },
        { label: `NAV/sh (pub.)`, value: `${s.listCurMajor} ${p.perShare.toFixed(2)}` },
      );
    }
    if (s.divYield !== null) {
      items.push({ label: "Div yield", value: `${(s.divYield * 100).toFixed(1)}%` });
    }
    return items;
  }

  const items: KeyStat[] = [
    {
      label: "Price",
      value:
        s.price !== null
          ? `${s.listCur}${s.price >= 100 ? s.price.toFixed(0) : s.price.toFixed(2)}`
          : "n/a",
    },
    { label: "Mkt cap", value: money(s.marketCap, s.listCurMajor) },
    // P/TBV: always present, always the first multiple.
    {
      label: "P/TBV",
      value:
        s.tangibleBookAbs !== null && s.tangibleBookAbs <= 0
          ? "neg"
          : x(s.pTangibleBook, 2),
    },
    { label: "P/E", value: x(s.pe) },
  ];

  // Deposit-funded balance sheets (banks, insurers): EV, FCF yield, and net
  // cash are meaningless — the strip carries the bank-native columns instead
  // (per the comp-metrics rule "never show EV/EBITDA for banks").
  const p = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as
    | { industry?: string; sector?: string }
    | undefined;
  const group = resolveMetricGroup(p?.industry, p?.sector);
  if (BALANCE_SHEET_BUSINESS.has(group.key)) {
    const rote =
      s.roe !== null && s.bookValuePerShare !== null && s.tangibleBookPerShare !== null && s.tangibleBookPerShare > 0
        ? s.roe * (s.bookValuePerShare / s.tangibleBookPerShare)
        : null;
    items.push(
      { label: "RoTE", value: rote !== null ? `${(rote * 100).toFixed(1)}%` : "n/a" },
      { label: "P/B", value: x(s.pb, 2) },
      { label: "Div yield", value: s.divYield !== null ? `${(s.divYield * 100).toFixed(1)}%` : "n/a" },
    );
    return items;
  }

  items.push(
    {
      label: s.evFromBalanceSheet ? "EV/EBITDA" : "EV/EBITDA*",
      value: x(s.evEbitda),
    },
    {
      label: "FCF yield",
      value: s.fcfYield !== null ? `${(s.fcfYield * 100).toFixed(1)}%` : "n/a",
    },
    s.netDebt !== null && s.netDebt < 0
      ? { label: s.evFromBalanceSheet ? "Net cash" : "Net cash*", value: money(-s.netDebt, s.repCur) }
      : { label: s.evFromBalanceSheet ? "Net debt" : "Net debt*", value: money(s.netDebt, s.repCur) },
  );
  return items;
}

/**
 * The one-pager's key-figures block — read from the SAME snapshot as the
 * writer's computed figures (lib/figures.ts), so the email and the PDFs can
 * never disagree. All price-dependent values are at today's close. Market
 * cap is labeled in MAJOR units (GBP, never GBp) — the quote's cap is in
 * pounds even when the price quotes in pence.
 */
export async function buildKeyStats(data: TickerData): Promise<KeyStat[]> {
  const s = await buildSnapshot(data);

  const fmtX = (v: number | null) => (v !== null && v > 0 && v <= 1000 ? `${v.toFixed(1)}x` : null);
  const fmtPct = (v: number | null) => (v !== null ? `${(v * 100).toFixed(1)}%` : null);
  const fmtCap = (v: number | null) => {
    if (v === null) return null;
    if (v >= 1e12) return `${s.listCurMajor}${(v / 1e12).toFixed(2)}T`;
    if (v >= 1e9) return `${s.listCurMajor}${(v / 1e9).toFixed(1)}B`;
    return `${s.listCurMajor}${(v / 1e6).toFixed(0)}M`;
  };

  const stats: (KeyStat | null)[] = [
    s.price !== null
      ? { label: "Price", value: `${s.listCur}${s.price >= 100 ? s.price.toFixed(0) : s.price.toFixed(2)}` }
      : null,
    ((): KeyStat | null => {
      const v = fmtCap(s.marketCap);
      return v ? { label: "Mkt cap", value: v } : null;
    })(),
    ((): KeyStat | null => {
      const v = fmtX(s.pe);
      return v ? { label: "P/E", value: v } : null;
    })(),
    ((): KeyStat | null => {
      const v = fmtX(s.pb);
      return v ? { label: "P/B", value: v } : null;
    })(),
    ((): KeyStat | null => {
      const v = fmtX(s.evEbitda);
      return v ? { label: "EV/EBITDA", value: v } : null;
    })(),
    ((): KeyStat | null => {
      const v = fmtPct(s.fcfYield);
      return v ? { label: "FCF yield", value: v } : null;
    })(),
    ((): KeyStat | null => {
      const v = fmtPct(s.divYield);
      return v ? { label: "Div yield", value: v } : null;
    })(),
    s.yearLow !== null && s.yearHigh !== null
      ? {
          label: "52w range",
          value: `${s.yearLow >= 100 ? s.yearLow.toFixed(0) : s.yearLow.toFixed(1)}–${
            s.yearHigh >= 100 ? s.yearHigh.toFixed(0) : s.yearHigh.toFixed(1)
          }`,
        }
      : null,
  ];
  return stats.filter((st): st is KeyStat => st !== null).slice(0, 8);
}
