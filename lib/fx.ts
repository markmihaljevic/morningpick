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

/**
 * FX rate FROM one currency TO another (1 unit of `from` = rate units of
 * `to`), via FMP's forex quotes, day-cached like everything else. Returns
 * null when unavailable — callers must fail safe, never guess.
 */
export async function getFxRate(from: string, to: string): Promise<number | null> {
  if (!from || !to) return null;
  if (from === to) return 1;
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
