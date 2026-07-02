import { anthropic } from "./anthropic";
import { config } from "./config";
import { db, logEvent } from "./db";
import { sendEmail, replyAddress } from "./resend";
import { renderAckEmail } from "./emails/ack-email";
import { FEEDBACK_SYSTEM_PROMPT, FEEDBACK_SCHEMA, buildFeedbackPrompt } from "./prompts/feedback";

export interface FeedbackInterpretation {
  is_investment_feedback: boolean;
  is_auto_reply_suspected: boolean;
  sentiment_on_memo: "positive" | "negative" | "mixed" | "none";
  profile_updates: Record<string, unknown>;
  rewritten_philosophy: string;
  ack_summary: string;
}

/** Interpret a cleaned reply with Claude (no tools, strict JSON schema). */
export async function interpretFeedback(args: {
  structured: Record<string, unknown>;
  philosophy: string;
  memoContext: { ticker: string; title: string | null; date: string } | null;
  cleanedBody: string;
}): Promise<FeedbackInterpretation> {
  const response = await anthropic().messages.create({
    model: config().FEEDBACK_MODEL,
    max_tokens: 2000,
    output_config: {
      format: { type: "json_schema", schema: FEEDBACK_SCHEMA },
      effort: "medium",
    },
    system: FEEDBACK_SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildFeedbackPrompt(args) }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error("Feedback interpretation was refused by the model.");
  }
  const text = response.content.find((b) => b.type === "text");
  return JSON.parse(text && "text" in text ? text.text : "{}") as FeedbackInterpretation;
}

/** Merge structured profile deltas: arrays append+dedupe, scalars overwrite. */
export function mergeProfileUpdates(
  current: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const existing = Array.isArray(merged[key]) ? (merged[key] as unknown[]) : [];
      merged[key] = [...new Set([...existing, ...value].map((v) => String(v)))];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/** Apply an interpretation to the subscriber's profile and optionally send an ack. */
export async function applyFeedback(args: {
  subscriberId: string;
  subscriberEmail: string;
  feedbackId: string;
  memoId: string | null;
  interpretation: FeedbackInterpretation;
  unsubscribeToken: string;
}): Promise<void> {
  const { subscriberId, interpretation } = args;

  await db()
    .from("feedback")
    .update({ interpretation: interpretation as unknown as Record<string, unknown> })
    .eq("id", args.feedbackId);

  if (!interpretation.is_investment_feedback) return;

  const { data: profile, error } = await db()
    .from("preference_profiles")
    .select("structured, philosophy, version")
    .eq("subscriber_id", subscriberId)
    .single();
  if (error) throw new Error(`Profile load failed: ${error.message}`);

  const merged = mergeProfileUpdates(
    (profile.structured as Record<string, unknown>) ?? {},
    interpretation.profile_updates ?? {},
  );
  const { error: updateError } = await db()
    .from("preference_profiles")
    .update({
      structured: merged,
      philosophy: interpretation.rewritten_philosophy.slice(0, 2000),
      version: (profile.version as number) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("subscriber_id", subscriberId);
  if (updateError) throw new Error(`Profile update failed: ${updateError.message}`);

  await db().from("feedback").update({ applied: true }).eq("id", args.feedbackId);
  await logEvent("feedback_applied", { subscriberId, payload: { feedbackId: args.feedbackId } });

  // Ack email — throttled to one per subscriber per 6h, never for suspected auto-replies.
  if (interpretation.is_auto_reply_suspected || !interpretation.ack_summary) return;

  const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const { count } = await db()
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("type", "ack_sent")
    .eq("subscriber_id", subscriberId)
    .gte("created_at", sixHoursAgo);
  if ((count ?? 0) > 0) return;

  const replyTo = args.memoId
    ? replyAddress(args.memoId)
    : replyAddress(`welcome-${subscriberId}`);
  await sendEmail({
    to: args.subscriberEmail,
    subject: "Got your feedback",
    html: renderAckEmail(interpretation.ack_summary, args.unsubscribeToken),
    replyTo,
    unsubscribeToken: args.unsubscribeToken,
  });
  await db().from("feedback").update({ ack_sent: true }).eq("id", args.feedbackId);
  await logEvent("ack_sent", { subscriberId });
}
