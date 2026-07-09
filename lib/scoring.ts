import type { Candidate } from "./screens";
import type { FactorRow } from "./factor-table";
import type { Profile } from "./profile";

/**
 * The scoring stage: pure arithmetic between the screen and the analyst.
 * Every eligible name gets factor inputs recomputed at TODAY's price from
 * per-share TTM fundamentals (never FMP's precomputed price ratios — those
 * are stamped at whatever price FMP last used; the annual ones at fiscal
 * year-end). Factors become percentile ranks within this subscriber's
 * eligible universe, combined with weights that sum to 100. Zero LLM tokens.
 */

export interface FactorWeights {
  valuation: number;
  returns: number;
  marginQuality: number;
  capitalDiscipline: number;
  balanceSheet: number;
  growth: number;
}

export const DEFAULT_WEIGHTS: FactorWeights = {
  valuation: 35,
  returns: 25,
  marginQuality: 15,
  capitalDiscipline: 15,
  balanceSheet: 5,
  growth: 5,
};

export interface ScoredCandidate extends Candidate {
  composite: number; // 0-100
  factors: Partial<Record<keyof FactorWeights, number>>; // percentile 0-100 per factor
  /** Fresh-price recomputed headline figures, for the pick prompt. */
  headline: { pTBV?: number; pS?: number; evEbitda?: number; fcfYield?: number; divYield?: number; roic?: number };
  priceFresh: boolean; // false → currency-mismatch fallback to FMP's own TTM ratios
  quarantined?: string; // set → excluded from ranking, with the reason
}

function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Sanity check per John's rule 8: FMP's own TTM dividend yield (or P/E, or
 * P/B) implies the price FMP computed at. Compare with the screener's price:
 *  ~1x    → same currency, ratios recomputable at our fresh price
 *  ~100x  → pence-vs-pounds; rescale per-share values by 100
 *  other  → listing/reporting currency mismatch (e.g. GBp quote, USD
 *           statements) → recomputing price/perShare would be nonsense; fall
 *           back to FMP's own TTM ratios (they convert currency internally).
 * Shared with lib/figures.ts so the memo layer applies the identical check.
 */
export function priceScale(
  row: Pick<
    FactorRow,
    | "dividendPerShareTTM"
    | "dividendYieldTTM"
    | "netIncomePerShareTTM"
    | "priceToEarningsRatioTTM"
    | "bookValuePerShareTTM"
    | "priceToBookRatioTTM"
  >,
  price: number,
): { scale: number; fresh: boolean } {
  const implied =
    (n(row.dividendPerShareTTM) && n(row.dividendYieldTTM)
      ? (row.dividendPerShareTTM as number) / (row.dividendYieldTTM as number)
      : null) ??
    (n(row.netIncomePerShareTTM) && n(row.priceToEarningsRatioTTM) && (row.netIncomePerShareTTM as number) > 0
      ? (row.netIncomePerShareTTM as number) * (row.priceToEarningsRatioTTM as number)
      : null) ??
    (n(row.bookValuePerShareTTM) && n(row.priceToBookRatioTTM) && (row.bookValuePerShareTTM as number) > 0
      ? (row.bookValuePerShareTTM as number) * (row.priceToBookRatioTTM as number)
      : null);
  if (implied === null || implied <= 0 || price <= 0) return { scale: 1, fresh: true };
  const f = price / implied;
  // Bands are deliberately TIGHT. A USD-reported, GBp-quoted name sits at
  // fx×100 ≈ 75 and a EUR-reported one at ≈ 86 — both inside a loose "pence"
  // band, and treating dollars-as-pence produced THX.L's wrong 1.8x P/E. True
  // pence mixups sit at ~100 exactly (± modest price drift since FMP's
  // refresh); anything else is an FX mismatch and gets FMP's own converted
  // ratios rather than a guessed rescale. (The memo layer converts with real
  // FX rates — lib/figures.ts; the scorer only ranks, so approximate is fine.)
  if (f > 0.75 && f < 1.35) return { scale: 1, fresh: true }; // same currency; price moved
  if (f > 92 && f < 109) return { scale: 100, fresh: true }; // GBp quote vs GBP per-share
  if (f > 1 / 109 && f < 1 / 92) return { scale: 0.01, fresh: true }; // the reverse
  return { scale: 1, fresh: false }; // FX mismatch — use FMP's own ratios
}

/** Percentile ranks (0-100) for an array where HIGHER raw value = better. */
function percentiles(values: (number | null)[]): (number | null)[] {
  const present = values
    .map((v, i) => ({ v, i }))
    .filter((x): x is { v: number; i: number } => x.v !== null)
    .sort((a, b) => a.v - b.v);
  const out: (number | null)[] = values.map(() => null);
  const nPresent = present.length;
  if (nPresent === 0) return out;
  present.forEach((x, rank) => {
    out[x.i] = (rank / Math.max(1, nPresent - 1)) * 100;
  });
  return out;
}

/** Mean of the non-null percentile columns for one candidate. */
function meanOf(...vals: (number | null)[]): number | null {
  const present = vals.filter((v): v is number => v !== null);
  return present.length > 0 ? present.reduce((a, b) => a + b, 0) / present.length : null;
}

/**
 * Per-user factor weights: start from the course defaults, then let the
 * profile move them. Explicit `structured.factor_weights` (set by the reply
 * interpreter) wins outright; otherwise keyword heuristics over the profile
 * text apply John's example: "deep value on P/TBV or P/S" → valuation up,
 * growth to zero.
 */
export function deriveWeights(profile: Profile): FactorWeights {
  const explicit = (profile.structured as { factor_weights?: Partial<FactorWeights> })?.factor_weights;
  if (explicit && Object.values(explicit).some((v) => typeof v === "number")) {
    const w = { ...DEFAULT_WEIGHTS, ...explicit };
    const sum = Object.values(w).reduce((a, b) => a + Math.max(0, b), 0) || 1;
    return Object.fromEntries(
      Object.entries(w).map(([k, v]) => [k, (Math.max(0, v) / sum) * 100]),
    ) as unknown as FactorWeights;
  }

  const text = `${JSON.stringify(profile.structured)} ${profile.philosophy}`.toLowerCase();
  const w = { ...DEFAULT_WEIGHTS };
  if (/deep value|net-net|tangible book|p\/tbv|cigar butt|below book/.test(text)) {
    w.valuation += 15;
    w.growth = 0;
  }
  if (/quality|compounder|moat|roic|return on capital/.test(text)) w.returns += 10;
  if (/dividend|income|yield/.test(text)) w.capitalDiscipline += 10;
  if (/growth|growers|expanding/.test(text) && !/growth at any price/.test(text)) w.growth += 10;
  if (/balance sheet|net cash|low debt|unlevered/.test(text)) w.balanceSheet += 10;
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  return Object.fromEntries(
    Object.entries(w).map(([k, v]) => [k, (v / sum) * 100]),
  ) as unknown as FactorWeights;
}

/**
 * Score a subscriber's eligible universe. Returns ranked candidates (best
 * first) plus the quarantine list for telemetry. Names without factor data
 * are quarantined, never guessed at.
 */
export function scoreCandidates(
  pool: Candidate[],
  factorRows: Map<string, FactorRow>,
  weights: FactorWeights,
): { ranked: ScoredCandidate[]; quarantined: ScoredCandidate[] } {
  interface Working extends ScoredCandidate {
    raw: {
      pTBV: number | null; pS: number | null; evEbitda: number | null; fcfYield: number | null;
      earnYield: number | null; roic: number | null; roce: number | null; roe: number | null;
      ebitdaMargin: number | null; netMargin: number | null; incomeQuality: number | null;
      divCoverage: number | null; capexToOCF: number | null;
      netDebtToEbitda: number | null; interestCover: number | null; currentRatio: number | null;
      peg: number | null;
    };
  }

  const working: Working[] = [];
  const quarantined: ScoredCandidate[] = [];

  for (const c of pool) {
    const base: ScoredCandidate = {
      ...c, composite: 0, factors: {}, headline: {}, priceFresh: true,
    };
    const row = factorRows.get(c.ticker.toUpperCase());
    const price = n(c.price);
    if (!row) {
      quarantined.push({ ...base, quarantined: "no factor data" });
      continue;
    }
    if (price === null || price <= 0) {
      quarantined.push({ ...base, quarantined: "no fresh price" });
      continue;
    }
    const mcap = n(c.marketCap) ?? n(row.marketCap);
    if (mcap === null || mcap <= 0) {
      quarantined.push({ ...base, quarantined: "no market cap" });
      continue;
    }
    // Rule 8: P/TBV below P/B is impossible (tangible book ≤ book) — bad row.
    const tbvps = n(row.tangibleBookValuePerShareTTM);
    const bvps = n(row.bookValuePerShareTTM);
    if (tbvps !== null && bvps !== null && tbvps > bvps * 1.05) {
      quarantined.push({ ...base, quarantined: "tangible book > book (bad data)" });
      continue;
    }

    const { scale, fresh } = priceScale(row, price);
    // Rule 8: implausible yields are bad data, not bargains — a 150%+ FCF
    // yield or 30%+ dividend yield at today's price means the fundamentals
    // row doesn't belong to this quote. Quarantine, never rank.
    {
      const fcfy = fresh && n(row.freeCashFlowPerShareTTM) !== null
        ? ((n(row.freeCashFlowPerShareTTM) as number) * scale) / price
        : n(row.freeCashFlowYieldTTM);
      const divy = fresh && n(row.dividendPerShareTTM) !== null
        ? ((n(row.dividendPerShareTTM) as number) * scale) / price
        : n(row.dividendYieldTTM);
      if ((fcfy !== null && fcfy > 1.5) || (divy !== null && divy > 0.3)) {
        quarantined.push({ ...base, quarantined: "implausible yield (bad data)" });
        continue;
      }
    }
    // Per-share values in quote currency after pence/pound rescale.
    const ps = (v: number | null) => (v !== null ? v * scale : null);

    // Fresh-price recomputation (rule 3) — or FMP's own TTM ratios when the
    // currency check says recomputing would mix currencies.
    const pTBV = fresh && ps(tbvps) && (ps(tbvps) as number) > 0
      ? price / (ps(tbvps) as number)
      : (n(row.priceToBookRatioTTM) ?? null); // conservative stand-in
    const pS = fresh && ps(n(row.revenuePerShareTTM)) && (ps(n(row.revenuePerShareTTM)) as number) > 0
      ? price / (ps(n(row.revenuePerShareTTM)) as number)
      : n(row.priceToSalesRatioTTM);
    const fcfYield = fresh && ps(n(row.freeCashFlowPerShareTTM)) !== null
      ? (ps(n(row.freeCashFlowPerShareTTM)) as number) / price
      : n(row.freeCashFlowYieldTTM);
    const divYield = fresh && ps(n(row.dividendPerShareTTM)) !== null
      ? (ps(n(row.dividendPerShareTTM)) as number) / price
      : n(row.dividendYieldTTM);
    const earnYield = fresh && ps(n(row.netIncomePerShareTTM)) !== null
      ? (ps(n(row.netIncomePerShareTTM)) as number) / price
      : n(row.earningsYieldTTM);

    // EV multiples: EV moves 1:1 with market cap — re-anchor FMP's EV to the
    // fresh market cap (net debt piece is price-independent).
    let evEbitda = n(row.evToEBITDATTM);
    const evOld = n(row.enterpriseValueTTM);
    const mcapOld = n(row.marketCap);
    if (evEbitda !== null && evEbitda > 0 && evOld !== null && mcapOld !== null && mcapOld > 0) {
      const ebitda = evOld / evEbitda;
      if (ebitda > 0) evEbitda = (evOld - mcapOld + mcap) / ebitda;
    }
    // A negative multiple (negative EBITDA or net cash > EV) is not "cheapest
    // in the universe" — it is unrankable on this factor.
    if (evEbitda !== null && evEbitda <= 0) evEbitda = null;

    const dps = ps(n(row.dividendPerShareTTM));
    const fcfps = ps(n(row.freeCashFlowPerShareTTM));
    const divCoverage = dps !== null && dps > 0 && fcfps !== null ? fcfps / dps : null;

    working.push({
      ...base,
      priceFresh: fresh,
      headline: {
        pTBV: pTBV ?? undefined, pS: pS ?? undefined, evEbitda: evEbitda ?? undefined,
        fcfYield: fcfYield ?? undefined, divYield: divYield ?? undefined,
        roic: n(row.returnOnInvestedCapitalTTM) ?? undefined,
      },
      raw: {
        pTBV: pTBV !== null && pTBV > 0 ? pTBV : null,
        pS: pS !== null && pS > 0 ? pS : null,
        evEbitda,
        fcfYield, earnYield,
        roic: n(row.returnOnInvestedCapitalTTM), roce: n(row.returnOnCapitalEmployedTTM), roe: n(row.returnOnEquityTTM),
        ebitdaMargin: n(row.ebitdaMarginTTM), netMargin: n(row.netProfitMarginTTM), incomeQuality: n(row.incomeQualityTTM),
        divCoverage, capexToOCF: n(row.capexToOperatingCashFlowTTM),
        netDebtToEbitda: n(row.netDebtToEBITDATTM), interestCover: n(row.interestCoverageRatioTTM), currentRatio: n(row.currentRatioTTM),
        peg: null,
      },
    });
  }

  if (working.length === 0) return { ranked: [], quarantined };

  // Percentiles within THIS universe. Invert where lower raw = better.
  const inv = (v: number | null) => (v !== null ? -v : null);
  const cols = {
    pTBV: percentiles(working.map((w) => inv(w.raw.pTBV))),
    pS: percentiles(working.map((w) => inv(w.raw.pS))),
    evEbitda: percentiles(working.map((w) => inv(w.raw.evEbitda))),
    fcfYield: percentiles(working.map((w) => w.raw.fcfYield)),
    earnYield: percentiles(working.map((w) => w.raw.earnYield)),
    roic: percentiles(working.map((w) => w.raw.roic)),
    roce: percentiles(working.map((w) => w.raw.roce)),
    roe: percentiles(working.map((w) => w.raw.roe)),
    ebitdaMargin: percentiles(working.map((w) => w.raw.ebitdaMargin)),
    netMargin: percentiles(working.map((w) => w.raw.netMargin)),
    incomeQuality: percentiles(working.map((w) => w.raw.incomeQuality)),
    divCoverage: percentiles(working.map((w) => w.raw.divCoverage)),
    capexToOCF: percentiles(working.map((w) => inv(w.raw.capexToOCF))),
    netDebtToEbitda: percentiles(working.map((w) => inv(w.raw.netDebtToEbitda))),
    interestCover: percentiles(working.map((w) => w.raw.interestCover)),
    currentRatio: percentiles(working.map((w) => w.raw.currentRatio)),
  };

  const ranked = working
    .map((w, i) => {
      const factors: ScoredCandidate["factors"] = {
        valuation: meanOf(cols.pTBV[i], cols.pS[i], cols.evEbitda[i], cols.fcfYield[i], cols.earnYield[i]) ?? undefined,
        returns: meanOf(cols.roic[i], cols.roce[i], cols.roe[i]) ?? undefined,
        marginQuality: meanOf(cols.ebitdaMargin[i], cols.netMargin[i], cols.incomeQuality[i]) ?? undefined,
        capitalDiscipline: meanOf(cols.divCoverage[i], cols.capexToOCF[i]) ?? undefined,
        balanceSheet: meanOf(cols.netDebtToEbitda[i], cols.interestCover[i], cols.currentRatio[i]) ?? undefined,
        // Growth: TTM bulk data carries no history — neutral until the factor
        // table gains a second vintage to diff against. Weighting it is harmless.
        growth: 50,
      };
      let weightSum = 0;
      let score = 0;
      for (const key of Object.keys(weights) as (keyof FactorWeights)[]) {
        const f = factors[key];
        if (f === undefined) continue;
        score += f * weights[key];
        weightSum += weights[key];
      }
      const composite = weightSum > 0 ? score / weightSum : 0;
      // Thin factor coverage can't be ranked honestly against full rows.
      const covered = Object.values(factors).filter((v) => v !== undefined).length;
      if (covered < 3) {
        quarantined.push({ ...w, factors, composite: 0, quarantined: "fewer than 3 factors computable" });
        return null;
      }
      return { ...w, factors, composite };
    })
    .filter((w): w is Working => w !== null)
    .sort((a, b) => b.composite - a.composite)
    .map((w) => {
      const { raw, ...rest } = w;
      void raw;
      return rest as ScoredCandidate;
    });

  return { ranked, quarantined };
}
