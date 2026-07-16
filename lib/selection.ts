/**
 * Shared selection types. The old LLM funnels (shortlist→finalSelect, then
 * score→pick with a conviction gate) were retired in July 2026 for the
 * two-tier funnel: screen (hard preferences only, lib/screens) → score (rank
 * in code, lib/scoring) → the top survivor past the no-repeat rules SHIPS
 * (lib/select-idea). No pick step, no gate — conviction is assessed after
 * selection and rides along as the quality signal.
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
