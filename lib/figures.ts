import type { TickerData } from "./fmp";

export interface ComputedFigure {
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
  if (v === null || v <= 0 || v > 1000) return null;
  return `${v.toFixed(1)}x`;
}
/** Percent from a FRACTION (0.462 → "46.2%"). */
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
/** A currency code as a readable prefix: "USD" → "$", "GBp" → "GBp ". */
function curPrefix(code: unknown): string {
  if (typeof code !== "string" || !code) return "";
  return code === "USD" ? "$" : `${code} `;
}

/**
 * Every derived figure the analyst might reach for — computed ONCE, in code,
 * from the dataset, with currency handled explicitly. The writer quotes these
 * verbatim instead of dividing raw numbers (which is where the fact-checker
 * kept catching real errors). Ratios and margins are dimensionless and always
 * safe; absolute figures are labelled with their currency so a listing-currency
 * price is never silently compared with a reporting-currency balance-sheet item.
 *
 * Missing/degenerate inputs are omitted rather than guessed.
 */
export function buildComputedFigures(data: TickerData): ComputedFigure[] {
  const quote = first<Record<string, unknown>>(data.quote) ?? {};
  const ratios = first<Record<string, unknown>>(data.ratios) ?? {};
  const km = first<Record<string, unknown>>(data.keyMetrics) ?? {};
  const inc0 = first<Record<string, unknown>>(data.incomeStatement) ?? {};
  const inc1 = (Array.isArray(data.incomeStatement) ? data.incomeStatement[1] : undefined) as
    | Record<string, unknown>
    | undefined;
  const profile = first<Record<string, unknown>>(data.profile) ?? {};

  const listCur = curPrefix(profile.currency); // price / market cap currency
  const repCur = curPrefix(ratios.reportedCurrency ?? km.reportedCurrency ?? inc0.reportedCurrency); // financials

  const out: (ComputedFigure | null)[] = [];
  const push = (label: string, value: string | null) => out.push(value ? { label, value } : null);

  // — Price & size (listing currency for the quote; reporting currency for EV) —
  const price = num(quote.price);
  push("Price", price !== null ? `${listCur}${price >= 100 ? price.toFixed(0) : price.toFixed(2)}` : null);
  push("Market cap", fmtMoney(num(quote.marketCap), listCur));
  push("Enterprise value", fmtMoney(num(km.enterpriseValue), repCur));

  // Net debt from the ratio × EBITDA keeps it in ONE currency (no EV−cap mixing).
  const ndToEbitda = num(km.netDebtToEBITDA);
  const ebitda0 = num(inc0.ebitda);
  if (ndToEbitda !== null && ebitda0 !== null) {
    const netDebt = ndToEbitda * ebitda0;
    push("Net debt", netDebt < 0 ? `net cash ${fmtMoney(-netDebt, repCur)}` : fmtMoney(netDebt, repCur));
  }
  push("Net debt / EBITDA", ndToEbitda !== null ? `${ndToEbitda.toFixed(2)}x` : null);

  // — Valuation —
  push("P/E", fmtX(num(ratios.priceToEarningsRatio) ?? num(quote.pe)));
  push("EV/EBITDA", fmtX(num(km.evToEBITDA) ?? num(ratios.enterpriseValueMultiple)));
  push("P/B", fmtX(num(ratios.priceToBookRatio)));
  // P/tangible book from the DIMENSIONLESS ratio P/B × (book/tangible book) —
  // never price ÷ per-share, which would mix listing and reporting currencies.
  const pbForTb = num(ratios.priceToBookRatio);
  const bvpsForTb = num(ratios.bookValuePerShare);
  const tbvpsForTb = num(ratios.tangibleBookValuePerShare);
  push(
    "P/tangible book",
    pbForTb !== null && bvpsForTb !== null && tbvpsForTb !== null && tbvpsForTb > 0
      ? fmtX(pbForTb * (bvpsForTb / tbvpsForTb))
      : null,
  );
  push("P/S", fmtX(num(ratios.priceToSalesRatio)));
  push("P/FCF", fmtX(num(ratios.priceToFreeCashFlowRatio)));
  push("Earnings yield", fmtPct(num(km.earningsYield)));
  push("FCF yield", fmtPct(num(km.freeCashFlowYield)));
  push("Dividend yield", fmtPct(num(ratios.dividendYield)));
  push("Payout ratio", fmtPct(num(ratios.dividendPayoutRatio)));

  // — Margins (dimensionless; the class of number the writer kept mis-stating) —
  push("Gross margin", fmtPct(num(ratios.grossProfitMargin)));
  push("Operating margin", fmtPct(num(ratios.operatingProfitMargin)));
  push("EBIT margin", fmtPct(num(ratios.ebitMargin)));
  push("EBITDA margin", fmtPct(num(ratios.ebitdaMargin)));
  push("Net margin", fmtPct(num(ratios.netProfitMargin)));

  // — Returns —
  push("ROE", fmtPct(num(km.returnOnEquity)));
  push("ROIC", fmtPct(num(km.returnOnInvestedCapital)));
  push("ROA", fmtPct(num(km.returnOnAssets)));
  push("ROCE", fmtPct(num(km.returnOnCapitalEmployed)));

  // — Balance-sheet strength —
  push("Current ratio", num(ratios.currentRatio) !== null ? `${(num(ratios.currentRatio) as number).toFixed(2)}x` : null);
  push("Debt / equity", num(ratios.debtToEquityRatio) !== null ? `${(num(ratios.debtToEquityRatio) as number).toFixed(2)}x` : null);
  push("Interest coverage", fmtX(num(ratios.interestCoverageRatio)));

  // — Per-share (reporting currency) —
  push("Book value / share", fmtShare(num(ratios.bookValuePerShare), repCur));
  push("Tangible book / share", fmtShare(num(ratios.tangibleBookValuePerShare), repCur));
  push("Cash / share", fmtShare(num(ratios.cashPerShare), repCur));
  push("FCF / share", fmtShare(num(ratios.freeCashFlowPerShare), repCur));
  push("EPS", fmtShare(num(inc0.eps) ?? num(ratios.netIncomePerShare), repCur));

  // — 52-week position (precomputed so the writer never divides the range) —
  const low = num(quote.yearLow);
  const high = num(quote.yearHigh);
  if (price !== null && low !== null && high !== null && low > 0 && high > low) {
    const aboveLow = ((price - low) / low) * 100;
    const belowHigh = ((high - price) / high) * 100;
    const fp = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
    push(
      "52-week position",
      `${aboveLow.toFixed(0)}% above the ${listCur}${fp(low)} low, ${belowHigh.toFixed(0)}% below the ${listCur}${fp(high)} high`,
    );
  }

  // — Growth, YoY (guarded against negative/zero denominators that flip signs) —
  const growth = (label: string, a: unknown, b: unknown) => {
    const n0 = num(a);
    const n1 = num(b);
    if (n0 === null || n1 === null || n1 <= 0) return;
    push(label, `${((n0 - n1) / n1 >= 0 ? "+" : "") + (((n0 - n1) / n1) * 100).toFixed(1)}%`);
  };
  if (inc1) {
    growth("Revenue growth (YoY)", inc0.revenue, inc1.revenue);
    growth("EBITDA growth (YoY)", inc0.ebitda, inc1.ebitda);
    growth("EPS growth (YoY)", inc0.eps, inc1.eps);
  }

  // — Forward consensus per fiscal year (makes the trend explicit; kills
  //   "recovers to..." misreads when the forecast never regains a prior level) —
  const estimates = (data.street?.estimates ?? []) as Record<string, unknown>[];
  for (const e of Array.isArray(estimates) ? estimates.slice(0, 3) : []) {
    const yr = typeof e.fiscalYearEnd === "string" ? e.fiscalYearEnd.slice(0, 4) : null;
    if (!yr) continue;
    const parts = [
      fmtMoney(num(e.revenueAvg), repCur) && `rev ${fmtMoney(num(e.revenueAvg), repCur)}`,
      fmtMoney(num(e.ebitdaAvg), repCur) && `EBITDA ${fmtMoney(num(e.ebitdaAvg), repCur)}`,
      num(e.epsAvg) !== null && `EPS ${repCur}${(num(e.epsAvg) as number).toFixed(2)}`,
    ].filter(Boolean);
    if (parts.length > 0) {
      const n = num(e.numAnalystsEps);
      push(`Consensus FY${yr}`, `${parts.join(" · ")}${n ? ` (${n} analysts)` : ""}`);
    }
  }

  return out.filter((f): f is ComputedFigure => f !== null);
}

/** The prompt block: computed figures as ready-to-quote facts. */
export function computedFiguresBlock(figures: ComputedFigure[]): string {
  if (figures.length === 0) return "";
  const lines = figures.map((f) => `${f.label}: ${f.value}`).join("\n");
  return `<computed_figures note="Calculated for you directly from the filings, with currency handled correctly (each absolute figure carries its currency; ratios and margins are dimensionless). USE THESE VERBATIM. Do NOT divide, multiply, or otherwise recompute raw dataset numbers yourself — that is the single largest source of factual errors. If a figure you want is not here and not stated outright in the dataset, do not calculate it: describe it qualitatively or leave it out.">
${lines}
</computed_figures>

`;
}
