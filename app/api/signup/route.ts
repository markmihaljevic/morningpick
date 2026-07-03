import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { z } from "zod";
import { db, logEvent } from "@/lib/db";
import { sendEmail } from "@/lib/resend";
import { renderConfirmEmail } from "@/lib/emails/confirm-email";

export const runtime = "nodejs";

const bodySchema = z.object({
  email: z.string().email().max(254),
  website: z.string().optional(), // honeypot — real users leave this empty
});

const OK = NextResponse.json({ ok: true, message: "Check your email to confirm." });

export async function POST(req: NextRequest): Promise<NextResponse> {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, message: "Please enter a valid email." }, { status: 400 });
  }
  // Honeypot filled → almost certainly a bot. Pretend success.
  if (parsed.data.website) return OK;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const ipHash = createHash("sha256").update(ip).digest("hex").slice(0, 32);

  // Rate limits: 5 attempts/hour per IP, 200 signups/day globally.
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [{ count: ipCount }, { count: globalCount }] = await Promise.all([
    db().from("events").select("id", { count: "exact", head: true })
      .eq("type", "signup_attempt").eq("ip_hash", ipHash).gte("created_at", hourAgo),
    db().from("events").select("id", { count: "exact", head: true })
      .eq("type", "signup_attempt").gte("created_at", dayAgo),
  ]);
  if ((ipCount ?? 0) >= 5 || (globalCount ?? 0) >= 200) return OK; // silent drop

  await logEvent("signup_attempt", { ipHash });

  const email = parsed.data.email.toLowerCase();
  const { data: existing } = await db()
    .from("subscribers")
    .select("id, status, confirm_token, unsubscribe_token")
    .eq("email", email)
    .maybeSingle();

  // Already active → say so. Sign-in reveals subscription status anyway,
  // so pretending to send a confirmation is pure confusion, not protection.
  if (existing && existing.status === "active") {
    return NextResponse.json({ ok: true, already: true });
  }

  let subscriber = existing;
  if (!subscriber) {
    const { data: moiRow } = await db()
      .from("moi_members")
      .select("email")
      .eq("email", email)
      .maybeSingle();
    const { data: created, error } = await db()
      .from("subscribers")
      .insert({ email, moi_member: Boolean(moiRow) })
      .select("id, status, confirm_token, unsubscribe_token")
      .single();
    if (error) {
      console.error("Signup insert failed:", error);
      return OK; // don't leak internals
    }
    subscriber = created;
    await db().from("preference_profiles").insert({ subscriber_id: created.id });
  } else if (subscriber.status === "unsubscribed" || subscriber.status === "bounced") {
    // Re-signup after unsubscribe: back to pending, fresh confirm token.
    const { data: updated } = await db()
      .from("subscribers")
      .update({ status: "pending", confirm_token: crypto.randomUUID() })
      .eq("id", subscriber.id)
      .select("id, status, confirm_token, unsubscribe_token")
      .single();
    if (updated) subscriber = updated;
  }

  try {
    await sendEmail({
      to: email,
      subject: "Confirm your subscription",
      html: renderConfirmEmail(subscriber.confirm_token, subscriber.unsubscribe_token),
      unsubscribeToken: subscriber.unsubscribe_token,
    });
    await logEvent("confirm_email_sent", { subscriberId: subscriber.id });
  } catch (e) {
    console.error("Confirm email failed:", e);
  }
  return OK;
}
