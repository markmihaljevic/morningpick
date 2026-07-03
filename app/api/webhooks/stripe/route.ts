import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { config } from "@/lib/config";
import { db, logEvent } from "@/lib/db";
import { billingEnabled, stripe } from "@/lib/billing";
import { sendAdminAlert } from "@/lib/alerts";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Subscription statuses that keep the daily product active. */
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const cfg = config();
  if (!billingEnabled() || !cfg.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "billing not configured" }, { status: 503 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "missing signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = await stripe().webhooks.constructEventAsync(
      await req.text(),
      signature,
      cfg.STRIPE_WEBHOOK_SECRET,
    );
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const subscriberId = session.client_reference_id;
      if (!subscriberId) break;
      const { data: updated } = await db()
        .from("subscribers")
        .update({
          plan: "paid",
          stripe_customer_id: typeof session.customer === "string" ? session.customer : null,
          stripe_subscription_id:
            typeof session.subscription === "string" ? session.subscription : null,
        })
        .eq("id", subscriberId)
        .select("email")
        .single();
      await logEvent("plan_upgraded", { subscriberId, payload: { via: "checkout" } });
      if (updated) {
        await sendAdminAlert("New Desk subscriber 🎉", [
          `${updated.email} just upgraded to The Desk.`,
        ]);
      }
      break;
    }

    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      const subscriberId = subscription.metadata?.subscriber_id;
      const active =
        event.type === "customer.subscription.updated" &&
        ACTIVE_STATUSES.has(subscription.status);
      const match = subscriberId
        ? { column: "id", value: subscriberId }
        : { column: "stripe_subscription_id", value: subscription.id };
      // Never touch comped subscribers from Stripe events.
      const { data: rows } = await db()
        .from("subscribers")
        .update({ plan: active ? "paid" : "free" })
        .eq(match.column, match.value)
        .neq("plan", "comp")
        .select("id, email");
      for (const row of rows ?? []) {
        await logEvent(active ? "plan_upgraded" : "plan_downgraded", {
          subscriberId: row.id,
          payload: { via: event.type, status: subscription.status },
        });
        if (!active) {
          await sendAdminAlert("Desk subscription ended", [
            `${row.email} is back on the free Monday note (${subscription.status}).`,
          ]);
        }
      }
      break;
    }

    default:
      break;
  }

  return NextResponse.json({ received: true });
}
