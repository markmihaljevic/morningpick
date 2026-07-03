import { after } from "next/server";
import { db, logEvent } from "./db";
import { config } from "./config";
import { sendEmail, replyAddress } from "./resend";
import { renderWelcomeEmail } from "./emails/welcome-email";

/** Activate a pending subscriber via confirm token. Idempotent. */
export async function confirmSubscriber(token: string): Promise<"confirmed" | "invalid"> {
  const { data: subscriber } = await db()
    .from("subscribers")
    .select("id, email, status, unsubscribe_token")
    .eq("confirm_token", token)
    .maybeSingle();
  if (!subscriber) return "invalid";
  if (subscriber.status === "active") return "confirmed"; // idempotent re-click

  // Activate and rotate the confirm token so the link is single-use.
  const { error } = await db()
    .from("subscribers")
    .update({
      status: "active",
      confirmed_at: new Date().toISOString(),
      confirm_token: crypto.randomUUID(),
    })
    .eq("id", subscriber.id);
  if (error) return "invalid";

  await logEvent("confirmed", { subscriberId: subscriber.id });

  try {
    await sendEmail({
      to: subscriber.email,
      subject: "Welcome — your first note is being written right now",
      html: renderWelcomeEmail(subscriber.unsubscribe_token),
      replyTo: replyAddress(`welcome-${subscriber.id}`),
      unsubscribeToken: subscriber.unsubscribe_token,
    });
  } catch (e) {
    console.error("Welcome email failed:", e);
  }

  // Instant first note: enqueue today's delivery and kick one worker chain.
  // Activation beats cadence — a free subscriber confirming on a Tuesday
  // should not wait six days to see the product.
  try {
    const today = new Date().toISOString().slice(0, 10);
    await db()
      .from("deliveries")
      .upsert([{ subscriber_id: subscriber.id, delivery_date: today }], {
        onConflict: "subscriber_id,delivery_date",
        ignoreDuplicates: true,
      });
    const cfg = config();
    after(async () => {
      await fetch(`${cfg.APP_URL}/api/internal/process`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.CRON_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hop: 0, chain: 99 }),
      }).catch((e) => console.error("First-note worker kick failed:", e));
    });
    await logEvent("first_note_enqueued", { subscriberId: subscriber.id });
  } catch (e) {
    console.error("First-note enqueue failed (subscriber will get the next scheduled run):", e);
  }
  return "confirmed";
}

/** Unsubscribe via token. Returns true if a subscriber matched. */
export async function unsubscribeByToken(token: string): Promise<boolean> {
  const { data } = await db()
    .from("subscribers")
    .update({ status: "unsubscribed" })
    .eq("unsubscribe_token", token)
    .select("id")
    .maybeSingle();
  if (data) await logEvent("unsubscribed", { subscriberId: data.id });
  return Boolean(data);
}
