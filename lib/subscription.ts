import { db, logEvent } from "./db";
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
      subject: "Welcome — your first memo arrives tomorrow morning",
      html: renderWelcomeEmail(subscriber.unsubscribe_token),
      replyTo: replyAddress(`welcome-${subscriber.id}`),
      unsubscribeToken: subscriber.unsubscribe_token,
    });
  } catch (e) {
    console.error("Welcome email failed:", e);
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
