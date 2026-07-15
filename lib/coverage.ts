import { db } from "./db";
import { config } from "./config";
import { fmpGet } from "./fmp";

/** One prior note in the subscriber's coverage history. */
export interface CoverageItem {
  memoId: string;
  ticker: string;
  /** Authoritative display name from the memo row — the writer must NEVER
   * infer a company name from a ticker (CJ.TO was once prosed as "Cenovus";
   * it is Cardinal Energy). */
  companyName: string | null;
  date: string;
  title: string | null;
  kind: string;
  oneLiner: string | null;
  conviction: number | null;
  pitchPrice: number | null;
  pitchCurrency: string | null;
  priceNow: number | null;
  returnPct: number | null;
  sentiment: string | null; // subscriber's reaction, if they replied
  callStatus: string; // active | watching | closed
}

export interface TasteSignal {
  liked: string[]; // tickers with positive reaction
  disliked: string[]; // tickers with negative reaction
}

export interface FollowupTrigger {
  ticker: string;
  reason: "earnings" | "price_move";
  detail: string; // human-readable, goes into the prompt
  lastNote: CoverageItem;
}

const COVERAGE_WINDOW_DAYS = 120;
const COVERAGE_PROMPT_ITEMS = 8;
const PRICE_TRIGGER_QUIET_DAYS = 7;

interface QuoteRow {
  price?: number;
}

/**
 * The analyst's memory: the subscriber's recent notes with live returns and
 * the subscriber's reactions. Quotes are fetched via the per-day cache, so
 * cost is one call per distinct recent ticker per day across all subscribers.
 */
export async function getCoverageContext(subscriberId: string): Promise<{
  items: CoverageItem[];
  taste: TasteSignal;
}> {
  const since = new Date(Date.now() - COVERAGE_WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const { data: memos } = await db()
    .from("memos")
    .select("id, ticker, company_name, delivery_date, title, kind, pitch_price, pitch_currency, call_status, extras")
    .eq("subscriber_id", subscriberId)
    .not("sent_at", "is", null)
    .gte("delivery_date", since)
    .order("delivery_date", { ascending: false });

  // No-idea mornings are not coverage: nothing was pitched, there is nothing
  // to mark to market or review. They exist only as the day's honest record.
  const rows = (memos ?? []).filter((m) => m.kind !== "no_idea");
  if (rows.length === 0) return { items: [], taste: { liked: [], disliked: [] } };

  const { data: reactions } = await db()
    .from("feedback")
    .select("memo_id, interpretation")
    .eq("subscriber_id", subscriberId)
    .not("memo_id", "is", null);
  const sentimentByMemo = new Map<string, string>();
  for (const r of reactions ?? []) {
    const s = (r.interpretation as { sentiment_on_memo?: string } | null)?.sentiment_on_memo;
    if (r.memo_id && s && s !== "none") sentimentByMemo.set(r.memo_id, s);
  }

  const tickers = [...new Set(rows.map((m) => m.ticker))];
  const prices = new Map<string, number>();
  await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const quote = await fmpGet<QuoteRow[]>("quote", { symbol: ticker });
        const price = quote?.[0]?.price;
        if (typeof price === "number" && price > 0) prices.set(ticker, price);
      } catch {
        /* memo history still useful without a live price */
      }
    }),
  );

  const items: CoverageItem[] = rows.map((m) => {
    const extras = (m.extras ?? {}) as {
      meta?: { one_liner?: string; conviction?: number } | null;
    };
    const priceNow = prices.get(m.ticker) ?? null;
    const pitch = m.pitch_price === null ? null : Number(m.pitch_price);
    return {
      memoId: m.id,
      ticker: m.ticker,
      companyName: (m as { company_name?: string | null }).company_name ?? null,
      date: m.delivery_date,
      title: m.title,
      kind: m.kind ?? "idea",
      oneLiner: extras.meta?.one_liner ?? null,
      conviction: extras.meta?.conviction ?? null,
      pitchPrice: pitch,
      pitchCurrency: m.pitch_currency,
      priceNow,
      returnPct:
        pitch && priceNow ? Number((((priceNow - pitch) / pitch) * 100).toFixed(1)) : null,
      sentiment: sentimentByMemo.get(m.id) ?? null,
      callStatus: (m as { call_status?: string }).call_status ?? "active",
    };
  });

  const taste: TasteSignal = { liked: [], disliked: [] };
  for (const item of items) {
    if (item.sentiment === "positive" && !taste.liked.includes(item.ticker)) {
      taste.liked.push(item.ticker);
    }
    if (item.sentiment === "negative" && !taste.disliked.includes(item.ticker)) {
      taste.disliked.push(item.ticker);
    }
  }
  return { items, taste };
}

/**
 * Pull the headline and the "What I'd act on" item out of a review's markdown
 * so the NEXT review can avoid repeating either (John's July 14 P.S.). The
 * book strip only records prices/status, and a review's persisted call is its
 * headline — the buried act item is not otherwise recoverable.
 */
export function extractReviewGist(markdown: string): { headline: string; action: string } {
  const headline = (markdown.match(/^#\s+(.+)$/m)?.[1] ?? "")
    .replace(/^your book\s*[—–-]\s*/i, "")
    .trim();
  const actionSection =
    markdown.match(/^##\s*What I['’]d act on\s*$([\s\S]*?)(?=^##\s|^#\s|\Z)/im)?.[1] ??
    markdown.match(/^##\s*What I['’]d act on\s*\n([\s\S]*?)(?:\n##\s|\n#\s|$)/im)?.[1] ??
    "";
  const action = actionSection.replace(/\s+/g, " ").trim().slice(0, 300);
  return { headline, action };
}

/** Compact coverage summary for prompts. */
export function coverageForPrompt(items: CoverageItem[]): unknown[] {
  return items.slice(0, COVERAGE_PROMPT_ITEMS).map((i) => ({
    ticker: i.ticker,
    company: i.companyName, // authoritative — never infer a name from a ticker
    date: i.date,
    kind: i.kind,
    call: i.oneLiner ?? i.title,
    conviction: i.conviction,
    pitchedAt: i.pitchPrice,
    now: i.priceNow,
    returnPct: i.returnPct,
    callStatus: i.callStatus,
    subscriberReaction: i.sentiment,
  }));
}

/** One open call in the ledger strip. */
export interface BookRow {
  ticker: string;
  date: string;
  pitchPrice: number | null;
  currency: string | null;
  priceNow: number | null;
  returnPct: number | null;
  status: string; // active | watching
}

/**
 * The open book: latest note per ticker, closed calls and reviews excluded.
 * This is the accountability strip — pitched price against today's, dated.
 */
export function buildBookRows(items: CoverageItem[]): BookRow[] {
  const latest = new Map<string, CoverageItem>();
  for (const i of items) {
    if (i.ticker === "REVIEW" || i.kind === "review") continue;
    const existing = latest.get(i.ticker);
    if (!existing || i.date > existing.date) latest.set(i.ticker, i);
  }
  return [...latest.values()]
    .filter((i) => i.callStatus !== "closed")
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((i) => ({
      ticker: i.ticker,
      date: i.date,
      pitchPrice: i.pitchPrice,
      currency: i.pitchCurrency,
      priceNow: i.priceNow,
      returnPct: i.returnPct,
      status: i.callStatus,
    }));
}

interface EarningsRow {
  date?: string;
  epsActual?: number | null;
}

/**
 * Does any covered name deserve a follow-up note today?
 *  - earnings: the company reported since the last note on it
 *  - price_move: moved ≥ FOLLOWUP_MOVE_PCT since the last note (with a quiet
 *    period so fresh notes aren't immediately re-covered)
 * Earnings beats price moves; most recent trigger wins.
 */
export async function checkFollowupTrigger(
  items: CoverageItem[],
): Promise<FollowupTrigger | null> {
  const movePct = config().FOLLOWUP_MOVE_PCT;
  const today = new Date().toISOString().slice(0, 10);

  // Latest note per ticker.
  const latestByTicker = new Map<string, CoverageItem>();
  for (const item of items) {
    const existing = latestByTicker.get(item.ticker);
    if (!existing || item.date > existing.date) latestByTicker.set(item.ticker, item);
  }

  let priceCandidate: FollowupTrigger | null = null;
  for (const note of latestByTicker.values()) {
    // Earnings trigger: reported strictly after the note, on or before today.
    try {
      const earnings = await fmpGet<EarningsRow[]>("earnings", { symbol: note.ticker, limit: 8 });
      const reported = (earnings ?? []).find(
        (e) => e.date && e.date > note.date && e.date <= today && e.epsActual != null,
      );
      if (reported?.date) {
        return {
          ticker: note.ticker,
          reason: "earnings",
          detail: `${note.ticker} reported earnings on ${reported.date}, after your ${note.date} note.`,
          lastNote: note,
        };
      }
    } catch {
      /* fall through to price trigger */
    }

    const noteAgeDays = (Date.parse(today) - Date.parse(note.date)) / 86_400_000;
    if (
      noteAgeDays >= PRICE_TRIGGER_QUIET_DAYS &&
      note.pitchPrice &&
      note.priceNow &&
      Math.abs(note.returnPct ?? 0) >= movePct
    ) {
      if (!priceCandidate || Math.abs(note.returnPct!) > Math.abs(priceCandidate.lastNote.returnPct!)) {
        priceCandidate = {
          ticker: note.ticker,
          reason: "price_move",
          detail: `${note.ticker} has moved ${note.returnPct}% since your ${note.date} note (${note.pitchPrice} → ${note.priceNow}).`,
          lastNote: note,
        };
      }
    }
  }
  return priceCandidate;
}
