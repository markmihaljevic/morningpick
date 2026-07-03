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
  const [
    { data: deliveries },
    { data: memos },
    { data: budget },
    { count: failopens },
    { data: qualityEvents },
    { count: preflightFallbacks },
  ] = await Promise.all([
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
    db().from("events").select("payload").eq("type", "memo_quality").gte("created_at", dayStart),
    db()
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("type", "preflight_fallback")
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
    ...qualityLines(qualityEvents ?? [], preflightFallbacks ?? 0),
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

interface QualityPayload {
  kind?: string;
  conviction?: number | null;
  catalystStrength?: number | null;
  editorialRevised?: boolean;
  verifyCritical?: number;
  genMs?: number;
}

/** Quality pulse: drift shows up here before subscribers feel it. */
function qualityLines(events: { payload: unknown }[], preflightFallbacks: number): string[] {
  if (events.length === 0) return [];
  const q = events.map((e) => (e.payload ?? {}) as QualityPayload);
  const kinds: Record<string, number> = {};
  for (const p of q) kinds[p.kind ?? "?"] = (kinds[p.kind ?? "?"] ?? 0) + 1;
  const nums = (vals: (number | null | undefined)[]) =>
    vals.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const avg = (vals: number[]) =>
    vals.length === 0 ? "—" : (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
  const convictions = nums(q.map((p) => p.conviction));
  const catalysts = nums(q.map((p) => p.catalystStrength));
  const genMinutes = nums(q.map((p) => p.genMs)).map((ms) => ms / 60000);
  const revised = q.filter((p) => p.editorialRevised).length;
  return [
    `Quality pulse:`,
    `  note mix: ${Object.entries(kinds)
      .map(([k, n]) => `${k}×${n}`)
      .join(", ")}${preflightFallbacks > 0 ? ` (${preflightFallbacks} pre-flight fallback${preflightFallbacks > 1 ? "s" : ""})` : ""}`,
    `  avg conviction ${avg(convictions)} · avg catalyst ${avg(catalysts)} · editorial revised ${revised}/${q.length} · avg gen ${avg(genMinutes)} min`,
    ``,
  ];
}
