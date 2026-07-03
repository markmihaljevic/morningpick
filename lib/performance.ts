import { db } from "./db";
import { fmpGet } from "./fmp";

interface QuoteRow {
  symbol: string;
  price?: number;
}

/** Pull the pitch-time price + currency out of already-fetched ticker data. */
export function extractPitchPrice(data: {
  quote: unknown;
  profile: unknown;
}): { price: number | null; currency: string | null } {
  const quote = (Array.isArray(data.quote) ? data.quote[0] : data.quote) as
    | { price?: number }
    | undefined;
  const profile = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as
    | { currency?: string }
    | undefined;
  return {
    price: typeof quote?.price === "number" ? quote.price : null,
    currency: profile?.currency ?? null,
  };
}

export interface MarkResult {
  marked: number;
  missing: number;
}

/**
 * Mark all sent memos with a pitch price against fresh quotes. Quotes bypass
 * the per-day FMP cache (the cached morning quote would make evening marks
 * stale). One quote request per distinct ticker.
 */
export async function markAllMemos(): Promise<MarkResult> {
  const { data: memos, error } = await db()
    .from("memos")
    .select("id, ticker, pitch_price")
    .not("pitch_price", "is", null)
    .not("sent_at", "is", null);
  if (error) throw new Error(`Memo query failed: ${error.message}`);
  if (!memos || memos.length === 0) return { marked: 0, missing: 0 };

  const tickers = [...new Set(memos.map((m) => m.ticker))];
  const prices = new Map<string, number>();
  await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const rows = await fmpGet<QuoteRow[]>("quote", { symbol: ticker }, { noCache: true });
        const price = rows?.[0]?.price;
        if (typeof price === "number" && price > 0) prices.set(ticker, price);
      } catch (e) {
        console.error(`Quote failed for ${ticker}:`, e);
      }
    }),
  );

  const now = new Date().toISOString();
  let marked = 0;
  let missing = 0;
  for (const memo of memos) {
    const price = prices.get(memo.ticker);
    if (price === undefined) {
      missing++;
      continue;
    }
    const returnPct = ((price - Number(memo.pitch_price)) / Number(memo.pitch_price)) * 100;
    const { error: updateError } = await db()
      .from("memos")
      .update({ last_price: price, last_price_at: now, return_pct: returnPct })
      .eq("id", memo.id);
    if (!updateError) marked++;
  }
  return { marked, missing };
}
