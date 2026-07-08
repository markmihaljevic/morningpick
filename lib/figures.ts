import type { TickerData } from "./fmp";
import { priceScale } from "./scoring";

export interface ComputedFigure {
  label: string;
  value: string;
}

/**
 * The single data snapshot behind a note (John's rule 9): every derived
 * figure computed ONCE, in code, and read by the email figures block, the
 * writer, the fact-checker, the one-pager, and the report alike — so the
 * email and the PDFs can never disagree.
 *
 * Price-dependent ratios are RECOMPUTED at today's close from per-share TTM
 * fundamentals (rule 3) — never taken from FMP's annual `ratios` rows, which
 * are stamped at fiscal-year-end prices (the CJ.TO 8.3%-vs-6.8% stale-yield
 * bug). When the listing/reporting currency check says recomputing would mix
 * currencies, FMP's own TTM ratios (converted internally, refreshed daily)
 * are used instead.
 */
export interface FiguresSnapshot {
  price: number | null;
  listCur: string; // listing-currency prefix for price/market cap
  repCur: string; // reporting-currency prefix for financials
  marketCap: number | null;
  enterpriseValue: number | null;
  netDebt: number | null;
  netDebtToEbitda: number | null;
  priceFresh: boolean;
  pe: number | null;
  evEbitda: number | null;
  pb: number | null;
  pTangibleBook: number | null;
  ps: number | null;
  pfcf: number | null;
  earningsYield: number | null;
  fcfYield: number | null;
  divYield: number | null;
  payoutRatio: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  ebitdaMargin: number | null;
  netMargin: number | null;
  roe: number | null;
  roic: number | null;
  roa: number | null;
  roce: number | null;
  currentRatio: number | null;
  debtToEquity: number | null;
  interestCoverage: number | null;
  bookValuePerShare: number | null;
  tangibleBookPerShare: number | null;
  cashPerShare: number | null;
  fcfPerShare: number | null;
  eps: number | null;
  yearLow: number | null;
  yearHigh: number | null;
  revenueGrowth: number | null;
  ebitdaGrowth: number | null;
  epsGrowth: number | null;
  consensus: { year: string; revenue: number | null; ebitda: number | null; eps: number | null; analysts: number | null }[];
}

function first<T>(v: unknown): T | undefined {
  return (Array.isArray(v) ? v[0] : v) as T | undefined;
}
function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A currency code as a readable prefix: "USD" → "$", "GBp" → "GBp ". */
function curPrefix(code: unknown): string {
  if (typeof code !== "string" || !code) return "";
  return code === "USD" ? "$" : `${code} `;
}

export function buildSnapshot(data: TickerData): FiguresSnapshot {
  const quote = first<Record<string, unknown>>(data.quote) ?? {};
  const rt = first<Record<string, unknown>>(data.ratiosTTM) ?? {};
  const kt = first<Record<string, unknown>>(data.keyMetricsTTM) ?? {};
  const ra = first<Record<string, unknown>>(data.ratios) ?? {}; // annual — non-price fallback only
  const ka = first<Record<string, unknown>>(data.keyMetrics) ?? {};
  const inc0 = first<Record<string, unknown>>(data.incomeStatement) ?? {};
  const inc1 = (Array.isArray(data.incomeStatement) ? data.incomeStatement[1] : undefined) as
    | Record<string, unknown>
    | undefined;
  const profile = first<Record<string, unknown>>(data.profile) ?? {};

  const listCur = curPrefix(profile.currency);
  const repCur = curPrefix(rt.reportedCurrency ?? ra.reportedCurrency ?? inc0.reportedCurrency);

  const price = n(quote.price);
  const marketCap = n(quote.marketCap);

  // Currency-consistency check (rule 8), shared with the scorer.
  const scaled = price !== null ? priceScale(rt as never, price) : { scale: 1, fresh: false };
  const ps = (v: unknown) => (n(v) !== null ? (n(v) as number) * scaled.scale : null);

  // Price-dependent ratios: recompute at today's close when currency-safe,
  // else FMP's own TTM value (daily-refreshed, currency-converted).
  const ratio = (perShare: unknown, fmpTTM: unknown, invert = false): number | null => {
    if (scaled.fresh && price !== null && ps(perShare) !== null) {
      const v = ps(perShare) as number;
      if (invert) return v !== 0 ? price / v : null; // price / per-share
      return v / price; // per-share / price (yields)
    }
    return n(fmpTTM);
  };

  const pe = ((): number | null => {
    const v = ratio(rt.netIncomePerShareTTM, rt.priceToEarningsRatioTTM, true);
    return v !== null && v > 0 ? v : null; // negative earnings → no meaningful P/E
  })();
  const pb = ratio(rt.bookValuePerShareTTM, rt.priceToBookRatioTTM, true);
  const pTangibleBook = ((): number | null => {
    const v = ratio(rt.tangibleBookValuePerShareTTM, null, true);
    if (v !== null && v > 0) return v;
    // Dimensionless fallback: P/B × (book / tangible book) — never mixes currencies.
    const pbv = n(rt.priceToBookRatioTTM);
    const bv = n(rt.bookValuePerShareTTM);
    const tbv = n(rt.tangibleBookValuePerShareTTM);
    return pbv !== null && bv !== null && tbv !== null && tbv > 0 ? pbv * (bv / tbv) : null;
  })();
  const psRatio = ((): number | null => {
    const v = ratio(rt.revenuePerShareTTM, rt.priceToSalesRatioTTM, true);
    return v !== null && v > 0 ? v : null;
  })();
  const pfcf = ((): number | null => {
    const v = ratio(rt.freeCashFlowPerShareTTM, rt.priceToFreeCashFlowRatioTTM, true);
    return v !== null && v > 0 ? v : null;
  })();
  const earningsYield = ratio(rt.netIncomePerShareTTM, kt.earningsYieldTTM);
  const fcfYield = ratio(rt.freeCashFlowPerShareTTM, kt.freeCashFlowYieldTTM);
  const divYield = ratio(rt.dividendPerShareTTM, rt.dividendYieldTTM);

  // EV re-anchored to today's market cap (net-debt piece is price-independent).
  const evEbitda = ((): number | null => {
    const evOld = n(kt.enterpriseValueTTM);
    const mcapOld = n(kt.marketCap);
    const evx = n(kt.evToEBITDATTM) ?? n(rt.enterpriseValueMultipleTTM);
    if (evx === null || evx <= 0) return null;
    if (evOld !== null && mcapOld !== null && mcapOld > 0 && marketCap !== null) {
      const ebitda = evOld / evx;
      if (ebitda > 0) {
        const v = (evOld - mcapOld + marketCap) / ebitda;
        return v > 0 ? v : null;
      }
    }
    return evx;
  })();
  const enterpriseValue = ((): number | null => {
    const evOld = n(kt.enterpriseValueTTM);
    const mcapOld = n(kt.marketCap);
    if (evOld !== null && mcapOld !== null && marketCap !== null) return evOld - mcapOld + marketCap;
    return evOld;
  })();

  const ndToEbitda = n(kt.netDebtToEBITDATTM) ?? n(ka.netDebtToEBITDA);
  const ebitda0 = n(inc0.ebitda);
  const netDebt = ndToEbitda !== null && ebitda0 !== null ? ndToEbitda * ebitda0 : null;

  const growth = (a: unknown, b: unknown): number | null => {
    const v0 = n(a);
    const v1 = n(b);
    if (v0 === null || v1 === null || v1 <= 0) return null;
    return (v0 - v1) / v1;
  };

  const estimates = (data.street?.estimates ?? []) as Record<string, unknown>[];
  const consensus = (Array.isArray(estimates) ? estimates.slice(0, 3) : [])
    .map((e) => ({
      year: typeof e.fiscalYearEnd === "string" ? e.fiscalYearEnd.slice(0, 4) : "",
      revenue: n(e.revenueAvg),
      ebitda: n(e.ebitdaAvg),
      eps: n(e.epsAvg),
      analysts: n(e.numAnalystsEps),
    }))
    .filter((e) => e.year && (e.revenue !== null || e.ebitda !== null || e.eps !== null));

  return {
    price,
    listCur,
    repCur,
    marketCap,
    enterpriseValue,
    netDebt,
    netDebtToEbitda: ndToEbitda,
    priceFresh: scaled.fresh,
    pe,
    evEbitda,
    pb,
    pTangibleBook,
    ps: psRatio,
    pfcf,
    earningsYield,
    fcfYield,
    divYield,
    payoutRatio: n(rt.dividendPayoutRatioTTM) ?? n(ra.dividendPayoutRatio),
    grossMargin: n(rt.grossProfitMarginTTM) ?? n(ra.grossProfitMargin),
    operatingMargin: n(rt.operatingProfitMarginTTM) ?? n(ra.operatingProfitMargin),
    ebitdaMargin: n(rt.ebitdaMarginTTM) ?? n(ra.ebitdaMargin),
    netMargin: n(rt.netProfitMarginTTM) ?? n(ra.netProfitMargin),
    roe: n(kt.returnOnEquityTTM) ?? n(ka.returnOnEquity),
    roic: n(kt.returnOnInvestedCapitalTTM) ?? n(ka.returnOnInvestedCapital),
    roa: n(kt.returnOnAssetsTTM) ?? n(ka.returnOnAssets),
    roce: n(kt.returnOnCapitalEmployedTTM) ?? n(ka.returnOnCapitalEmployed),
    currentRatio: n(rt.currentRatioTTM) ?? n(ra.currentRatio),
    debtToEquity: n(rt.debtToEquityRatioTTM) ?? n(ra.debtToEquityRatio),
    interestCoverage: n(rt.interestCoverageRatioTTM) ?? n(ra.interestCoverageRatio),
    bookValuePerShare: ps(rt.bookValuePerShareTTM) ?? n(ra.bookValuePerShare),
    tangibleBookPerShare: ps(rt.tangibleBookValuePerShareTTM) ?? n(ra.tangibleBookValuePerShare),
    cashPerShare: ps(rt.cashPerShareTTM) ?? n(ra.cashPerShare),
    fcfPerShare: ps(rt.freeCashFlowPerShareTTM) ?? n(ra.freeCashFlowPerShare),
    eps: n(inc0.eps),
    yearLow: n(quote.yearLow),
    yearHigh: n(quote.yearHigh),
    revenueGrowth: growth(inc0.revenue, inc1?.revenue),
    ebitdaGrowth: growth(inc0.ebitda, inc1?.ebitda),
    epsGrowth: growth(inc0.eps, inc1?.eps),
    consensus,
  };
}

// ——— formatting ———

function fmtX(v: number | null): string | null {
  if (v === null || v <= 0 || v > 1000) return null;
  return `${v.toFixed(1)}x`;
}
function fmtPct(v: number | null, decimals = 1): string | null {
  return v === null ? null : `${(v * 100).toFixed(decimals)}%`;
}
function fmtMoney(v: number | null, cur: string): string | null {
  if (v === null) return null;
  const sign = v < 0 ? "-" : "";
  const a = Math.abs(v);
  if (a >= 1e12) return `${sign}${cur}${(a / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${sign}${cur}${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}${cur}${(a / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `${sign}${cur}${(a / 1e3).toFixed(0)}k`;
  return `${sign}${cur}${a.toFixed(2)}`;
}
function fmtShare(v: number | null, cur: string): string | null {
  if (v === null) return null;
  return `${cur}${v.toFixed(2)}`;
}

/**
 * The writer/verifier fact list, rendered from the snapshot. Everything here
 * is at TODAY's close (or FMP's daily-refreshed TTM value when the currency
 * check forbids recomputation) — never fiscal-year-end vintage.
 */
export function buildComputedFigures(data: TickerData): ComputedFigure[] {
  const s = buildSnapshot(data);
  const out: (ComputedFigure | null)[] = [];
  const push = (label: string, value: string | null) => out.push(value ? { label, value } : null);

  push(
    "Price",
    s.price !== null ? `${s.listCur}${s.price >= 100 ? s.price.toFixed(0) : s.price.toFixed(2)}` : null,
  );
  push("Market cap", fmtMoney(s.marketCap, s.listCur));
  push("Enterprise value", fmtMoney(s.enterpriseValue, s.repCur));
  if (s.netDebt !== null) {
    push("Net debt", s.netDebt < 0 ? `net cash ${fmtMoney(-s.netDebt, s.repCur)}` : fmtMoney(s.netDebt, s.repCur));
  }
  push("Net debt / EBITDA", s.netDebtToEbitda !== null ? `${s.netDebtToEbitda.toFixed(2)}x` : null);

  push("P/E", fmtX(s.pe));
  push("EV/EBITDA", fmtX(s.evEbitda));
  push("P/B", fmtX(s.pb));
  push("P/tangible book", fmtX(s.pTangibleBook));
  push("P/S", fmtX(s.ps));
  push("P/FCF", fmtX(s.pfcf));
  push("Earnings yield", fmtPct(s.earningsYield));
  push("FCF yield", fmtPct(s.fcfYield));
  push("Dividend yield", fmtPct(s.divYield));
  push("Payout ratio", fmtPct(s.payoutRatio));

  push("Gross margin", fmtPct(s.grossMargin));
  push("Operating margin", fmtPct(s.operatingMargin));
  push("EBITDA margin", fmtPct(s.ebitdaMargin));
  push("Net margin", fmtPct(s.netMargin));

  push("ROE", fmtPct(s.roe));
  push("ROIC", fmtPct(s.roic));
  push("ROA", fmtPct(s.roa));
  push("ROCE", fmtPct(s.roce));

  push("Current ratio", s.currentRatio !== null ? `${s.currentRatio.toFixed(2)}x` : null);
  push("Debt / equity", s.debtToEquity !== null ? `${s.debtToEquity.toFixed(2)}x` : null);
  push("Interest coverage", fmtX(s.interestCoverage));

  push("Book value / share", fmtShare(s.bookValuePerShare, s.repCur));
  push("Tangible book / share", fmtShare(s.tangibleBookPerShare, s.repCur));
  push("Cash / share", fmtShare(s.cashPerShare, s.repCur));
  push("FCF / share", fmtShare(s.fcfPerShare, s.repCur));
  push("EPS", fmtShare(s.eps, s.repCur));

  if (s.price !== null && s.yearLow !== null && s.yearHigh !== null && s.yearLow > 0 && s.yearHigh > s.yearLow) {
    const aboveLow = ((s.price - s.yearLow) / s.yearLow) * 100;
    const belowHigh = ((s.yearHigh - s.price) / s.yearHigh) * 100;
    const fp = (x: number) => (x >= 100 ? x.toFixed(0) : x.toFixed(1));
    push(
      "52-week position",
      `${aboveLow.toFixed(0)}% above the ${s.listCur}${fp(s.yearLow)} low, ${belowHigh.toFixed(0)}% below the ${s.listCur}${fp(s.yearHigh)} high`,
    );
  }

  const g = (v: number | null) => (v === null ? null : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
  push("Revenue growth (YoY)", g(s.revenueGrowth));
  push("EBITDA growth (YoY)", g(s.ebitdaGrowth));
  push("EPS growth (YoY)", g(s.epsGrowth));

  for (const e of s.consensus) {
    const parts = [
      e.revenue !== null && `rev ${fmtMoney(e.revenue, s.repCur)}`,
      e.ebitda !== null && `EBITDA ${fmtMoney(e.ebitda, s.repCur)}`,
      e.eps !== null && `EPS ${s.repCur}${e.eps.toFixed(2)}`,
    ].filter(Boolean);
    if (parts.length > 0) {
      push(`Consensus FY${e.year}`, `${parts.join(" · ")}${e.analysts ? ` (${e.analysts} analysts)` : ""}`);
    }
  }

  return out.filter((f): f is ComputedFigure => f !== null);
}

/** The prompt block: computed figures as ready-to-quote facts. */
export function computedFiguresBlock(figures: ComputedFigure[]): string {
  if (figures.length === 0) return "";
  const lines = figures.map((f) => `${f.label}: ${f.value}`).join("\n");
  return `<computed_figures note="Calculated for you directly from the filings AT TODAY'S CLOSE, with currency handled correctly (each absolute figure carries its currency; ratios and margins are dimensionless). USE THESE VERBATIM. Do NOT divide, multiply, or otherwise recompute raw dataset numbers yourself, and do NOT quote valuation ratios from the dataset's annual rows — those are stamped at fiscal-year-end prices and are stale. If a figure you want is not here and not stated outright in the dataset, do not calculate it: describe it qualitatively or leave it out.">
${lines}
</computed_figures>

`;
}
