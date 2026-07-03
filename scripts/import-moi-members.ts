/**
 * Import the MOI Global member email list. Accepts a plain text file (one
 * email per line) or a CSV (emails taken from the first column). Upserts
 * into moi_members and flags any existing subscribers.
 *
 *   npx tsx scripts/import-moi-members.ts members.csv
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { readFileSync } from "fs";
import { db } from "../lib/db";

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: npx tsx scripts/import-moi-members.ts <members.csv|members.txt>");
    process.exit(1);
  }

  const emails = [
    ...new Set(
      readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map((line) => line.split(/[,;\t]/)[0].trim().toLowerCase().replace(/^"|"$/g, ""))
        .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)),
    ),
  ];
  if (emails.length === 0) {
    console.error("No valid email addresses found in the file.");
    process.exit(1);
  }

  for (let i = 0; i < emails.length; i += 500) {
    const batch = emails.slice(i, i + 500).map((email) => ({ email }));
    const { error } = await db().from("moi_members").upsert(batch, { onConflict: "email" });
    if (error) throw new Error(`Upsert failed at batch ${i}: ${error.message}`);
  }
  console.error(`Imported ${emails.length} member emails.`);

  // Flag subscribers who are already on the list.
  const { data: flagged, error } = await db()
    .from("subscribers")
    .update({ moi_member: true })
    .in("email", emails)
    .eq("moi_member", false)
    .select("email");
  if (error) throw new Error(`Subscriber flag failed: ${error.message}`);
  for (const s of flagged ?? []) console.error(`  flagged existing subscriber: ${s.email}`);
  console.error(`Done — ${(flagged ?? []).length} existing subscribers flagged as members.`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
