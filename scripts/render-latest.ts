/**
 * Dump the most recent memo's rendered cover email (stored content_html) —
 * no LLM calls, no send. For eyeballing the last note that actually went out.
 *
 *   OUT=/tmp/render.html npx tsx scripts/render-latest.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { writeFileSync } from "fs";
import { db } from "../lib/db";

async function main() {
  const { data, error } = await db()
    .from("memos")
    .select("id, ticker, content_html")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (error) throw error;
  writeFileSync(process.env.OUT ?? "render.html", (data.content_html as string) ?? "");
  console.log(`rendered ${data.ticker} → ${process.env.OUT ?? "render.html"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
