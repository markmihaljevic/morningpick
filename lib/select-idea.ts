import { db, logEvent } from "./db";
import type { Profile } from "./profile";
import { getSubscriberScreens, buildCandidatePool, type ScreenParams } from "./screens";
import { ensureFactorTable, loadFactorRows } from "./factor-table";
import { scoreCandidates, deriveWeights, deriveValuationMetricWeights } from "./scoring";
import { fetchTickerData, fetchUpcomingEarnings, type TickerData } from "./fmp";
import { identityFromProfile, crossListingSpread } from "./company-key";
import { preflightCheck, type PreflightResult } from "./preflight";

/** A company already sent to this subscriber — identity-keyed (rule 1). */
export interface SentCompany {
  key: string; // ISIN or normalized-name key
  /** Name-based second key: DR/ADR lines carry different ISINs than local
   * ordinaries, so identity must match on EITHER key. */
  nameKey?: string | null;
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
  // Match on EITHER key: a GDR's US ISIN differs from the local line's home
  // ISIN, but the normalized name catches the pair.
  const prior =
    sentByKey.get(identity.key) ??
    (identity.nameKey ? sentByKey.get(identity.nameKey) : undefined);
  if (!prior) return { verdict: "fresh" };

  // Results-reset (rule 2): a results RELEASE after the send date, detected
  // three ways — an earnings row with actual EPS dated after the send, a
  // statement FILED after the send (filingDate covers releases for periods
  // that ended before the send), or a statement PERIOD ending after it.
  const sentAt = prior.date;
  const earnings = (data.street?.earnings ?? []) as { date?: string; epsActual?: number | null }[];
  const releasedSince = (Array.isArray(earnings) ? earnings : []).some(
    (e) => e.date && e.date > sentAt && e.epsActual !== null && e.epsActual !== undefined,
  );
  const inc0 = (Array.isArray(data.incomeStatement) ? data.incomeStatement[0] : undefined) as
    | { date?: string; fillingDate?: string; filingDate?: string; acceptedDate?: string }
    | undefined;
  const bs = data.balanceSheet as
    | { date?: string; fillingDate?: string; filingDate?: string; acceptedDate?: string }
    | null;
  const filedAfter = (row: typeof inc0 | typeof bs): boolean => {
    const filed = row?.fillingDate ?? row?.filingDate ?? row?.acceptedDate;
    return typeof filed === "string" && filed.slice(0, 10) > sentAt;
  };
  const periodSince =
    (inc0?.date !== undefined && inc0.date > sentAt) ||
    (bs?.date !== undefined && bs.date > sentAt) ||
    filedAfter(inc0) ||
    filedAfter(bs);
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

/**
 * Cheap release check for pool-level exclusions (rule 2): has this ticker
 * released results since the date? Day-cached earnings rows; fail-soft to
 * false (stays excluded — conservative, never a wrongful resend).
 */
export async function hasReportedSince(ticker: string, sinceDate: string): Promise<boolean> {
  try {
    const rows = await fmpGetEarnings(ticker);
    return rows.some((e) => e.date && e.date > sinceDate && e.epsActual !== null && e.epsActual !== undefined);
  } catch {
    return false;
  }
}
async function fmpGetEarnings(ticker: string): Promise<{ date?: string; epsActual?: number | null }[]> {
  const { fmpGet } = await import("./fmp");
  const rows = await fmpGet<{ date?: string; epsActual?: number | null }[]>("earnings", {
    symbol: ticker,
    limit: 4,
  });
  return Array.isArray(rows) ? rows : [];
}

const WATCHLIST_MAX_AGE_DAYS = 45;

/**
 * The idea funnel — two tiers, one shipping rule (John, July 16): the screen
 * eliminates on hard preferences only; the SCORE does the judging; the
 * morning email is the highest-scoring survivor that passes the no-repeat
 * rules. No LLM pick, no conviction gate, no veto — a ranked list always has
 * a top name. Conviction is assessed AFTER selection and rides along as the
 * quality signal ("best of a quiet list, 4/10"), never as silence.
 * `ok: false` means the screen itself returned zero survivors (or every
 * survivor is a company already held) — the caller sends the funnel-in-
 * numbers email, the only legitimate empty morning.
 */

// Bounds fetchTickerData calls when the top of the list is a run of already-
// sent companies — a cost cap, not a judgment cap.
const MAX_WALK_FETCHES = 25;
// Rule 4: "if today's top score sits well below its trailing average, say
// so plainly." Composite is a 0-100 percentile blend; 8 points below the
// trailing average of the last 14 runs' top scores reads as genuinely quiet.
const QUIET_LIST_TRAILING_RUNS = 14;
const QUIET_LIST_DELTA = 8;

export interface IdeaAttempt {
  ticker: string;
  write: boolean;
  expectedConviction: number;
  reason: string;
}

/** The funnel in numbers — rule 4's quiet-list signal and rule 5's email. */
export interface FunnelStats {
  perScreen: { label: string; count: number }[];
  poolAfterDedup: number;
  domicileDropped: number;
  /** Example names the hard filters dropped — rule 5: a name the client
   * cannot check is not information. */
  domicileDroppedSample: { ticker: string; name?: string; country?: string }[];
  sectorDropped: number;
  sectorDroppedSample: { ticker: string; name?: string; sector?: string }[];
  allowedCountries: string[] | null;
  eligible: number;
  ranked: number;
  quarantined: number;
  quarantinedSample: { ticker: string; name?: string; reason?: string }[];
  /** 1-based rank of the shipped name on today's list (1 unless names ahead
   * of it were skipped — held companies or technical fetch failures). */
  rank: number | null;
  /** Already-held companies skipped ahead of the shipped name. */
  blockedAhead: { ticker: string; name?: string; priorTicker: string; priorDate: string }[];
  /** Names skipped on dataset-fetch failure (technical, never judgment). */
  fetchFailedAhead: string[];
  topComposite: number | null;
  shippedComposite: number | null;
  /** Trailing average of daily top scores (last 14 RUNS, however old — a
   * weekly subscriber's runs are weeks apart); null with <3 runs. */
  trailingAvgTop: number | null;
  quietList: boolean;
  weights: Record<string, number>;
  valuationMetrics: Record<string, number>;
}

export interface IdeaSelection {
  ok: boolean;
  ticker: string;
  companyName?: string;
  rationale: string;
  data: TickerData;
  preflight: PreflightResult;
  attempts: IdeaAttempt[];
  /** Retired with the pick step — kept for call-site compatibility. */
  flagged: { ticker: string; reason: string }[];
  upcomingEarnings: Record<string, string>;
  /** Set when a previously-sent company re-qualified on new results — the
   * note must open with what changed and reconcile the earlier figures. */
  requalifiedFrom?: SentCompany;
  funnel: FunnelStats;
}

export async function selectIdeaWithPreflight(args: {
  subscriberId: string;
  profile: Profile;
  profileVersion: number;
  storedScreens: ScreenParams[];
  storedScreensVersion: number;
  excluded: string[];
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
  const { pool, stats } = await buildCandidatePool(screens, args.profile);

  // (Watchlist re-entry RETIRED with the pick step, July 16: it pushed names
  // into the pool AROUND the screens and the domicile filter — a structural
  // hard-preference bypass. The screen decides who is on the page, period.)

  // Screening excluded; now the SCORER ranks. Exclusions: recent coverage +
  // profile avoid-list, applied before scoring so percentiles reflect the
  // universe the subscriber can actually be pitched.
  const excluded = new Set(args.excluded.map((t) => t.toUpperCase()));
  const avoid = Array.isArray(args.profile.structured?.avoid_tickers)
    ? (args.profile.structured.avoid_tickers as string[]).map((t) => t.toUpperCase())
    : [];
  for (const t of avoid) excluded.add(t);
  const eligible = pool.filter((c) => !excluded.has(c.ticker.toUpperCase()));

  // Score: pure code over the shared factor table. Zero tokens. Weights AND
  // the intra-valuation metric emphasis (P/TBV and P/S first for deep-value
  // profiles) come from the profile and are logged every run — feedback moves
  // a weight or a filter, never a hidden bar.
  await ensureFactorTable();
  const factorRows = await loadFactorRows(eligible.map((c) => c.ticker));
  const weights = deriveWeights(args.profile);
  const valuationMetrics = deriveValuationMetricWeights(args.profile);
  const { ranked, quarantined } = scoreCandidates(eligible, factorRows, weights, valuationMetrics);

  // Rule 4's quiet-list signal: today's top score against the trailing
  // average of the last N RUNS (read BEFORE logging today's run). Runs, not
  // days: a weekly subscriber's runs are weeks apart and a day-windowed
  // query would leave the baseline permanently null for them.
  const { data: priorRuns } = await db()
    .from("events")
    .select("payload")
    .eq("type", "scoring_ran")
    .eq("subscriber_id", args.subscriberId)
    .order("created_at", { ascending: false })
    .limit(QUIET_LIST_TRAILING_RUNS);
  const priorTops = (priorRuns ?? [])
    .map((r) => (r.payload as { top5?: { s?: number }[] } | null)?.top5?.[0]?.s)
    .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
  const trailingAvgTop =
    priorTops.length >= 3 ? priorTops.reduce((a, b) => a + b, 0) / priorTops.length : null;
  const topComposite = ranked.length > 0 ? ranked[0].composite : null;
  const quietList =
    trailingAvgTop !== null && topComposite !== null && topComposite < trailingAvgTop - QUIET_LIST_DELTA;

  const funnel: FunnelStats = {
    perScreen: stats.perScreen,
    poolAfterDedup: stats.afterDedup,
    domicileDropped: stats.domicileDropped,
    domicileDroppedSample: stats.domicileDroppedSample,
    sectorDropped: stats.sectorDropped,
    sectorDroppedSample: stats.sectorDroppedSample,
    allowedCountries: stats.allowedCountries,
    eligible: eligible.length,
    ranked: ranked.length,
    quarantined: quarantined.length,
    quarantinedSample: quarantined
      .slice(0, 3)
      .map((q) => ({ ticker: q.ticker, name: q.name, reason: q.quarantined })),
    rank: null,
    blockedAhead: [],
    fetchFailedAhead: [],
    topComposite,
    shippedComposite: null,
    trailingAvgTop,
    quietList,
    weights: weights as unknown as Record<string, number>,
    valuationMetrics: valuationMetrics as unknown as Record<string, number>,
  };

  await logEvent("scoring_ran", {
    subscriberId: args.subscriberId,
    payload: {
      pool: pool.length,
      eligible: eligible.length,
      ranked: ranked.length,
      quarantined: quarantined.length,
      weights,
      valuationMetrics,
      perScreen: stats.perScreen,
      domicileDropped: stats.domicileDropped,
      top5: ranked.slice(0, 5).map((c) => ({ t: c.ticker, s: Math.round(c.composite) })),
    },
  });

  // Rule 5: the only legitimate empty morning is the screen itself returning
  // zero survivors — surface the funnel in numbers, never a silent fallback.
  if (ranked.length === 0) {
    return emptyFunnelResult(
      funnel,
      `zero rankable survivors: screens returned ${stats.afterDedup} names, ` +
        `${stats.domicileDropped} dropped outside the subscriber's geographies, ` +
        `${eligible.length} eligible after coverage exclusions, ${quarantined.length} quarantined on data quality`,
      [],
    );
  }

  const upcomingEarnings = await fetchUpcomingEarnings(ranked.slice(0, 20).map((c) => c.ticker));

  const sentByKey = new Map<string, SentCompany>();
  for (const s of args.sentCompanies ?? []) {
    // Most recent send per company wins (rows arrive newest-first). Indexed
    // under BOTH identities so a DR line matches its local ordinary.
    if (!sentByKey.has(s.key)) sentByKey.set(s.key, s);
    if (s.nameKey && !sentByKey.has(s.nameKey)) sentByKey.set(s.nameKey, s);
  }

  // One shipping rule: walk the ranked list top-down; the first survivor past
  // the no-repeat gate ships. No pick, no conviction gate — the score already
  // judged. Skips are only no-repeat blocks and hard data failures (logged,
  // and tracked SEPARATELY: a fetch outage must never masquerade as "your
  // filters are too tight").
  const attempts: IdeaAttempt[] = [];
  let fetches = 0;
  let fetchFailures = 0;
  for (let i = 0; i < ranked.length && fetches < MAX_WALK_FETCHES; i++) {
    const candidate = ranked[i];
    const ticker = candidate.ticker;
    fetches++;
    let data: TickerData;
    try {
      data = await fetchTickerData(ticker);
    } catch (e) {
      console.error(`fetchTickerData failed for ${ticker} (skipping, technical):`, e);
      fetchFailures++;
      funnel.fetchFailedAhead.push(ticker);
      attempts.push({ ticker, write: false, expectedConviction: 0, reason: "dataset fetch failed (technical skip)" });
      continue;
    }

    // The no-repeat gate (July 12 rules): identity is the company, not the
    // ticker — THX.L and THX.V are one idea.
    let requalifiedFrom: SentCompany | undefined;
    let rationale =
      `Ranked #${i + 1} of ${ranked.length} on today's list (factor score ${Math.round(candidate.composite)}; ` +
      `top factors: valuation ${Math.round(candidate.factors.valuation ?? 0)}, returns ${Math.round(candidate.factors.returns ?? 0)}).`;
    const repeat = await checkNoRepeat(data, ticker, sentByKey);
    if (repeat.verdict === "blocked") {
      await logEvent("norepeat_blocked", {
        subscriberId: args.subscriberId,
        payload: { ticker, prior: repeat.prior.ticker, priorDate: repeat.prior.date, reason: repeat.reason },
      });
      funnel.blockedAhead.push({
        ticker,
        name: candidate.name,
        priorTicker: repeat.prior.ticker,
        priorDate: repeat.prior.date,
      });
      attempts.push({ ticker, write: false, expectedConviction: 0, reason: `no-repeat: ${repeat.reason}` });
      continue;
    }
    if (repeat.verdict === "requalified") {
      requalifiedFrom = repeat.prior;
      rationale += ` — RE-QUALIFIED: ${repeat.development}`;
    } else if (repeat.verdict === "spread") {
      rationale += ` — CROSS-LISTING SPREAD IDEA: ${repeat.detail}. The spread itself is the idea; quantify both prices and the gap, referencing the ${repeat.prior.date} note on ${repeat.prior.ticker}.`;
    }

    // Conviction assessment — the quality signal the note carries, never a
    // veto (rule 4). The name ships regardless of the number.
    const preflight = await preflightCheck({
      ticker,
      data,
      selectionRationale: rationale,
      profile: args.profile,
    });
    attempts.push({
      ticker,
      write: true,
      expectedConviction: preflight.expectedConviction,
      reason: preflight.reason,
    });
    funnel.rank = i + 1;
    funnel.shippedComposite = candidate.composite;

    return {
      ok: true,
      ticker,
      companyName:
        pool.find((c) => c.ticker.toUpperCase() === ticker.toUpperCase())?.name ?? candidate.name,
      rationale,
      data,
      preflight,
      attempts,
      flagged: [],
      upcomingEarnings,
      requalifiedFrom,
      funnel,
    };
  }

  // The walk ended without shipping. Three distinct cases — only one of them
  // is a legitimate empty morning, and none of them may be misreported:
  const walked = fetches;
  // (a) Data outage: every skip was a technical fetch failure. Throw so the
  // delivery RETRIES — a broken data feed is not "your filters are too
  // tight", and rule 5 forbids sending that email on a false premise.
  if (fetchFailures === walked && walked > 0) {
    throw new Error(
      `Idea walk: all ${walked} dataset fetches failed (FMP outage?) — failing the delivery for retry, not an empty-funnel email.`,
    );
  }
  // (b) The fetch cap stopped us with ranked names still unexamined: we have
  // NOT established the funnel is empty, so say so honestly and retry.
  if (ranked.length > walked) {
    throw new Error(
      `Idea walk: hit the ${MAX_WALK_FETCHES}-fetch cap with ${ranked.length - walked} ranked survivors unexamined ` +
        `(${funnel.blockedAhead.length} already-held, ${fetchFailures} fetch failures among the walked) — ` +
        `failing for retry rather than falsely reporting an empty funnel.`,
    );
  }
  // (c) The genuine case: every ranked survivor was walked and blocked as an
  // already-held company (with perhaps a few technical skips). Name them.
  return emptyFunnelResult(
    funnel,
    `every ranked survivor was walked: ${funnel.blockedAhead.length} are companies already sent with no new reported period` +
      (funnel.blockedAhead.length > 0
        ? ` (${funnel.blockedAhead.map((b) => b.ticker).join(", ")})`
        : "") +
      (fetchFailures > 0 ? `; ${fetchFailures} skipped on dataset-fetch failure (${funnel.fetchFailedAhead.join(", ")})` : ""),
    attempts,
    upcomingEarnings,
  );
}

function emptyFunnelResult(
  funnel: FunnelStats,
  reason: string,
  attempts: IdeaAttempt[],
  upcomingEarnings: Record<string, string> = {},
): IdeaSelection {
  return {
    ok: false,
    ticker: "",
    rationale: reason,
    data: null as unknown as TickerData, // rule-5 email path never touches the dataset
    preflight: { expectedConviction: 0, reason, whatWouldChange: "" },
    attempts,
    flagged: [],
    upcomingEarnings,
    funnel,
  };
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
