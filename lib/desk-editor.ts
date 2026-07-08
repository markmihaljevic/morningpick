import type { CoverageItem, FollowupTrigger } from "./coverage";
import { checkFollowupTrigger } from "./coverage";

/**
 * The desk editor: what kind of note the morning deserves. Simplified to how
 * an analyst actually works with their boss — a fresh idea every morning,
 * except when a name you already flagged just moved, in which case you send
 * a quick update instead.
 *
 *  idea     — a fresh pick (subject to the pre-flight veto; on veto, the best
 *             available idea is written honestly rather than forced-cheerful)
 *  followup — a covered name reported or moved: a position update
 *
 * (second_look / review are retained in the type for legacy call sites but the
 * editor no longer chooses them — the product is one idea a day.)
 */

export type NoteKind = "idea" | "followup" | "second_look" | "review";

export interface DeskDecision {
  kind: NoteKind;
  ticker?: string;
  /** Why this deliverable today — flows into prompts and logs. */
  reason: string;
  followup?: FollowupTrigger;
  revisit?: CoverageItem;
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
 * When every candidate fails the conviction gate: NEVER lead the morning with
 * a name the analyst wouldn't put money behind. With a book to steward, the
 * morning becomes a coverage review — marking open calls to market IS the
 * work on a weak-tape day. Only a brand-new subscriber with no book gets the
 * best available idea, framed honestly as a quieter morning.
 */
export async function fallbackNote(args: {
  coverageItems: CoverageItem[];
  reason: string;
}): Promise<DeskDecision> {
  if (args.coverageItems.length > 0) {
    return {
      kind: "review",
      reason: `${args.reason} — no fresh candidate cleared the conviction gate today; steward the book instead of pitching a name the desk wouldn't back.`,
    };
  }
  return {
    kind: "idea",
    reason: `${args.reason} — no candidate cleared the bar cleanly and there is no book to review yet; write the best available one with honest, measured conviction (say plainly it's a quieter morning).`,
  };
}
