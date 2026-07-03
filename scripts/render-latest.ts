/**
 * Re-render the most recent memo's email HTML from stored extras — no LLM
 * calls, no send. For layout iteration.
 *
 *   OUT=/tmp/render.html npx tsx scripts/render-latest.ts
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { writeFileSync } from "fs";
import { db } from "../lib/db";
import { renderMemoEmail } from "../lib/emails/memo-email";

async function main() {
  const { data, error } = await db()
    .from("memos")
    .select("id, ticker, content_md, extras, subscribers!inner(email, unsubscribe_token)")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (error) throw error;
  const ex = (data.extras ?? {}) as Record<string, unknown>;
  const sub = (Array.isArray(data.subscribers) ? data.subscribers[0] : data.subscribers) as {
    email: string;
    unsubscribe_token: string;
  };
  const html = renderMemoEmail({
    markdown: data.content_md as string,
    unsubscribeToken: sub.unsubscribe_token,
    preparedFor: sub.email,
    dateLine: ex.dateLine as string | undefined,
    stats: ex.stats as never,
    street: ex.street as never,
    meta: ex.meta as never,
    primarySources: ex.primarySources as never,
    chartUrl: (process.env.CHART_URL ?? ex.chartUrl) as string | undefined,
    sources: ex.sources as never,
    pdfUrl: `https://morningpick.ai/api/memo/${data.id}/pdf`,
  });
  writeFileSync(process.env.OUT ?? "render.html", html);
  console.log(`rendered ${data.ticker} → ${process.env.OUT ?? "render.html"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
