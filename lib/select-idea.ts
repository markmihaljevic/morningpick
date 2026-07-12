import { db, logEvent } from "./db";
import type { Profile } from "./profile";
import { getSubscriberScreens, buildCandidatePool, type ScreenParams } from "./screens";
import type { Taste, WatchlistEntry } from "./selection";
import { ensureFactorTable, loadFactorRows } from "./factor-table";
import { scoreCandidates, deriveWeights } from "./scoring";
import { pickFromRanked } from "./pick";
import { fetchTickerData, fetchUpcomingEarnings, type TickerData } from "./fmp";
import { identityFromProfile, crossListingSpread } from "./company-key";
import { preflightCheck, type PreflightResult } from "./preflight";

/** A company already sent to this subscriber — identity-keyed (rule 1). */
export interface SentCompany {
  key: string; // ISIN or normalized-name key
  ticker: string; // the listing that was sent
  memoId: string;
  date: string; // delivery date
}

/** Divergence beyond FX that turns a cross-listing into its own idea. */
const SPREAD_THRESHOLD = 0.04;

/**
 * The no-repeat gate (John's rules 1-2-4): a company already sent stays
 * ineligible on EVERY listing until a new reported financial period — a
 * second quote line is never new information. The one exception without new
 * fundamentals: a cross-listing spread wider than a few percent beyond FX,
 * in which case the spread itself is the idea.
 */
async function checkNoRepeat(
  data: TickerData,
  candidateTicker: string,
  sentByKey: Map<string, SentCompany>,
): Promise<
  | { verdict: "fresh" }
  | { verdict: "blocked"; prior: SentCompany; reason: string }
  | { verdict: "requalified"; prior: SentCompany; development: string }
  | { verdict: "spread"; prior: SentCompany; detail: string }
> {
  const identity = identityFromProfile(data.profile);
  const prior = sentByKey.get(identity.key);
  if (!prior) return { verdict: "fresh" };

  // Results-reset (rule 2): a results RELEASE after the send date. An
  // earnings row with an actual EPS dated after the send is a release; a
  // statement PERIOD ending after the send also implies one.
  const sentAt = prior.date;
  const earnings = (data.street?.earnings ?? []) as { date?: string; epsActual?: number | null }[];
  const releasedSince = (Array.isArray(earnings) ? earnings : []).some(
    (e) => e.date && e.date > sentAt && e.epsActual !== null && e.epsActual !== undefined,
  );
  const inc0 = (Array.isArray(data.incomeStatement) ? data.incomeStatement[0] : undefined) as
    | { date?: string }
    | undefined;
  const bs = data.balanceSheet as { date?: string } | null;
  const periodSince =
    (inc0?.date !== undefined && inc0.date > sentAt) || (bs?.date !== undefined && bs.date > sentAt);
  if (releasedSince || periodSince) {
    return {
      verdict: "requalified",
      prior,
      development: `New reported results since the ${prior.date} note on ${prior.ticker} — the company re-qualifies; open with what changed and reconcile any figure from that note onto today's consistent basis.`,
    };
  }

  // Cross-listing spread (rule 4): only meaningful when the candidate is a
  // DIFFERENT listing of the sent company.
  if (candidateTicker.toUpperCase() !== prior.ticker.toUpperCase()) {
    const spread = await crossListingSpread(candidateTicker, prior.ticker);
    if (spread && spread.gapPct > SPREAD_THRESHOLD) {
      return { verdict: "spread", prior, detail: spread.detail };
    }
    return {
      verdict: "blocked",
      prior,
      reason: `same company as ${prior.ticker} sent ${prior.date} (${identity.key}); no new reported period, and the listings sit ${spread ? (spread.gapPct * 100).toFixed(1) + "%" : "≈0%"} apart — a second quote line is not a second idea`,
    };
  }
  return {
    verdict: "blocked",
    prior,
    reason: `already sent ${prior.date} (${identity.key}); no new reported period since`,
  };
}

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
  /** Set when a previously-sent company re-qualified on new results — the
   * note must open with what changed and reconcile the earlier figures. */
  requalifiedFrom?: SentCompany;
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
  /** Identity-keyed sent history (rule 1) — every listing of a sent company. */
  sentCompanies?: SentCompany[];
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
  // away) rather than shipping a name the analyst wouldn't back. The walk
  // sticks to the subscriber's OWN screens — serendipity names are for the
  // pick step's judgment, not for spending gate attempts on names outside
  // the stated mandate (observed: two attempts burned on $1B+ serendipity
  // banks against a sub-$500M profile).
  const walkPool = top.filter(
    (c) => !c.source?.startsWith("serendipity") || c.ticker.toUpperCase() === pick.ticker.toUpperCase(),
  );
  const walkOrder = [
    pick.ticker,
    ...walkPool.map((c) => c.ticker).filter((t) => t.toUpperCase() !== pick.ticker.toUpperCase()),
  ];
  const sentByKey = new Map<string, SentCompany>();
  for (const s of args.sentCompanies ?? []) {
    // Most recent send per company wins (rows arrive newest-first).
    if (!sentByKey.has(s.key)) sentByKey.set(s.key, s);
  }

  for (const ticker of walkOrder.slice(0, MAX_PREFLIGHT_ATTEMPTS)) {
    const isPick = ticker.toUpperCase() === pick.ticker.toUpperCase();
    const rankInfo = top.find((c) => c.ticker.toUpperCase() === ticker.toUpperCase());
    let rationale = isPick
      ? pick.rationale
      : `Next on the ranked list (factor score ${Math.round(rankInfo?.composite ?? 0)}) after the pick failed the conviction gate.`;
    const data = await fetchTickerData(ticker);

    // The no-repeat gate (rules 1-2-4): identity is the company, not the
    // ticker — THX.L and THX.V are one idea. Runs BEFORE pre-flight so a
    // blocked repeat never costs a conviction-gate attempt's LLM call.
    let requalifiedFrom: SentCompany | undefined;
    const repeat = await checkNoRepeat(data, ticker, sentByKey);
    if (repeat.verdict === "blocked") {
      await logEvent("norepeat_blocked", {
        subscriberId: args.subscriberId,
        payload: { ticker, prior: repeat.prior.ticker, priorDate: repeat.prior.date, reason: repeat.reason },
      });
      continue; // a second listing is not a second idea — next candidate
    }
    if (repeat.verdict === "requalified") {
      requalifiedFrom = repeat.prior;
      rationale += ` — RE-QUALIFIED: ${repeat.development}`;
    } else if (repeat.verdict === "spread") {
      rationale += ` — CROSS-LISTING SPREAD IDEA: ${repeat.detail}. The spread itself is the idea; quantify both prices and the gap, referencing the ${repeat.prior.date} note on ${repeat.prior.ticker}.`;
    }

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
      requalifiedFrom,
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
