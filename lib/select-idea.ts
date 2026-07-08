import { db, logEvent } from "./db";
import type { Profile } from "./profile";
import { getSubscriberScreens, buildCandidatePool, type ScreenParams } from "./screens";
import type { Taste, WatchlistEntry } from "./selection";
import { ensureFactorTable, loadFactorRows } from "./factor-table";
import { scoreCandidates, deriveWeights } from "./scoring";
import { pickFromRanked } from "./pick";
import { fetchTickerData, fetchUpcomingEarnings, type TickerData } from "./fmp";
import { preflightCheck, type PreflightResult } from "./preflight";

const WATCHLIST_MAX_AGE_DAYS = 45;

/**
 * The idea funnel: screen (exclude) → score (rank in code, no LLM) → pick
 * (small LLM step over the top of the ranked list) → FULL dataset →
 * head-of-research check with a CONVICTION GATE. A name that pre-flights
 * below the gate never leads the morning: the funnel walks DOWN the ranked
 * list to the next name instead. `ok: false` means the top of the ranked
 * list is genuinely weak today — the caller stewards the book rather than
 * shipping a name the analyst wouldn't put money behind.
 */

const MAX_PREFLIGHT_ATTEMPTS = 4;
const MIN_CONVICTION = 6;
const RANKED_FOR_PICK = 20;

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

  // Screening excluded; now the SCORER ranks. Exclusions: recent coverage +
  // profile avoid-list, applied before scoring so percentiles reflect the
  // universe the subscriber can actually be pitched.
  const excluded = new Set(args.excluded.map((t) => t.toUpperCase()));
  const avoid = Array.isArray(args.profile.structured?.avoid_tickers)
    ? (args.profile.structured.avoid_tickers as string[]).map((t) => t.toUpperCase())
    : [];
  for (const t of avoid) excluded.add(t);
  const eligible = pool.filter((c) => !excluded.has(c.ticker.toUpperCase()));
  if (eligible.length === 0) throw new Error("No eligible candidates after exclusions.");
  // Watchlist names keep their seat even when today's screens rotated past
  // them (they'll be quarantined harmlessly if factor data is missing).
  const inPool = new Set(eligible.map((c) => c.ticker.toUpperCase()));
  for (const w of watchlist) {
    const t = w.ticker.toUpperCase();
    if (!inPool.has(t) && !excluded.has(t)) {
      eligible.push({ ticker: w.ticker, name: w.name ?? w.ticker, source: "watchlist" });
    }
  }

  // Score: pure code over the shared factor table. Zero tokens.
  await ensureFactorTable();
  const factorRows = await loadFactorRows(eligible.map((c) => c.ticker));
  const weights = deriveWeights(args.profile);
  const { ranked, quarantined } = scoreCandidates(eligible, factorRows, weights);
  if (ranked.length === 0) {
    throw new Error(
      `Scoring left no rankable candidates (pool ${pool.length}, eligible ${eligible.length}, quarantined ${quarantined.length}).`,
    );
  }
  await logEvent("scoring_ran", {
    subscriberId: args.subscriberId,
    payload: {
      pool: pool.length,
      eligible: eligible.length,
      ranked: ranked.length,
      quarantined: quarantined.length,
      weights,
      top5: ranked.slice(0, 5).map((c) => ({ t: c.ticker, s: Math.round(c.composite) })),
    },
  });

  const top = ranked.slice(0, RANKED_FOR_PICK);
  const upcomingEarnings = await fetchUpcomingEarnings(top.map((c) => c.ticker));
  const sectorByTicker = new Map(pool.map((c) => [c.ticker.toUpperCase(), c.sector]));
  const recentWithSectors = args.recentTickers.map((t) => ({
    ticker: t,
    sector: sectorByTicker.get(t.toUpperCase()) ?? undefined,
  }));

  // Pick: the one small LLM step — judgment over the top of the ranked list.
  const pick = await pickFromRanked({
    profile: args.profile,
    ranked: top,
    recentMemos: recentWithSectors,
    taste: args.taste,
    watchlist,
    upcomingEarnings,
  });

  const attempts: IdeaAttempt[] = [];
  const flagged: { ticker: string; reason: string }[] = [...pick.watchlist];
  let best: IdeaSelection | null = null;

  // The conviction gate: pre-flight the pick with the full dataset; below the
  // gate, take the NEXT name on the ranked list (its data is one cached fetch
  // away) rather than shipping a name the analyst wouldn't back.
  const walkOrder = [
    pick.ticker,
    ...top.map((c) => c.ticker).filter((t) => t.toUpperCase() !== pick.ticker.toUpperCase()),
  ];
  for (const ticker of walkOrder.slice(0, MAX_PREFLIGHT_ATTEMPTS)) {
    const isPick = ticker.toUpperCase() === pick.ticker.toUpperCase();
    const rankInfo = top.find((c) => c.ticker.toUpperCase() === ticker.toUpperCase());
    const rationale = isPick
      ? pick.rationale
      : `Next on the ranked list (factor score ${Math.round(rankInfo?.composite ?? 0)}) after the pick failed the conviction gate.`;
    const data = await fetchTickerData(ticker);
    const preflight = await preflightCheck({
      ticker,
      data,
      selectionRationale: rationale,
      profile: args.profile,
    });
    const passes = preflight.write && preflight.expectedConviction >= MIN_CONVICTION;
    attempts.push({
      ticker,
      write: passes,
      expectedConviction: preflight.expectedConviction,
      reason: preflight.reason,
    });

    const result: IdeaSelection = {
      ok: passes,
      ticker,
      companyName:
        pool.find((c) => c.ticker.toUpperCase() === ticker.toUpperCase())?.name ??
        rankInfo?.name,
      rationale,
      data,
      preflight,
      attempts,
      flagged,
      upcomingEarnings,
    };
    if (passes) return result;

    // A gated name may simply be early — track it until it ripens.
    if (!flagged.some((f) => f.ticker.toUpperCase() === ticker.toUpperCase())) {
      flagged.push({
        ticker,
        reason: `conviction gate at ${preflight.expectedConviction}/10: ${preflight.reason}`,
      });
    }
    if (!best || preflight.expectedConviction > best.preflight.expectedConviction) {
      best = result;
    }
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
