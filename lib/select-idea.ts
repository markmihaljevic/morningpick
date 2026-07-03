import type { Profile } from "./profile";
import { getSubscriberScreens, buildCandidatePool, type ScreenParams } from "./screens";
import { shortlistCandidates, enrichShortlist, finalSelect, type Taste } from "./selection";
import { fetchTickerData, fetchHeadlines, fetchUpcomingEarnings, type TickerData } from "./fmp";
import { preflightCheck, type PreflightResult } from "./preflight";

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
  const shortlist = await shortlistCandidates(
    args.profile,
    pool,
    args.excluded,
    recent,
    args.taste,
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
    };
    if (preflight.write) return result;

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
