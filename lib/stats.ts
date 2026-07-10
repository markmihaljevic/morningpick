import type { TickerData } from "./fmp";
import { buildSnapshot } from "./figures";

export interface KeyStat {
  label: string;
  value: string;
}

/**
 * The page-one stat strip (John's spec): Price, Market cap, P/TBV, P/E,
 * EV/EBITDA, FCF yield, Net cash — one row, small type, P/TBV always present
 * and always the FIRST multiple. Every figure from the one snapshot at the
 * day's close. EV and net cash are balance-sheet-true whenever a statement
 * exists; when none does, the EV-family cells carry a * (vendor-derived) so
 * the degradation is never silent. The strip carries the precision.
 */
export async function buildStatStrip(data: TickerData): Promise<KeyStat[]> {
  const s = await buildSnapshot(data);
  const money = (v: number | null, cur: string) => {
    if (v === null) return "n/a";
    const sign = v < 0 ? "-" : "";
    const a = Math.abs(v);
    if (a >= 1e9) return `${sign}${cur}${(a / 1e9).toFixed(1)}B`;
    return `${sign}${cur}${(a / 1e6).toFixed(0)}M`;
  };
  const x = (v: number | null, dp = 1) => (v !== null && v > 0 && v <= 1000 ? `${v.toFixed(dp)}x` : "n/a");

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
  ];
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
