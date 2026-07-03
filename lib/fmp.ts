import { config } from "./config";
import { db } from "./db";

export class FmpBudgetExceededError extends Error {
  constructor(used: number, budget: number) {
    super(
      `FMP daily budget exhausted (${used}/${budget} requests). ` +
        `Raise FMP_DAILY_BUDGET or upgrade the FMP plan.`,
    );
    this.name = "FmpBudgetExceededError";
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * GET an FMP endpoint with a per-(endpoint, params, day) cache in Postgres and
 * a hard daily request budget. Cached hits cost nothing against the budget,
 * which lets many subscribers share the same ticker data.
 */
export async function fmpGet<T = unknown>(
  endpoint: string,
  params: Record<string, string | number> = {},
): Promise<T> {
  const cfg = config();
  const sortedParams = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const cacheKey = `${endpoint}?${sortedParams}:${todayKey()}`;

  const { data: cached } = await db()
    .from("fmp_cache")
    .select("payload")
    .eq("cache_key", cacheKey)
    .maybeSingle();
  if (cached) return cached.payload as T;

  const { data: used, error: budgetError } = await db().rpc("increment_fmp_budget", { n: 1 });
  if (budgetError) throw new Error(`FMP budget check failed: ${budgetError.message}`);
  if ((used as number) > cfg.FMP_DAILY_BUDGET) {
    throw new FmpBudgetExceededError(used as number, cfg.FMP_DAILY_BUDGET);
  }

  const url = new URL(`${cfg.FMP_BASE_URL}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("apikey", cfg.FMP_API_KEY);

  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`FMP ${endpoint} failed: ${res.status} ${await res.text()}`);
  }
  const payload = (await res.json()) as T;

  await db().from("fmp_cache").upsert({ cache_key: cacheKey, payload });
  return payload;
}

export interface InsiderTrade {
  date: string;
  name: string;
  role: string;
  type: string;
  acquiredOrDisposed: string;
  shares: number;
  price: number;
  sharesOwnedAfter: number;
}

interface RawInsiderTrade {
  transactionDate?: string;
  reportingName?: string;
  typeOfOwner?: string;
  transactionType?: string;
  acquisitionOrDisposition?: string;
  securitiesTransacted?: number;
  price?: number;
  securitiesOwned?: number;
}

/**
 * Recent insider transactions (SEC-sourced — empty for most non-US listings).
 * Compact-mapped so it can go straight into the memo prompt.
 */
export async function fetchInsiderTrades(ticker: string): Promise<InsiderTrade[]> {
  try {
    const rows = await fmpGet<RawInsiderTrade[]>("insider-trading/search", {
      symbol: ticker,
      limit: 25,
    });
    return (rows ?? [])
      .filter((r) => r.transactionDate)
      .slice(0, 12)
      .map((r) => ({
        date: r.transactionDate ?? "",
        name: r.reportingName ?? "",
        role: r.typeOfOwner ?? "",
        type: r.transactionType ?? "",
        acquiredOrDisposed: r.acquisitionOrDisposition ?? "",
        shares: r.securitiesTransacted ?? 0,
        price: r.price ?? 0,
        sharesOwnedAfter: r.securitiesOwned ?? 0,
      }));
  } catch (e) {
    console.error(`Insider trades fetch failed for ${ticker}:`, e);
    return [];
  }
}

export interface TickerData {
  profile: unknown;
  quote: unknown;
  keyMetrics: unknown;
  ratios: unknown;
  incomeStatement: unknown;
  insiderTrades: InsiderTrade[];
}

/** Fetch the grounding dataset for one ticker (~6 FMP requests, cached per day). */
export async function fetchTickerData(ticker: string): Promise<TickerData> {
  const symbol = { symbol: ticker };
  const [profile, quote, keyMetrics, ratios, incomeStatement, insiderTrades] = await Promise.all([
    fmpGet("profile", symbol),
    fmpGet("quote", symbol),
    fmpGet("key-metrics", { ...symbol, limit: 1 }),
    fmpGet("ratios", { ...symbol, limit: 1 }),
    fmpGet("income-statement", { ...symbol, limit: 2 }),
    fetchInsiderTrades(ticker),
  ]);
  return { profile, quote, keyMetrics, ratios, incomeStatement, insiderTrades };
}
