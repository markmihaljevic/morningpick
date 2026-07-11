import type { TickerData } from "./fmp";
import { getFxRate, listingMajor } from "./fx";

export interface ComputedFigure {
  label: string;
  value: string;
}

/**
 * The single data snapshot behind a note (John's rule 9): every derived
 * figure computed ONCE, in code, and read by the email figures block, the
 * writer, the fact-checker, the one-pager stats, and the comp table alike —
 * so no two surfaces can disagree.
 *
 * Price-dependent ratios are RECOMPUTED at today's close from per-share TTM
 * fundamentals (rule 3) — never taken from FMP's precomputed rows, which are
 * stamped at whatever price FMP last refreshed (the THX.L 1.8x-vs-2.5x bug).
 *
 * CURRENCY IS EXPLICIT (the actual root cause of THX.L): a name can QUOTE in
 * GBp pence while REPORTING in USD. The reported currency comes from the
 * statements, the listing currency from the profile, and the conversion is a
 * real day-cached FX rate — never a magnitude heuristic, because fx×100 for
 * a USD/GBp name (~75) is indistinguishable from a pence mixup by size alone.
 * If no FX rate exists even crossing through USD, price-dependent ratios
 * are NULL — never a vendor's stale conversion. A footnote admitting a
 * number is broken does not license printing it (the TBC 0.5x-book lesson).
 */
export interface FiguresSnapshot {
  price: number | null; // listing units as quoted (e.g. pence)
  listCur: string; // prefix for PRICE (minor units, e.g. "GBp ")
  listCurMajor: string; // prefix for MARKET CAP (major units, e.g. "GBP ")
  repCur: string; // prefix for financials (reported currency)
  marketCap: number | null; // listing MAJOR units, as quoted
  marketCapReported: number | null; // reported currency, at today's close
  enterpriseValue: number | null; // reported currency; balance-sheet-true when available
  netDebt: number | null; // reported currency; negative = net cash
  netDebtToEbitda: number | null;
  // Balance-sheet components (reported currency, one statement, one date) —
  // null when no balance sheet is available and a fallback derivation ran.
  balanceSheetDate: string | null;
  totalDebt: number | null;
  cashAndDeposits: number | null; // cash + short-term investments
  tangibleBookAbs: number | null; // total equity − goodwill − intangibles
  ebitdaTTM: number | null; // derived from kt's own EV/EBITDA pair — one epoch
  /** False → no usable balance sheet; EV figures degrade to vendor data and
   * every surface that prints them must say so. */
  evFromBalanceSheet: boolean;
  priceFresh: boolean; // false → FX unavailable even via USD; price ratios are null
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
  bookValuePerShare: number | null; // reported currency
  tangibleBookPerShare: number | null;
  cashPerShare: number | null;
  fcfPerShare: number | null;
  eps: number | null;
  // Raw TTM per-share inputs — lets consumers distinguish "data missing"
  // (n/a) from "not meaningful" (n/m: present but negative/de-minimis).
  epsTTM: number | null;
  revenuePerShareTTM: number | null;
  yearLow: number | null;
  yearHigh: number | null;
  revenueGrowth: number | null; // YoY
  ebitdaGrowth: number | null;
  epsGrowth: number | null;
  revenueCagr3y: number | null; // when 4 fiscal years are available
  consensus: {
    year: string;
    revenue: number | null;
    ebitda: number | null;
    eps: number | null;
    analysts: number | null;
  }[];
}

function first<T>(v: unknown): T | undefined {
  return (Array.isArray(v) ? v[0] : v) as T | undefined;
}
function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A currency code as a readable prefix: "USD" → "$", "CAD" → "C$", "GBp" stays. */
const CUR_SYMBOLS: Record<string, string> = {
  USD: "$",
  CAD: "C$",
  AUD: "A$",
  GBP: "£",
  EUR: "€",
  JPY: "¥",
  CHF: "CHF ",
  SEK: "SEK ",
  NOK: "NOK ",
  DKK: "DKK ",
};
function curPrefix(code: unknown): string {
  if (typeof code !== "string" || !code) return "";
  return CUR_SYMBOLS[code] ?? `${code} `;
}

export interface SnapshotParts {
  profile: Record<string, unknown>;
  quote: Record<string, unknown>;
  ratiosTTM: Record<string, unknown>;
  keyMetricsTTM: Record<string, unknown>;
  /** Newest-first fiscal years; [0] used for reported currency + absolutes. */
  incomeStatements: Record<string, unknown>[];
  /** The latest REPORTED balance sheet (quarterly preferred) — the canonical
   * source for net cash, true EV, and tangible book. One statement, one date. */
  balanceSheet?: Record<string, unknown> | null;
  /** Annual rows — non-price fallbacks only (margins, returns). */
  ratiosAnnual?: Record<string, unknown>;
  keyMetricsAnnual?: Record<string, unknown>;
  street?: { estimates?: unknown };
}

/**
 * The snapshot core, shared by the subject and every comp-table peer so the
 * whole page is one price epoch, one formula set, one currency treatment.
 */
export async function snapshotFromParts(parts: SnapshotParts): Promise<FiguresSnapshot> {
  const { profile, quote, ratiosTTM: rt, keyMetricsTTM: kt } = parts;
  const bs = parts.balanceSheet ?? null;
  const inc0 = parts.incomeStatements[0] ?? {};
  const inc1 = parts.incomeStatements[1];
  const incLast = parts.incomeStatements[3]; // 4th year back → 3Y CAGR
  const ra = parts.ratiosAnnual ?? {};
  const ka = parts.keyMetricsAnnual ?? {};

  const listingCode = typeof profile.currency === "string" ? profile.currency : "";
  const { major, penceFactor } = listingMajor(listingCode);
  // Reported currency from wherever a statement-shaped row declares it. If NO
  // source declares one, we must NOT assume the listing currency — that
  // assumption on a USD-reporting/GBp-quoted name is exactly the THX.L bug.
  // Unknown reported currency → the safe fallback path (FMP's own converted
  // TTM ratios, priceFresh=false).
  const cur = (v: unknown) => (typeof v === "string" && v ? v : null);
  const reported =
    cur(inc0.reportedCurrency) ??
    cur(ra.reportedCurrency) ??
    cur(ka.reportedCurrency) ??
    cur(rt.reportedCurrency) ??
    cur(kt.reportedCurrency) ??
    cur(bs?.reportedCurrency);
  // Currency-consistency guard: if the balance sheet declares a DIFFERENT
  // currency than the income/TTM rows (reporting-currency switch, vendor
  // inconsistency), its absolutes cannot be mixed with the per-share math —
  // drop the statement and fall back rather than print cross-currency EV.
  const bsCurrency = cur(bs?.reportedCurrency);
  const bsUsable = bs !== null && (!bsCurrency || !reported || bsCurrency === reported);
  const bsSafe = bsUsable ? bs : null;

  const listCur = curPrefix(listingCode);
  const listCurMajor = curPrefix(major);
  const repCur = curPrefix(reported ?? major);

  const price = n(quote.price); // listing units (possibly pence)
  const marketCap = n(quote.marketCap); // listing MAJOR units (FMP normalizes)

  // One explicit conversion: today's price and market cap in REPORTED terms.
  const fx = reported && major ? await getFxRate(reported, major) : null; // 1 reported = fx major
  const priceFresh = fx !== null;
  const priceRep = price !== null && price > 0 && fx !== null ? price / penceFactor / fx : null;
  const mcapRep = marketCap !== null && fx !== null ? marketCap / fx : null;

  // Price-dependent ratios: recompute at today's close in reported currency,
  // or DON'T PRINT (null → n/a). There is no vendor fallback: FMP's
  // precomputed multiples are stamped at their refresh epoch and, on pairs
  // FMP can't convert (GEL statements vs GBp quote), essentially unconverted
  // — TBC Bank printed 0.5x book for a 1.7x-book stock through that path,
  // and a footnote admitting a number is stale does not license printing it.
  const over = (perShare: unknown): number | null => {
    const v = n(perShare);
    if (priceRep !== null && v !== null) return v !== 0 ? priceRep / v : null;
    return null;
  };
  const yield_ = (perShare: unknown): number | null => {
    const v = n(perShare);
    if (priceRep !== null && v !== null) return v / priceRep;
    return null;
  };

  const pe = ((): number | null => {
    const v = over(rt.netIncomePerShareTTM);
    return v !== null && v > 0 ? v : null; // negative earnings → no meaningful P/E
  })();
  // Balance-sheet components: one statement, one date (John's rule). FMP's
  // netDebt field counts only the cash LINE — it missed the US$90.7M Monument
  // held in short-term deposits — so net cash, EV, and tangible book are
  // assembled from the raw statement fields, never a vendor's precomputed one.
  const balanceSheetDate = bsSafe && typeof bsSafe.date === "string" ? bsSafe.date : null;
  const totalDebt = n(bsSafe?.totalDebt);
  const cashAndDeposits = ((): number | null => {
    const cash = n(bsSafe?.cashAndCashEquivalents);
    const sti = n(bsSafe?.shortTermInvestments);
    if (cash === null && sti === null) return n(bsSafe?.cashAndShortTermInvestments);
    return (cash ?? 0) + (sti ?? 0);
  })();
  const tangibleBookAbs = ((): number | null => {
    const equity = n(bsSafe?.totalStockholdersEquity) ?? n(bsSafe?.totalEquity);
    if (equity === null) return null;
    // FMP sometimes serves the combined field as 0 while the components carry
    // real values — take the LARGER of combined vs sum, never let a zeroed
    // combined field overstate tangible book (the page's headline multiple).
    const combined = n(bsSafe?.goodwillAndIntangibleAssets) ?? 0;
    const summed = (n(bsSafe?.goodwill) ?? 0) + (n(bsSafe?.intangibleAssets) ?? 0);
    return equity - Math.max(combined, summed);
  })();

  const pb = over(rt.bookValuePerShareTTM);
  const pTangibleBook = ((): number | null => {
    // Canonical: market cap over (equity − goodwill − intangibles), both in
    // reported currency — market cap at today's close, book at the statement.
    if (mcapRep !== null && tangibleBookAbs !== null && tangibleBookAbs > 0) {
      return mcapRep / tangibleBookAbs;
    }
    const v = over(rt.tangibleBookValuePerShareTTM);
    if (v !== null && v > 0) return v;
    return null; // no vendor-epoch fallback — recompute or don't print
  })();
  const ps = ((): number | null => {
    const v = over(rt.revenuePerShareTTM);
    return v !== null && v > 0 ? v : null;
  })();
  const pfcf = ((): number | null => {
    const v = over(rt.freeCashFlowPerShareTTM);
    return v !== null && v > 0 ? v : null;
  })();
  const earningsYield = yield_(rt.netIncomePerShareTTM);
  const fcfYield = yield_(rt.freeCashFlowPerShareTTM);
  const divYield = yield_(rt.dividendPerShareTTM);

  // TTM EBITDA derived from kt's own EV/EBITDA pair (same epoch, one source).
  const ebitdaTTM = ((): number | null => {
    const evOld = n(kt.enterpriseValueTTM);
    const evx = n(kt.evToEBITDATTM);
    if (evOld !== null && evx !== null && evx !== 0) {
      const v = evOld / evx;
      return v > 0 ? v : null;
    }
    return null;
  })();

  // Net debt: BALANCE-SHEET-TRUE first — total debt minus cash minus
  // short-term investments, one statement, one date (negative = net cash).
  // Fallback: period-consistent TTM ratio × TTM EBITDA, else annual × annual.
  const netDebt = ((): number | null => {
    if (totalDebt !== null && cashAndDeposits !== null) return totalDebt - cashAndDeposits;
    return null; // no statement → no net debt; vendor netDebt is banned (cash-line-only)
  })();

  // True EV = market cap at today's close + net debt from the statement —
  // never a vendor's precomputed EV (whose netDebt misses deposit lines).
  // Degradation order keeps the TRUE net-debt piece as long as possible:
  //   1. today's cap (converted) + statement net debt        [fresh + true]
  //   2. kt's epoch cap + statement net debt (FX missing)    [stale + true]
  //   3. FMP's EV re-anchored to today's cap (no statement)  [vendor netDebt]
  const evFromBalanceSheet = totalDebt !== null && cashAndDeposits !== null;
  const enterpriseValue = ((): number | null => {
    if (mcapRep !== null && evFromBalanceSheet) {
      return mcapRep + (totalDebt as number) - (cashAndDeposits as number);
    }
    const evOld = n(kt.enterpriseValueTTM);
    const mcapOld = n(kt.marketCap);
    if (evFromBalanceSheet && mcapOld !== null) {
      return mcapOld + (totalDebt as number) - (cashAndDeposits as number);
    }
    if (evOld !== null && mcapOld !== null && mcapRep !== null) return evOld - mcapOld + mcapRep;
    return evOld;
  })();
  const evEbitda = ((): number | null => {
    if (enterpriseValue !== null && ebitdaTTM !== null) {
      const v = enterpriseValue / ebitdaTTM;
      return v > 0 ? v : null;
    }
    // Prefer the TRUE EV over annual EBITDA to a vendor multiple built on the
    // cash-line-only netDebt — annual EBITDA is the honest denominator when
    // the TTM pair is missing (thin small-cap coverage).
    const ebitda0 = n(inc0.ebitda);
    if (enterpriseValue !== null && evFromBalanceSheet && ebitda0 !== null && ebitda0 > 0) {
      const v = enterpriseValue / ebitda0;
      return v > 0 ? v : null;
    }
    return null; // no vendor-multiple fallback — recompute or don't print
  })();

  const ndToEbitda = ((): number | null => {
    if (netDebt !== null && ebitdaTTM !== null) return netDebt / ebitdaTTM;
    const ebitda0 = n(inc0.ebitda);
    if (netDebt !== null && evFromBalanceSheet && ebitda0 !== null && ebitda0 > 0) {
      return netDebt / ebitda0;
    }
    return null; // vendor netDebt counts only the cash line — never print it
  })();

  const growth = (a: unknown, b: unknown): number | null => {
    const v0 = n(a);
    const v1 = n(b);
    if (v0 === null || v1 === null || v1 <= 0) return null;
    return (v0 - v1) / v1;
  };
  const revenueCagr3y = ((): number | null => {
    const now = n(inc0.revenue);
    const then = n(incLast?.revenue);
    if (now === null || then === null || then <= 0 || now <= 0) return null;
    return Math.pow(now / then, 1 / 3) - 1;
  })();

  const estimates = (parts.street?.estimates ?? []) as Record<string, unknown>[];
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
    listCurMajor,
    repCur,
    marketCap,
    marketCapReported: mcapRep,
    enterpriseValue,
    netDebt,
    netDebtToEbitda: ndToEbitda,
    balanceSheetDate,
    totalDebt,
    cashAndDeposits,
    tangibleBookAbs,
    ebitdaTTM,
    evFromBalanceSheet,
    priceFresh,
    pe,
    evEbitda,
    pb,
    pTangibleBook,
    ps,
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
    bookValuePerShare: n(rt.bookValuePerShareTTM) ?? n(ra.bookValuePerShare),
    tangibleBookPerShare: n(rt.tangibleBookValuePerShareTTM) ?? n(ra.tangibleBookValuePerShare),
    cashPerShare: n(rt.cashPerShareTTM) ?? n(ra.cashPerShare),
    fcfPerShare: n(rt.freeCashFlowPerShareTTM) ?? n(ra.freeCashFlowPerShare),
    eps: n(inc0.eps),
    epsTTM: n(rt.netIncomePerShareTTM),
    revenuePerShareTTM: n(rt.revenuePerShareTTM),
    yearLow: n(quote.yearLow),
    yearHigh: n(quote.yearHigh),
    revenueGrowth: growth(inc0.revenue, inc1?.revenue),
    ebitdaGrowth: growth(inc0.ebitda, inc1?.ebitda),
    epsGrowth: growth(inc0.eps, inc1?.eps),
    revenueCagr3y,
    consensus,
  };
}

/** Snapshot for the main dataset shape. */
export async function buildSnapshot(data: TickerData): Promise<FiguresSnapshot> {
  return snapshotFromParts({
    profile: first<Record<string, unknown>>(data.profile) ?? {},
    quote: first<Record<string, unknown>>(data.quote) ?? {},
    ratiosTTM: first<Record<string, unknown>>(data.ratiosTTM) ?? {},
    keyMetricsTTM: first<Record<string, unknown>>(data.keyMetricsTTM) ?? {},
    incomeStatements: (Array.isArray(data.incomeStatement)
      ? data.incomeStatement
      : []) as Record<string, unknown>[],
    balanceSheet: (data.balanceSheet ?? null) as Record<string, unknown> | null,
    ratiosAnnual: first<Record<string, unknown>>(data.ratios),
    keyMetricsAnnual: first<Record<string, unknown>>(data.keyMetrics),
    street: data.street,
  });
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
 * The writer/verifier fact list, rendered from the snapshot. Everything is
 * at TODAY's close with currencies handled explicitly — never fiscal-year-end
 * vintage, never a pence/pounds or cross-currency mixup.
 */
export async function buildComputedFigures(data: TickerData): Promise<ComputedFigure[]> {
  const s = await buildSnapshot(data);
  const out: (ComputedFigure | null)[] = [];
  const push = (label: string, value: string | null) => out.push(value ? { label, value } : null);

  push(
    "Price",
    s.price !== null ? `${s.listCur}${s.price >= 100 ? s.price.toFixed(0) : s.price.toFixed(2)}` : null,
  );
  // Market cap is in MAJOR units even when the price quotes in pence.
  push("Market cap", fmtMoney(s.marketCap, s.listCurMajor));
  // EV without a balance sheet is vendor-derived — say so where it prints, so
  // the writer never asserts a "true EV" the statement never backed.
  const evLabel = s.evFromBalanceSheet
    ? "Enterprise value"
    : "Enterprise value (vendor approximation — no recent balance sheet)";
  push(evLabel, fmtMoney(s.enterpriseValue, s.repCur));
  if (s.netDebt !== null) {
    const ndLabel = s.evFromBalanceSheet ? "Net debt" : "Net debt (vendor approximation)";
    push(ndLabel, s.netDebt < 0 ? `net cash ${fmtMoney(-s.netDebt, s.repCur)}` : fmtMoney(s.netDebt, s.repCur));
  }
  push("Net debt / EBITDA", s.netDebtToEbitda !== null ? `${s.netDebtToEbitda.toFixed(2)}x` : null);
  // Balance-sheet components — the note names the statement date with these.
  if (s.balanceSheetDate) {
    push("Balance sheet date", s.balanceSheetDate);
    push("Cash + short-term investments", fmtMoney(s.cashAndDeposits, s.repCur));
    push("Total debt", fmtMoney(s.totalDebt, s.repCur));
    push("Tangible book (equity − goodwill − intangibles)", fmtMoney(s.tangibleBookAbs, s.repCur));
  }

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
  push("Revenue growth (3Y CAGR)", g(s.revenueCagr3y));
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
  return `<computed_figures note="Calculated for you directly from the filings AT TODAY'S CLOSE, with currency handled correctly (each absolute figure carries its currency; ratios and margins are dimensionless; on UK names GBp means pence and GBP means pounds). USE THESE VERBATIM. Do NOT divide, multiply, or otherwise recompute raw dataset numbers yourself, and do NOT quote valuation ratios from the dataset's annual rows — those are stamped at fiscal-year-end prices and are stale. If a figure you want is not here and not stated outright in the dataset, do not calculate it: describe it qualitatively or leave it out.">
${lines}
</computed_figures>

`;
}
