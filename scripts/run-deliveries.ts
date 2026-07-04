/**
 * Run pending deliveries through the REAL production path (memos table,
 * delivery queue, live send) from a machine with no execution ceiling —
 * the escape hatch for mornings the platform budget can't fit.
 *
 *   npx tsx scripts/run-deliveries.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
process.env.APP_URL = "https://morningpick.ai"; // links in real emails must be prod

import { db } from "../lib/db";
import { processDelivery } from "../app/api/internal/process/route";

interface DeliveryRow {
  id: string;
  subscriber_id: string;
  delivery_date: string;
  attempts: number;
}

async function main() {
  for (let i = 0; i < 20; i++) {
    const { data: batch, error } = await db().rpc("claim_deliveries", { batch: 1 });
    if (error) throw new Error(error.message);
    const delivery = ((batch ?? []) as DeliveryRow[])[0];
    if (!delivery) {
      console.error("Queue empty — done.");
      return;
    }
    console.error(`Processing ${delivery.id} (attempt ${delivery.attempts})…`);
    try {
      await processDelivery(delivery);
      await db().from("deliveries").update({ status: "sent" }).eq("id", delivery.id);
      console.error(`  ✓ sent`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`  ✗ failed: ${message}`);
      await db()
        .from("deliveries")
        .update({
          status: delivery.attempts >= 3 ? "failed" : "pending",
          last_error: message.slice(0, 1000),
        })
        .eq("id", delivery.id);
    }
  }
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
