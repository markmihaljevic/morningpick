/**
 * Shared selection types. The old two-stage LLM funnel (shortlist over the
 * raw pool → finalSelect over enriched rows) was retired in July 2026 for
 * the scoring funnel: screen (exclude) → score (rank in code, lib/scoring)
 * → pick (one small LLM step, lib/pick). Ranking now happens on fresh-price
 * factor percentiles, not model judgment over stale FY-end ratios.
 */

export interface Taste {
  liked: string[];
  disliked: string[];
}

export interface WatchlistEntry {
  ticker: string;
  name: string | null;
  reason: string;
  nextCatalystDate: string | null;
}
