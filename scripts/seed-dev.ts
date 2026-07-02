/**
 * Seed a confirmed test subscriber so a local cron run delivers to you.
 *
 *   npx tsx scripts/seed-dev.ts you@example.com
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { db } from "../lib/db";

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npx tsx scripts/seed-dev.ts you@example.com");
    process.exit(1);
  }

  const { data: subscriber, error } = await db()
    .from("subscribers")
    .upsert(
      { email, status: "active", confirmed_at: new Date().toISOString() },
      { onConflict: "email" },
    )
    .select("id, email, status, unsubscribe_token")
    .single();
  if (error) throw new Error(error.message);

  await db()
    .from("preference_profiles")
    .upsert({ subscriber_id: subscriber.id }, { onConflict: "subscriber_id", ignoreDuplicates: true });

  console.log("Seeded active subscriber:", subscriber);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
