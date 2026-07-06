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
 * When both idea candidates fail pre-flight: still send an idea. An analyst
 * on a quiet morning sends the most interesting thing they found and says
 * plainly that it's a quieter day — they don't go silent or change the job.
 */
export async function fallbackNote(args: {
  coverageItems: CoverageItem[];
  reason: string;
}): Promise<DeskDecision> {
  return {
    kind: "idea",
    reason: `${args.reason} — no candidate cleared the bar cleanly today; write the best available one with honest, measured conviction (say plainly if it's a quieter morning).`,
  };
}
