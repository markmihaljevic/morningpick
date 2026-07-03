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
  opts: { noCache?: boolean } = {},
): Promise<T> {
  const cfg = config();
  const sortedParams = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const cacheKey = `${endpoint}?${sortedParams}:${todayKey()}`;

  if (!opts.noCache) {
    const { data: cached } = await db()
      .from("fmp_cache")
      .select("payload")
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (cached) return cached.payload as T;
  }

  const { data: used, error: budgetError } = await db().rpc("increment_fmp_budget", { n: 1 });
  if (budgetError) throw new Error(`FMP budget check failed: ${budgetError.message}`);
  if ((used as number) > cfg.FMP_DAILY_BUDGET) {
    throw new FmpBudgetExceededError(used as number, cfg.FMP_DAILY_BUDGET);
  }

  const url = new URL(`${cfg.FMP_BASE_URL}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("apikey", cfg.FMP_API_KEY);

  // Parallel worker chains create bursty load — retry rate limits and
  // transient server errors with backoff before failing the delivery.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (res.ok) break;
    if (res.status !== 429 && res.status < 500) break; // non-retryable
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  if (!res || !res.ok) {
    throw new Error(`FMP ${endpoint} failed: ${res?.status} ${await res?.text()}`);
  }
  const payload = (await res.json()) as T;

  if (!opts.noCache) {
    await db().from("fmp_cache").upsert({ cache_key: cacheKey, payload });
  }
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

export interface StreetData {
  priceTargets: unknown; // consensus/high/low/median analyst price targets
  ratings: unknown; // buy/hold/sell counts + consensus label
  earnings: unknown; // recent quarters (actual vs estimated EPS) + next scheduled report
  estimates: unknown; // forward revenue/EBITDA/EPS consensus, nearest fiscal years
}

/** What the sell side thinks — coverage varies outside the US; all fail-soft. */
export async function fetchStreetData(ticker: string): Promise<StreetData> {
  const soft = async (endpoint: string, params: Record<string, string | number>) => {
    try {
      return await fmpGet(endpoint, params);
    } catch {
      return null;
    }
  };
  const [priceTargets, ratings, earnings, estimatesRaw] = await Promise.all([
    soft("price-target-consensus", { symbol: ticker }),
    soft("grades-consensus", { symbol: ticker }),
    soft("earnings", { symbol: ticker, limit: 8 }),
    soft("analyst-estimates", { symbol: ticker, period: "annual", limit: 10 }),
  ]);
  // Estimates come future-first out to 2030 — keep the nearest three fiscal years.
  const estimates = Array.isArray(estimatesRaw)
    ? (estimatesRaw as { date?: string }[])
        .filter((e) => e.date)
        .sort((a, b) => (a.date! < b.date! ? -1 : 1))
        .filter((e) => e.date! >= new Date().toISOString().slice(0, 10))
        .slice(0, 3)
        .map((e) => {
          const r = e as Record<string, unknown>;
          return {
            fiscalYearEnd: r.date,
            revenueAvg: r.revenueAvg,
            ebitdaAvg: r.ebitdaAvg,
            netIncomeAvg: r.netIncomeAvg,
            epsAvg: r.epsAvg,
            numAnalystsEps: r.numAnalystsEps ?? r.numberAnalystsEstimatedEps,
          };
        })
    : null;
  return { priceTargets, ratings, earnings, estimates };
}

export interface TranscriptExcerpt {
  period: string;
  year: number;
  date: string;
  excerpt: string; // opening remarks + Q&A tail, capped
}

const TRANSCRIPT_MAX_AGE_DAYS = 400;
const TRANSCRIPT_HEAD_CHARS = 6_000;
const TRANSCRIPT_TAIL_CHARS = 18_000;

/**
 * The latest earnings-call transcript, excerpted: opening management remarks
 * plus the Q&A (which lives at the end and is where the honesty is).
 * Fail-soft — plenty of small caps have no transcript.
 */
export async function fetchLatestTranscript(ticker: string): Promise<TranscriptExcerpt | null> {
  try {
    const dates = await fmpGet<{ quarter: number; fiscalYear: number; date: string }[]>(
      "earning-call-transcript-dates",
      { symbol: ticker },
    );
    const latest = (dates ?? [])
      .filter((d) => d.date)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (!latest) return null;
    const ageDays = (Date.now() - Date.parse(latest.date)) / 86_400_000;
    if (ageDays > TRANSCRIPT_MAX_AGE_DAYS) return null;

    const rows = await fmpGet<{ content?: string; period?: string; date?: string }[]>(
      "earning-call-transcript",
      { symbol: ticker, year: latest.fiscalYear, quarter: latest.quarter },
    );
    const content = rows?.[0]?.content;
    if (!content || content.length < 500) return null;

    const excerpt =
      content.length <= TRANSCRIPT_HEAD_CHARS + TRANSCRIPT_TAIL_CHARS
        ? content
        : content.slice(0, TRANSCRIPT_HEAD_CHARS) +
          "\n\n[… middle of call omitted …]\n\n" +
          content.slice(-TRANSCRIPT_TAIL_CHARS);
    return {
      period: rows?.[0]?.period ?? `Q${latest.quarter}`,
      year: latest.fiscalYear,
      date: latest.date,
      excerpt,
    };
  } catch (e) {
    console.error(`Transcript fetch failed for ${ticker} (non-fatal):`, e);
    return null;
  }
}

export interface Headline {
  date: string;
  title: string;
  site: string;
}

/**
 * Recent headlines for a set of tickers — ONE batched call, so news-aware
 * selection costs a single request per subscriber per morning.
 */
export async function fetchHeadlines(
  tickers: string[],
  maxPerTicker = 4,
  maxAgeDays = 14,
): Promise<Record<string, Headline[]>> {
  const out: Record<string, Headline[]> = {};
  if (tickers.length === 0) return out;
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString().slice(0, 10);
  const ingest = (
    rows: { symbol?: string; publishedDate?: string; title?: string; site?: string }[] | null,
    label?: string,
  ) => {
    for (const r of rows ?? []) {
      if (!r.symbol || !r.title || !r.publishedDate) continue;
      const date = r.publishedDate.slice(0, 10);
      if (date < cutoff) continue;
      const list = (out[r.symbol] ??= []);
      if (list.length < maxPerTicker) {
        list.push({ date, title: r.title.slice(0, 140), site: label ?? r.site ?? "" });
      }
    }
  };
  // Two batched calls: media coverage AND company press releases — European
  // small caps often have zero press coverage but active RNS/PR flow.
  const [news, prs] = await Promise.allSettled([
    fmpGet<{ symbol?: string; publishedDate?: string; title?: string; site?: string }[]>(
      "news/stock",
      { symbols: tickers.join(","), limit: 80 },
    ),
    fmpGet<{ symbol?: string; publishedDate?: string; title?: string; site?: string }[]>(
      "news/press-releases",
      { symbols: tickers.join(","), limit: 80 },
    ),
  ]);
  if (news.status === "fulfilled") ingest(news.value);
  else console.error("Headline fetch failed (non-fatal):", news.reason);
  if (prs.status === "fulfilled") ingest(prs.value, "press release");
  else console.error("Press-release fetch failed (non-fatal):", prs.reason);
  return out;
}

/**
 * Upcoming earnings dates for a set of tickers — ONE calendar call for the
 * whole market (cached per day, shared across every subscriber), filtered
 * locally. Names reporting soon carry a built-in "why now".
 */
export async function fetchUpcomingEarnings(
  tickers: string[],
  daysAhead = 21,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  if (tickers.length === 0) return out;
  try {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + daysAhead * 86_400_000).toISOString().slice(0, 10);
    const rows = await fmpGet<{ symbol?: string; date?: string }[]>("earnings-calendar", {
      from,
      to,
    });
    const wanted = new Set(tickers.map((t) => t.toUpperCase()));
    for (const r of rows ?? []) {
      if (!r.symbol || !r.date) continue;
      const sym = r.symbol.toUpperCase();
      if (wanted.has(sym) && !out[sym]) out[sym] = r.date.slice(0, 10);
    }
  } catch (e) {
    console.error("Earnings calendar fetch failed (non-fatal):", e);
  }
  return out;
}

export interface TickerData {
  profile: unknown;
  quote: unknown;
  keyMetrics: unknown;
  ratios: unknown;
  incomeStatement: unknown;
  insiderTrades: InsiderTrade[];
  street: StreetData;
  latestTranscript: TranscriptExcerpt | null;
}

/** Fetch the grounding dataset for one ticker (~12 FMP requests, cached per day). */
export async function fetchTickerData(ticker: string): Promise<TickerData> {
  const symbol = { symbol: ticker };
  const [profile, quote, keyMetrics, ratios, incomeStatement, insiderTrades, street, latestTranscript] =
    await Promise.all([
      fmpGet("profile", symbol),
      fmpGet("quote", symbol),
      fmpGet("key-metrics", { ...symbol, limit: 1 }),
      fmpGet("ratios", { ...symbol, limit: 1 }),
      fmpGet("income-statement", { ...symbol, limit: 2 }),
      fetchInsiderTrades(ticker),
      fetchStreetData(ticker),
      fetchLatestTranscript(ticker),
    ]);
  return { profile, quote, keyMetrics, ratios, incomeStatement, insiderTrades, street, latestTranscript };
}
