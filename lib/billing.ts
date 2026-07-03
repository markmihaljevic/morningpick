import Stripe from "stripe";
import { config } from "./config";

let client: Stripe | null = null;

/** True once Stripe env vars are set — all billing routes no-op gracefully until then. */
export function billingEnabled(): boolean {
  const cfg = config();
  return Boolean(cfg.STRIPE_SECRET_KEY && cfg.STRIPE_PRICE_ID);
}

export function stripe(): Stripe {
  if (!client) {
    client = new Stripe(config().STRIPE_SECRET_KEY);
  }
  return client;
}

/** Plans that receive the full daily product (memos every weekday, Q&A, follow-ups). */
export function isDailyPlan(plan: string | null | undefined): boolean {
  return plan === "paid" || plan === "comp";
}

/** Free subscribers get their weekly note on this UTC weekday (1 = Monday). */
export const FREE_DELIVERY_UTC_WEEKDAY = 1;
