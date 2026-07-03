import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { billingEnabled, stripe } from "@/lib/billing";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Tokenized billing management (no login): Stripe's hosted customer portal
 * for invoices, payment method, and cancellation.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const cfg = config();
  const { token } = await params;

  const { data: subscriber } = await db()
    .from("subscribers")
    .select("id, stripe_customer_id")
    .eq("portal_token", token)
    .single();
  if (!subscriber || !billingEnabled() || !subscriber.stripe_customer_id) {
    return NextResponse.redirect(`${cfg.APP_URL}/me/${token}`, 303);
  }

  const session = await stripe().billingPortal.sessions.create({
    customer: subscriber.stripe_customer_id,
    return_url: `${cfg.APP_URL}/me/${token}`,
  });
  return NextResponse.redirect(session.url, 303);
}
