import type { CoverageItem, FollowupTrigger } from "./coverage";
import { checkFollowupTrigger } from "./coverage";
import { fetchUpcomingEarnings } from "./fmp";

/**
 * The desk editor: decides what KIND of note this subscriber's morning
 * deserves. The calendar never forces a weak idea — on days the market
 * offers nothing new, stewardship of existing coverage IS the product.
 *
 *  idea        — a fresh pick (still subject to the pre-flight veto)
 *  followup    — a covered name reported or moved (existing trigger logic)
 *  second_look — deeper work on a covered name where something developed
 *  review      — the book, marked to market: what moved, what it means
 */

export type NoteKind = "idea" | "followup" | "second_look" | "review";

export interface DeskDecision {
  kind: NoteKind;
  /** Set for followup / second_look. */
  ticker?: string;
  /** Why this deliverable today — flows into prompts and logs. */
  reason: string;
  followup?: FollowupTrigger;
  /** For second_look: the coverage item being revisited. */
  revisit?: CoverageItem;
}

const SECOND_LOOK_MIN_AGE_DAYS = 5;
const REVIEW_MIN_BOOK = 3;
const REVIEW_COOLDOWN_DAYS = 6;
const SECOND_LOOK_COOLDOWN_DAYS = 2;

function daysSince(date: string): number {
  return (Date.now() - Date.parse(date)) / 86_400_000;
}

/** Primary decision, made before the idea funnel runs. */
export async function decideNote(args: {
  coverageItems: CoverageItem[];
  dailyPlan: boolean;
}): Promise<DeskDecision> {
  if (args.dailyPlan) {
    const trigger = await checkFollowupTrigger(args.coverageItems);
    if (trigger) {
      return {
        kind: "followup",
        ticker: trigger.ticker,
        reason: trigger.detail,
        followup: trigger,
      };
    }
  }
  return { kind: "idea", reason: "no follow-up trigger — hunt for a fresh idea" };
}

/**
 * Fallback when the idea funnel's candidates fail pre-flight: choose the
 * best stewardship note instead. Returns an `idea` decision only when the
 * book is too thin to steward (new subscribers must get an idea, honestly
 * scored, rather than a review of nothing).
 */
export async function fallbackNote(args: {
  coverageItems: CoverageItem[];
  reason: string; // why the idea path was abandoned
}): Promise<DeskDecision> {
  const items = args.coverageItems;
  const activeBook = items.filter((i) => i.kind !== "review");

  if (activeBook.length < REVIEW_MIN_BOOK) {
    return {
      kind: "idea",
      reason: `${args.reason} — but the book is too thin to steward; write the best available idea with honest conviction`,
    };
  }

  const recentSecondLook = items.some(
    (i) => i.kind === "second_look" && daysSince(i.date) < SECOND_LOOK_COOLDOWN_DAYS,
  );

  if (!recentSecondLook) {
    // Second look target: an aged covered name with a nearby catalyst, else
    // the biggest mover that hasn't earned a full follow-up.
    const candidates = latestPerTicker(items).filter(
      (i) => i.kind !== "review" && daysSince(i.date) >= SECOND_LOOK_MIN_AGE_DAYS,
    );
    if (candidates.length > 0) {
      const earnings = await fetchUpcomingEarnings(candidates.map((c) => c.ticker), 14);
      const withCatalyst = candidates
        .filter((c) => earnings[c.ticker.toUpperCase()])
        .sort(
          (a, b) =>
            earnings[a.ticker.toUpperCase()].localeCompare(earnings[b.ticker.toUpperCase()]),
        );
      const target =
        withCatalyst[0] ??
        [...candidates].sort((a, b) => Math.abs(b.returnPct ?? 0) - Math.abs(a.returnPct ?? 0))[0];
      if (target) {
        const catalyst = earnings[target.ticker.toUpperCase()];
        return {
          kind: "second_look",
          ticker: target.ticker,
          revisit: target,
          reason:
            `${args.reason} — instead, revisit ${target.ticker}` +
            (catalyst
              ? ` ahead of its ${catalyst} earnings`
              : ` (${target.returnPct ?? 0}% since the ${target.date} note)`),
        };
      }
    }
  }

  const recentReview = items.some(
    (i) => i.kind === "review" && daysSince(i.date) < REVIEW_COOLDOWN_DAYS,
  );
  if (!recentReview) {
    return {
      kind: "review",
      reason: `${args.reason} — review the book instead: mark every open call to market`,
    };
  }

  return {
    kind: "idea",
    reason: `${args.reason} — stewardship notes exhausted this week; write the best available idea with honest conviction`,
  };
}

function latestPerTicker(items: CoverageItem[]): CoverageItem[] {
  const latest = new Map<string, CoverageItem>();
  for (const i of items) {
    const existing = latest.get(i.ticker);
    if (!existing || i.date > existing.date) latest.set(i.ticker, i);
  }
  return [...latest.values()];
}
