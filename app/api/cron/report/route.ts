import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { db } from "@/lib/db";
import { sendAdminAlert } from "@/lib/alerts";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Daily admin digest, cron'd after the morning run + sweeper. Summarizes
 * what went out, what failed, and what it consumed — so a broken morning is
 * never silent.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const cfg = config();
  if (req.headers.get("authorization") !== `Bearer ${cfg.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);

  const dayStart = `${today}T00:00:00Z`;
  const [{ data: deliveries }, { data: memos }, { data: budget }, { count: failopens }] =
    await Promise.all([
      db()
        .from("deliveries")
        .select("status, last_error, subscriber_id")
        .eq("delivery_date", today),
      db()
        .from("memos")
        .select("ticker, title, kind, sent_at, subscribers(email)")
        .eq("delivery_date", today),
      db().from("fmp_budget").select("used").eq("budget_date", today).maybeSingle(),
      db()
        .from("events")
        .select("id", { count: "exact", head: true })
        .eq("type", "verify_failopen")
        .gte("created_at", dayStart),
    ]);

  const counts: Record<string, number> = {};
  for (const d of deliveries ?? []) counts[d.status] = (counts[d.status] ?? 0) + 1;
  const failed = (deliveries ?? []).filter((d) => d.status === "failed");
  const stuck = (deliveries ?? []).filter(
    (d) => d.status === "pending" || d.status === "processing",
  );

  const lines = [
    `Morning run for ${today}:`,
    ``,
    `Deliveries: ${JSON.stringify(counts)}`,
    ``,
    `Memos sent:`,
    ...(memos ?? []).map((m) => {
      const sub = Array.isArray(m.subscribers) ? m.subscribers[0] : m.subscribers;
      return `  • ${m.kind === "followup" ? "[follow-up] " : ""}${m.ticker} → ${(sub as { email?: string })?.email ?? "?"} ${m.sent_at ? "✓" : "(NOT SENT)"}`;
    }),
    ``,
    ...((failopens ?? 0) > 0
      ? [`⚠️ ${failopens} memo(s) shipped WITHOUT fact-verification (verifier errored, fail-open).`, ``]
      : []),
    ...(failed.length > 0
      ? [`⚠️ FAILED (${failed.length}):`, ...failed.map((d) => `  • ${d.subscriber_id}: ${d.last_error}`), ``]
      : []),
    ...(stuck.length > 0
      ? [`⚠️ Still pending/processing (${stuck.length}) — check the worker.`, ``]
      : []),
    `FMP requests used today: ${budget?.used ?? 0} / ${cfg.FMP_DAILY_BUDGET}`,
  ];

  const problems =
    failed.length > 0 || stuck.length > 0 || (memos ?? []).length === 0 || (failopens ?? 0) > 0;
  await sendAdminAlert(
    problems ? `Run digest ${today} — ⚠️ NEEDS ATTENTION` : `Run digest ${today} — all good`,
    lines,
  );

  return NextResponse.json({ ok: true, counts, failed: failed.length, stuck: stuck.length });
}
