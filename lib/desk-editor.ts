import type { CoverageItem, FollowupTrigger } from "./coverage";
import { checkFollowupTrigger } from "./coverage";
import { config } from "./config";

/**
 * The desk editor: what kind of note the morning deserves.
 *
 * THE EMAIL TYPE IS A CALENDAR DECISION (John's rules, July 14), made from
 * the explicit REVIEW_WEEKDAYS config BEFORE any writing step: Monday =
 * "Your book" review, every other day = one new idea. Feedback, examples,
 * and register changes never touch this decision — by construction: nothing
 * here reads the profile, taste, or feedback.
 *
 *  review   — the scheduled read-through of the book (daily plans, review
 *             weekdays, non-empty book only)
 *  idea     — the highest-scoring screen survivor that passes the no-repeat
 *             rules (July 16: no pick step, no conviction gate — the score
 *             judges, conviction rides along as the quality signal)
 *  followup — a covered name reported or moved: a position update
 *             (idea days only — event-driven, not feedback-driven)
 *  no_idea  — the ONLY legitimate empty morning (July 16 rule 5): the screen
 *             itself returned zero shippable survivors (or every survivor is
 *             already held). The email states the funnel in numbers and asks
 *             which filter to loosen. NEVER a silent review.
 *  second_look — retained for the no-repeat requalification path; the walk
 *             assigns it, never the editor.
 */

export type NoteKind = "idea" | "followup" | "second_look" | "review" | "no_idea";

export interface DeskDecision {
  kind: NoteKind;
  ticker?: string;
  /** Why this deliverable today — flows into prompts and logs. */
  reason: string;
  followup?: FollowupTrigger;
  revisit?: CoverageItem;
}

/** The calendar rule, pure: is this UTC date a review day? */
export function isReviewDay(date: Date): boolean {
  const isoWeekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay(); // 1=Mon … 7=Sun
  return config()
    .REVIEW_WEEKDAYS.split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
    .includes(isoWeekday);
}

/** Primary decision, calendar-first, made before the idea funnel runs. */
export async function decideNote(args: {
  coverageItems: CoverageItem[];
  dailyPlan: boolean;
  /** The morning being delivered — defaults to now (UTC). */
  date?: Date;
}): Promise<DeskDecision> {
  const date = args.date ?? new Date();

  if (args.dailyPlan && isReviewDay(date)) {
    if (args.coverageItems.length > 0) {
      return {
        kind: "review",
        reason: `calendar: ${date.toISOString().slice(0, 10)} is a scheduled review day — the weekly read-through of the book. Not a fallback; nothing failed.`,
      };
    }
    // A review of an empty book is nothing — a new subscriber's Monday is an
    // idea day until there is a book to review.
    return {
      kind: "idea",
      reason: "calendar review day, but no book to review yet — hunt for a fresh idea",
    };
  }

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
  return { kind: "idea", reason: "idea day — hunt for a fresh idea" };
}

/**
 * The only legitimate empty morning (July 16 rule 5): the screen itself
 * returned zero shippable survivors — the preferences are too tight. The
 * email states the funnel in numbers and asks which filter to loosen. Never
 * a silent review, never a vague apology.
 */
export function noIdeaNote(args: { reason: string }): DeskDecision {
  return {
    kind: "no_idea",
    reason: args.reason,
  };
}
