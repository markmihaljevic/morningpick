/**
 * Simulate an inbound reply without a receiving domain — runs the same
 * interpret → profile-update → ack path as the Resend webhook.
 *
 *   npx tsx scripts/simulate-reply.ts you@example.com "More European small caps, less US tech please"
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { db } from "../lib/db";
import { interpretFeedback, applyFeedback } from "../lib/feedback";

async function main() {
  const [email, ...words] = process.argv.slice(2);
  const replyText = words.join(" ");
  if (!email || !replyText) {
    console.error('Usage: npx tsx scripts/simulate-reply.ts you@example.com "your feedback text"');
    process.exit(1);
  }

  const { data: subscriber, error } = await db()
    .from("subscribers")
    .select("id, email, unsubscribe_token")
    .eq("email", email)
    .single();
  if (error) throw new Error(`Subscriber not found: ${error.message}`);

  const { data: memo } = await db()
    .from("memos")
    .select("id, ticker, title, delivery_date")
    .eq("subscriber_id", subscriber.id)
    .order("delivery_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: profile } = await db()
    .from("preference_profiles")
    .select("structured, philosophy")
    .eq("subscriber_id", subscriber.id)
    .single();

  const { data: stub, error: stubError } = await db()
    .from("feedback")
    .insert({
      subscriber_id: subscriber.id,
      memo_id: memo?.id ?? null,
      inbound_email_id: `simulated-${Date.now()}`,
      raw_subject: "Simulated reply",
      cleaned_body: replyText,
    })
    .select("id")
    .single();
  if (stubError) throw new Error(stubError.message);

  console.error("Interpreting feedback…");
  const interpretation = await interpretFeedback({
    structured: (profile?.structured as Record<string, unknown>) ?? {},
    philosophy: (profile?.philosophy as string) ?? "",
    memoContext: memo
      ? { ticker: memo.ticker, title: memo.title, date: memo.delivery_date }
      : null,
    cleanedBody: replyText,
  });
  console.log(JSON.stringify(interpretation, null, 2));

  await applyFeedback({
    subscriberId: subscriber.id,
    subscriberEmail: subscriber.email,
    feedbackId: stub.id,
    memoId: memo?.id ?? null,
    interpretation,
    unsubscribeToken: subscriber.unsubscribe_token,
  });

  const { data: updated } = await db()
    .from("preference_profiles")
    .select("structured, philosophy, version")
    .eq("subscriber_id", subscriber.id)
    .single();
  console.error("\nUpdated profile:");
  console.log(JSON.stringify(updated, null, 2));
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
