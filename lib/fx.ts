import { fmpGet } from "./fmp";

/**
 * Currency plumbing for cross-listed names — the THX.L bug class. A company
 * can QUOTE in one currency (GBp pence) while REPORTING in another (USD);
 * every price-vs-fundamentals ratio must convert explicitly. Guessing from
 * magnitude is banned: a USD-reported, pence-quoted name sits at fx×100 ≈ 75,
 * indistinguishable from a pence mixup by heuristic alone.
 */

/** Minor-unit listing currencies: quote prices are in 1/100 of the major. */
const MINOR_UNITS: Record<string, string> = {
  GBp: "GBP",
  GBX: "GBP",
  ZAc: "ZAR",
  ZAC: "ZAR",
  ILA: "ILS",
  ILa: "ILS",
};

/** The major currency a listing's PRICES are denominated in, and the divisor. */
export function listingMajor(currency: string | undefined | null): {
  major: string;
  penceFactor: number;
} {
  if (!currency) return { major: "", penceFactor: 1 };
  const major = MINOR_UNITS[currency];
  return major ? { major, penceFactor: 100 } : { major: currency, penceFactor: 1 };
}

/** One direction of one pair from FMP's forex quotes, day-cached. */
async function pairRate(from: string, to: string): Promise<number | null> {
  try {
    const direct = await fmpGet<{ price?: number }[]>("quote", { symbol: `${from}${to}` });
    const p = direct?.[0]?.price;
    if (typeof p === "number" && Number.isFinite(p) && p > 0) return p;
  } catch {
    /* try the inverse */
  }
  try {
    const inverse = await fmpGet<{ price?: number }[]>("quote", { symbol: `${to}${from}` });
    const p = inverse?.[0]?.price;
    if (typeof p === "number" && Number.isFinite(p) && p > 0) return 1 / p;
  } catch {
    /* unavailable */
  }
  return null;
}

/**
 * FX rate FROM one currency TO another (1 unit of `from` = rate units of
 * `to`), day-cached. When no direct pair exists in either direction, CROSS
 * THROUGH USD: GEL→GBP = GEL→USD × USD→GBP. FMP carries no GEL/GBP pair at
 * all, and the old null return sent TBC Bank down a vendor-multiple fallback
 * that printed 0.5x book for a 1.7x-book stock — the day's thesis was built
 * on an unconverted number. Returns null only when even the USD legs are
 * missing — callers must then not print, never guess.
 */
export async function getFxRate(from: string, to: string): Promise<number | null> {
  if (!from || !to) return null;
  if (from === to) return 1;
  const direct = await pairRate(from, to);
  if (direct !== null) return direct;
  if (from === "USD" || to === "USD") return null; // the leg itself is missing
  const [fromToUsd, usdToTo] = await Promise.all([pairRate(from, "USD"), pairRate("USD", to)]);
  if (fromToUsd !== null && usdToTo !== null) return fromToUsd * usdToTo;
  return null;
}
