import { fmpGet } from "./fmp";
import { getFxRate, listingMajor } from "./fx";

/**
 * Identity is the COMPANY, not the ticker (John's no-repeat rule 1). THX.L
 * and THX.V are both Thor Explorations; one send consumes the company on
 * every exchange it trades. The key is the ISIN when the vendor knows it,
 * else a normalized company name — computed the same way at send time and
 * at selection time so the repeat check always compares like with like.
 */

/** Legal-form suffixes stripped before name comparison. */
const LEGAL_SUFFIXES =
  /\b(plc|inc|inc\.|incorporated|ltd|ltd\.|limited|corp|corp\.|corporation|company|co|co\.|sa|s\.a\.|ag|nv|n\.v\.|se|asa|ab|oyj|spa|s\.p\.a\.|nyrt|jsc|pjsc|ojsc|ao|group|holdings|holding)\b/g;

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface CompanyIdentity {
  key: string;
  isin: string | null;
  name: string | null;
  /** Second identity: DR/ADR lines carry DIFFERENT ISINs than the local
   * ordinaries (Halyk's LSE GDR is a US ISIN) — the name key must always be
   * checkable alongside the ISIN or rule 1 misses exactly the dual-listing
   * class it targets. */
  nameKey: string | null;
}

/** Identity from a profile row already in hand (the dataset's). */
export function identityFromProfile(profile: unknown): CompanyIdentity {
  const p = (Array.isArray(profile) ? profile[0] : profile) as
    | { isin?: string; companyName?: string; symbol?: string }
    | undefined;
  const isin = typeof p?.isin === "string" && p.isin.length >= 8 ? p.isin.toUpperCase() : null;
  const name = typeof p?.companyName === "string" && p.companyName ? p.companyName : null;
  const nameKey = name ? `name:${normalizeCompanyName(name)}` : null;
  const key = isin ?? nameKey ?? `ticker:${(p?.symbol ?? "").toUpperCase()}`;
  return { key, isin, name, nameKey };
}

/** Identity for a bare ticker — one day-cached profile call. */
export async function identityForTicker(ticker: string): Promise<CompanyIdentity> {
  try {
    const profile = await fmpGet<Record<string, unknown>[]>("profile", { symbol: ticker });
    const id = identityFromProfile(profile);
    if (id.key.startsWith("ticker:")) return { ...id, key: `ticker:${ticker.toUpperCase()}` };
    return id;
  } catch {
    return { key: `ticker:${ticker.toUpperCase()}`, isin: null, name: null, nameKey: null };
  }
}

export interface CrossListingSpread {
  gapPct: number; // absolute divergence beyond FX, e.g. 0.031 = 3.1%
  detail: string; // both prices + the cross rate + the gap, print-ready
}

/**
 * Rule 4: the ONE same-company idea that clears the bar without new
 * fundamentals — two lines of the same issuer diverging beyond FX. Both
 * quotes go to USD at the day's cross; the gap is the story (or, within a
 * few percent of parity, the non-story). Null when it can't be computed —
 * callers treat that as "no spread", never as license to resend.
 */
export async function crossListingSpread(
  tickerA: string,
  tickerB: string,
): Promise<CrossListingSpread | null> {
  try {
    const toUsd = async (
      ticker: string,
    ): Promise<{ usd: number; label: string; ts: number } | null> => {
      const [quote, profile] = await Promise.all([
        fmpGet<{ price?: number; timestamp?: number }[]>("quote", { symbol: ticker }),
        fmpGet<{ currency?: string }[]>("profile", { symbol: ticker }),
      ]);
      const price = quote?.[0]?.price;
      const ts = quote?.[0]?.timestamp;
      const currency = profile?.[0]?.currency;
      if (typeof price !== "number" || !currency || typeof ts !== "number") return null;
      const { major, penceFactor } = listingMajor(currency);
      const fx = await getFxRate(major, "USD");
      if (fx === null) return null;
      return { usd: (price / penceFactor) * fx, label: `${currency} ${price}`, ts };
    };
    const [a, b] = await Promise.all([toUsd(tickerA), toUsd(tickerB)]);
    if (!a || !b || a.usd <= 0 || b.usd <= 0) return null;
    // Staleness guard: a closed venue's Friday print vs a live venue's Monday
    // quote manufactures a phantom "spread" — the arb evaporates at the open.
    // Both prints must be recent and near-simultaneous, or there is no
    // measurable spread (null → the gate stays closed; blocked beats phantom).
    const HOURS = 3_600_000;
    const now = Date.now();
    const ageA = now - a.ts * 1000;
    const ageB = now - b.ts * 1000;
    if (ageA > 96 * HOURS || ageB > 96 * HOURS) return null;
    if (Math.abs(a.ts - b.ts) * 1000 > 8 * HOURS) return null;
    const gapPct = Math.abs(a.usd / b.usd - 1);
    return {
      gapPct,
      detail: `${tickerA} at ${a.label} vs ${tickerB} at ${b.label} — ${(gapPct * 100).toFixed(1)}% apart in USD terms at today's crosses`,
    };
  } catch {
    return null;
  }
}
