import { NextRequest, NextResponse } from "next/server";
import { db, logEvent } from "@/lib/db";
import { sendEmail } from "@/lib/resend";
import { renderSigninEmail } from "@/lib/emails/signin-email";

export const runtime = "nodejs";

/**
 * Passwordless sign-in: email us your address, we email you your desk link.
 * The click IS the authentication (inbox possession), and the desk page then
 * persists the session cookie.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const { email } = (await req.json().catch(() => ({}))) as { email?: string };
  const cleaned = (email ?? "").trim().toLowerCase();
  if (!cleaned || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleaned)) {
    return NextResponse.json({ ok: false, error: "invalid email" }, { status: 400 });
  }

  const { data: subscriber } = await db()
    .from("subscribers")
    .select("id, email, status, unsubscribe_token, portal_token")
    .eq("email", cleaned)
    .maybeSingle();

  if (!subscriber || subscriber.status !== "active") {
    // Friendly, not paranoid: a newsletter address isn't a secret worth an
    // enumeration defense that strands real users.
    return NextResponse.json({ ok: false, error: "no subscription" }, { status: 404 });
  }

  // Throttle: at most 3 sign-in links per hour per subscriber.
  const { count } = await db()
    .from("events")
    .select("id", { count: "exact", head: true })
    .eq("type", "signin_link_sent")
    .eq("subscriber_id", subscriber.id)
    .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
  if ((count ?? 0) >= 3) {
    return NextResponse.json({ ok: true, throttled: true });
  }

  await sendEmail({
    to: subscriber.email,
    subject: "Your research desk — sign-in link",
    html: renderSigninEmail({
      unsubscribeToken: subscriber.unsubscribe_token,
      portalToken: subscriber.portal_token,
    }),
    unsubscribeToken: subscriber.unsubscribe_token,
  });
  await logEvent("signin_link_sent", { subscriberId: subscriber.id });

  return NextResponse.json({ ok: true });
}
