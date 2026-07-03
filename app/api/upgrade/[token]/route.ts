import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { billingEnabled, stripe, isDailyPlan } from "@/lib/billing";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Tokenized upgrade link (no login): sends the subscriber to Stripe Checkout
 * for The Desk. Promotion codes (e.g. the MOI Global member rate) are entered
 * on the Stripe-hosted page.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const cfg = config();
  const { token } = await params;

  const { data: subscriber } = await db()
    .from("subscribers")
    .select("id, email, plan, stripe_customer_id, moi_member")
    .eq("portal_token", token)
    .single();
  if (!subscriber) {
    return NextResponse.redirect(`${cfg.APP_URL}/`, 303);
  }
  if (!billingEnabled()) {
    return NextResponse.redirect(`${cfg.APP_URL}/me/${token}?billing=soon`, 303);
  }
  if (isDailyPlan(subscriber.plan)) {
    return NextResponse.redirect(`${cfg.APP_URL}/me/${token}`, 303);
  }

  // MOI Global members get the partner price automatically — detected by
  // their member email, nothing to type at checkout.
  const price =
    subscriber.moi_member && cfg.STRIPE_PRICE_ID_MOI ? cfg.STRIPE_PRICE_ID_MOI : cfg.STRIPE_PRICE_ID;
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: true,
    client_reference_id: subscriber.id,
    ...(subscriber.stripe_customer_id
      ? { customer: subscriber.stripe_customer_id }
      : { customer_email: subscriber.email }),
    subscription_data: { metadata: { subscriber_id: subscriber.id } },
    success_url: `${cfg.APP_URL}/me/${token}?upgraded=1`,
    cancel_url: `${cfg.APP_URL}/me/${token}`,
  });

  return NextResponse.redirect(session.url ?? `${cfg.APP_URL}/me/${token}`, 303);
}
