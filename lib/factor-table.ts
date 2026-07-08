import { config } from "./config";
import { db, logEvent } from "./db";

/**
 * The global factor table: raw TTM factor inputs for every listed name,
 * refreshed once per day from FMP's bulk endpoints (two CSV downloads for the
 * entire universe) and shared by every subscriber. Per-user scoring is a pure
 * re-weighting of this table — no API calls, no tokens, milliseconds per user.
 */

/** The columns we keep — everything scoring needs, nothing more. */
const RATIO_COLS = [
  "grossProfitMarginTTM",
  "ebitdaMarginTTM",
  "operatingProfitMarginTTM",
  "netProfitMarginTTM",
  "currentRatioTTM",
  "priceToEarningsRatioTTM",
  "priceToBookRatioTTM",
  "priceToSalesRatioTTM",
  "priceToFreeCashFlowRatioTTM",
  "debtToEquityRatioTTM",
  "interestCoverageRatioTTM",
  "dividendPayoutRatioTTM",
  "dividendYieldTTM",
  "capitalExpenditureCoverageRatioTTM",
  "enterpriseValueMultipleTTM",
  "revenuePerShareTTM",
  "netIncomePerShareTTM",
  "cashPerShareTTM",
  "bookValuePerShareTTM",
  "tangibleBookValuePerShareTTM",
  "operatingCashFlowPerShareTTM",
  "capexPerShareTTM",
  "freeCashFlowPerShareTTM",
  "dividendPerShareTTM",
] as const;

const KM_COLS = [
  "marketCap",
  "enterpriseValueTTM",
  "evToEBITDATTM",
  "netDebtToEBITDATTM",
  "returnOnEquityTTM",
  "returnOnInvestedCapitalTTM",
  "returnOnCapitalEmployedTTM",
  "earningsYieldTTM",
  "freeCashFlowYieldTTM",
  "incomeQualityTTM",
  "capexToOperatingCashFlowTTM",
] as const;

export type FactorRow = { symbol: string } & Partial<
  Record<(typeof RATIO_COLS)[number] | (typeof KM_COLS)[number], number>
>;

/** Parse one bulk CSV (numeric columns + quoted symbol; no embedded commas). */
function parseBulkCsv(csv: string, keep: readonly string[]): Map<string, Record<string, number>> {
  const lines = csv.split("\n");
  const header = (lines[0] ?? "").split(",").map((h) => h.replace(/"/g, "").trim());
  const symbolIdx = header.indexOf("symbol");
  const keepIdx = keep
    .map((col) => [col, header.indexOf(col)] as const)
    .filter(([, i]) => i >= 0);
  const out = new Map<string, Record<string, number>>();
  if (symbolIdx < 0) return out;
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const symbol = cells[symbolIdx]?.replace(/"/g, "").trim();
    if (!symbol) continue;
    const row: Record<string, number> = {};
    for (const [col, idx] of keepIdx) {
      const v = Number(cells[idx]);
      if (Number.isFinite(v) && v !== 0) row[col] = v;
    }
    out.set(symbol.toUpperCase(), row);
  }
  return out;
}

async function fetchBulkCsv(endpoint: string): Promise<string> {
  const cfg = config();
  // Bulk endpoints paginate by `part`; in practice part=0 carries the whole
  // universe today. Follow additional parts defensively until an empty one.
  let all = "";
  for (let part = 0; part < 4; part++) {
    const res = await fetch(
      `https://financialmodelingprep.com/stable/${endpoint}?part=${part}&apikey=${cfg.FMP_API_KEY}`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!res.ok) {
      if (part > 0) break; // later parts may simply not exist
      throw new Error(`${endpoint} part ${part} failed: ${res.status}`);
    }
    const text = await res.text();
    const body = part === 0 ? text : text.split("\n").slice(1).join("\n");
    if (body.trim().split("\n").length <= 1) break;
    all += (part === 0 ? "" : "\n") + body;
    if (text.length < 10_000) break; // tiny tail — done
  }
  return all;
}

/** Rebuild the global factor table from the bulk endpoints. ~1-2 minutes. */
export async function rebuildFactorTable(): Promise<number> {
  const [ratiosCsv, kmCsv] = await Promise.all([
    fetchBulkCsv("ratios-ttm-bulk"),
    fetchBulkCsv("key-metrics-ttm-bulk"),
  ]);
  const ratios = parseBulkCsv(ratiosCsv, RATIO_COLS);
  const km = parseBulkCsv(kmCsv, KM_COLS);

  const rows: { symbol: string; data: Record<string, number>; updated_at: string }[] = [];
  const now = new Date().toISOString();
  for (const [symbol, r] of ratios) {
    const k = km.get(symbol) ?? {};
    // Skip empty shells: no market cap AND no book value means no basis to score.
    if (!k.marketCap && !r.bookValuePerShareTTM) continue;
    rows.push({ symbol, data: { ...r, ...k }, updated_at: now });
  }

  // Batched upserts — the whole universe in ~1000-row chunks.
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await db()
      .from("factor_rows")
      .upsert(rows.slice(i, i + 1000), { onConflict: "symbol" });
    if (error) throw new Error(`factor_rows upsert failed at ${i}: ${error.message}`);
  }
  await logEvent("factor_table_rebuilt", { payload: { rows: rows.length } });
  return rows.length;
}

/**
 * Ensure the factor table is fresh enough to score on. One worker per day
 * wins the build lock (an fmp_cache sentinel row) and rebuilds; everyone else
 * proceeds immediately with existing rows — yesterday's factors are an
 * acceptable fallback, an empty table is not.
 */
export async function ensureFactorTable(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: newest } = await db()
    .from("factor_rows")
    .select("updated_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const fresh = newest && newest.updated_at >= `${today}T00:00:00`;
  if (fresh) return;

  // Build lock: first insert wins; losers use whatever rows exist.
  const { error: lockError } = await db()
    .from("fmp_cache")
    .insert({ cache_key: `factor-table-build:${today}`, payload: { startedAt: new Date().toISOString() } });
  const wonLock = !lockError;
  if (wonLock) {
    try {
      await rebuildFactorTable();
      return;
    } catch (e) {
      console.error("Factor table rebuild failed (falling back to existing rows):", e);
    }
  }
  if (!newest) {
    // No rows at all and someone else holds the lock (or the build failed):
    // wait briefly for the winner, then check once more.
    await new Promise((r) => setTimeout(r, 30_000));
    const { data: retry } = await db().from("factor_rows").select("symbol").limit(1).maybeSingle();
    if (!retry) throw new Error("Factor table is empty and could not be built.");
  }
}

/** Load factor rows for a set of tickers (chunked .in() queries). */
export async function loadFactorRows(tickers: string[]): Promise<Map<string, FactorRow>> {
  const out = new Map<string, FactorRow>();
  const symbols = [...new Set(tickers.map((t) => t.toUpperCase()))];
  for (let i = 0; i < symbols.length; i += 400) {
    const { data, error } = await db()
      .from("factor_rows")
      .select("symbol, data")
      .in("symbol", symbols.slice(i, i + 400));
    if (error) throw new Error(`factor_rows load failed: ${error.message}`);
    for (const row of data ?? []) {
      out.set(row.symbol, { symbol: row.symbol, ...(row.data as Record<string, number>) });
    }
  }
  return out;
}
