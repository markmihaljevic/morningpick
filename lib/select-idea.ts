import { db } from "./db";
import type { Profile } from "./profile";
import { getSubscriberScreens, buildCandidatePool, type ScreenParams } from "./screens";
import {
  shortlistCandidates,
  enrichShortlist,
  finalSelect,
  type Taste,
  type WatchlistEntry,
} from "./selection";
import { fetchTickerData, fetchHeadlines, fetchUpcomingEarnings, type TickerData } from "./fmp";
import { preflightCheck, type PreflightResult } from "./preflight";

const WATCHLIST_MAX_AGE_DAYS = 45;

/**
 * The idea funnel with the pre-flight veto: screens → pool → shortlist →
 * enrichment → pick → FULL dataset → head-of-research check. If the pick
 * looks weak with real numbers on the desk, one more candidate gets the same
 * treatment. `ok: false` means both attempts failed pre-flight — the caller
 * decides whether to steward the book instead or ship the best attempt with
 * honest conviction.
 */

const MAX_PREFLIGHT_ATTEMPTS = 2;

export interface IdeaAttempt {
  ticker: string;
  write: boolean;
  expectedConviction: number;
  reason: string;
}

export interface IdeaSelection {
  ok: boolean;
  ticker: string;
  companyName?: string;
  rationale: string;
  data: TickerData;
  preflight: PreflightResult;
  attempts: IdeaAttempt[];
  /** Selector-flagged near-misses + pre-flight rejects — pipeline food. */
  flagged: { ticker: string; reason: string }[];
  upcomingEarnings: Record<string, string>;
}

export async function selectIdeaWithPreflight(args: {
  subscriberId: string;
  profile: Profile;
  profileVersion: number;
  storedScreens: ScreenParams[];
  storedScreensVersion: number;
  excluded: string[];
  recentTickers: string[];
  taste?: Taste;
}): Promise<IdeaSelection> {
  const screens = await getSubscriberScreens(
    args.subscriberId,
    args.profile,
    args.profileVersion,
    args.storedScreens,
    args.storedScreensVersion,
  );
  const pool = await buildCandidatePool(screens);
  const recent = args.recentTickers.map((t) => ({ ticker: t }));

  // The pipeline: names flagged on earlier mornings rejoin today's hunt.
  const { data: watchRows } = await db()
    .from("watchlist")
    .select("ticker, name, reason, next_catalyst_date, added_at")
    .eq("subscriber_id", args.subscriberId)
    .gte("added_at", new Date(Date.now() - WATCHLIST_MAX_AGE_DAYS * 86_400_000).toISOString())
    .order("next_catalyst_date", { ascending: true, nullsFirst: false })
    .limit(12);
  const watchlist: WatchlistEntry[] = (watchRows ?? []).map((w) => ({
    ticker: w.ticker,
    name: w.name,
    reason: w.reason,
    nextCatalystDate: w.next_catalyst_date,
  }));

  const shortlist = await shortlistCandidates(
    args.profile,
    pool,
    args.excluded,
    recent,
    args.taste,
    watchlist,
  );
  const [enriched, headlines, upcomingEarnings] = await Promise.all([
    enrichShortlist(shortlist),
    fetchHeadlines(shortlist.map((c) => c.ticker)),
    fetchUpcomingEarnings(shortlist.map((c) => c.ticker)),
  ]);
  const sectorByTicker = new Map(pool.map((c) => [c.ticker.toUpperCase(), c.sector]));
  const recentWithSectors = args.recentTickers.map((t) => ({
    ticker: t,
    sector: sectorByTicker.get(t.toUpperCase()) ?? undefined,
  }));

  const attempts: IdeaAttempt[] = [];
  const flagged: { ticker: string; reason: string }[] = [];
  let candidates = enriched;
  let best: IdeaSelection | null = null;

  for (let attempt = 0; attempt < MAX_PREFLIGHT_ATTEMPTS && candidates.length > 0; attempt++) {
    const selection = await finalSelect(
      args.profile,
      candidates,
      recentWithSectors,
      args.taste,
      headlines,
      upcomingEarnings,
    );
    for (const w of selection.watchlist ?? []) {
      if (!flagged.some((f) => f.ticker.toUpperCase() === w.ticker.toUpperCase())) flagged.push(w);
    }
    const data = await fetchTickerData(selection.ticker);
    const preflight = await preflightCheck({
      ticker: selection.ticker,
      data,
      selectionRationale: selection.rationale,
      profile: args.profile,
    });
    attempts.push({
      ticker: selection.ticker,
      write: preflight.write,
      expectedConviction: preflight.expectedConviction,
      reason: preflight.reason,
    });

    const result: IdeaSelection = {
      ok: preflight.write,
      ticker: selection.ticker,
      companyName: pool.find((c) => c.ticker.toUpperCase() === selection.ticker.toUpperCase())
        ?.name,
      rationale: selection.rationale,
      data,
      preflight,
      attempts,
      flagged,
      upcomingEarnings,
    };
    if (preflight.write) return result;

    // A pre-flight reject may simply be early — track it until it ripens.
    if (!flagged.some((f) => f.ticker.toUpperCase() === selection.ticker.toUpperCase())) {
      flagged.push({
        ticker: selection.ticker,
        reason: `pre-flight veto at ${preflight.expectedConviction}/10: ${preflight.reason}`,
      });
    }

    // Keep the stronger of the failed attempts as the fallback-of-last-resort.
    if (!best || preflight.expectedConviction > best.preflight.expectedConviction) {
      best = result;
    }
    candidates = candidates.filter(
      (c) => c.ticker.toUpperCase() !== selection.ticker.toUpperCase(),
    );
  }

  if (!best) throw new Error("Idea funnel produced no candidates.");
  return { ...best, attempts };
}

/**
 * Persist pipeline state after a morning's selection: near-misses the
 * selector flagged and pre-flight rejects (they may ripen) go on the
 * watchlist; the picked name comes off; stale entries expire by age.
 */
export async function updateWatchlist(args: {
  subscriberId: string;
  pickedTicker: string | null;
  flagged: { ticker: string; reason: string }[];
  upcomingEarnings?: Record<string, string>;
}): Promise<void> {
  try {
    const now = new Date().toISOString();
    const rows = args.flagged
      .filter((f) => f.ticker && f.ticker.toUpperCase() !== (args.pickedTicker ?? "").toUpperCase())
      .slice(0, 6)
      .map((f) => ({
        subscriber_id: args.subscriberId,
        ticker: f.ticker,
        reason: f.reason.slice(0, 240),
        next_catalyst_date: args.upcomingEarnings?.[f.ticker.toUpperCase()] ?? null,
        last_seen_at: now,
      }));
    if (rows.length > 0) {
      await db().from("watchlist").upsert(rows, { onConflict: "subscriber_id,ticker" });
    }
    if (args.pickedTicker) {
      await db()
        .from("watchlist")
        .delete()
        .eq("subscriber_id", args.subscriberId)
        .eq("ticker", args.pickedTicker);
    }
    await db()
      .from("watchlist")
      .delete()
      .eq("subscriber_id", args.subscriberId)
      .lt("added_at", new Date(Date.now() - WATCHLIST_MAX_AGE_DAYS * 86_400_000).toISOString());
  } catch (e) {
    console.error("Watchlist update failed (non-fatal):", e);
  }
}
