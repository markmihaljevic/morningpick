import type { TickerData } from "./fmp";

export interface KeyStat {
  label: string;
  value: string;
}

function first<T>(v: unknown): T | undefined {
  return (Array.isArray(v) ? v[0] : v) as T | undefined;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function fmtX(v: number | null): string | null {
  return v === null ? null : `${v.toFixed(1)}x`;
}

function fmtPct(v: number | null): string | null {
  return v === null ? null : `${(v * 100).toFixed(1)}%`;
}

function fmtCap(v: number | null, currency: string): string | null {
  if (v === null) return null;
  if (v >= 1e12) return `${currency}${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `${currency}${(v / 1e9).toFixed(1)}B`;
  return `${currency}${(v / 1e6).toFixed(0)}M`;
}

/**
 * The research-note header block: key figures pulled deterministically from
 * the FMP dataset (never model-generated). Missing figures are omitted.
 */
export function buildKeyStats(data: TickerData): KeyStat[] {
  const quote = first<Record<string, unknown>>(data.quote) ?? {};
  const ratios = first<Record<string, unknown>>(data.ratios) ?? {};
  const metrics = first<Record<string, unknown>>(data.keyMetrics) ?? {};
  const profile = first<Record<string, unknown>>(data.profile) ?? {};

  const currencyCode = typeof profile.currency === "string" ? profile.currency : "";
  const cur = currencyCode === "USD" ? "$" : currencyCode ? `${currencyCode} ` : "";

  const price = num(quote.price);
  const yearLow = num(quote.yearLow);
  const yearHigh = num(quote.yearHigh);

  const stats: (KeyStat | null)[] = [
    price !== null ? { label: "Price", value: `${cur}${price >= 100 ? price.toFixed(0) : price.toFixed(2)}` } : null,
    (() => {
      const v = fmtCap(num(quote.marketCap), cur);
      return v ? { label: "Mkt cap", value: v } : null;
    })(),
    (() => {
      const v = fmtX(num(ratios.priceToEarningsRatio) ?? num(quote.pe));
      return v ? { label: "P/E", value: v } : null;
    })(),
    (() => {
      const v = fmtX(num(ratios.priceToBookRatio));
      return v ? { label: "P/B", value: v } : null;
    })(),
    (() => {
      const v = fmtX(num(metrics.evToEBITDA) ?? num(ratios.enterpriseValueMultiple));
      return v ? { label: "EV/EBITDA", value: v } : null;
    })(),
    (() => {
      const v = fmtPct(num(metrics.freeCashFlowYield));
      return v ? { label: "FCF yield", value: v } : null;
    })(),
    (() => {
      const v = fmtPct(num(ratios.dividendYield));
      return v ? { label: "Div yield", value: v } : null;
    })(),
    yearLow !== null && yearHigh !== null
      ? {
          label: "52w range",
          value: `${yearLow >= 100 ? yearLow.toFixed(0) : yearLow.toFixed(1)}–${yearHigh >= 100 ? yearHigh.toFixed(0) : yearHigh.toFixed(1)}`,
        }
      : null,
  ];
  return stats.filter((s): s is KeyStat => s !== null).slice(0, 8);
}
