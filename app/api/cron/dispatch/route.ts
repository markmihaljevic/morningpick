import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { config } from "@/lib/config";
import { db, logEvent } from "@/lib/db";
import { ensureDailyUniverse } from "@/lib/candidates";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Vercel Cron target. Builds today's candidate universe, enqueues one
 * delivery per active subscriber, and kicks the batch worker.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const cfg = config();
  if (req.headers.get("authorization") !== `Bearer ${cfg.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const today = new Date().toISOString().slice(0, 10);

  const universe = await ensureDailyUniverse(today);

  const { data: allActive, error } = await db()
    .from("subscribers")
    .select("id, timezone, send_hour_local")
    .eq("status", "active");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // daily mode: everyone, at the cron's fixed time (Vercel Hobby compatible).
  // hourly mode: only subscribers whose local clock matches their send hour
  // (run the cron every hour on Vercel Pro).
  const subscribers =
    cfg.DELIVERY_MODE === "daily"
      ? allActive
      : allActive.filter((s) => {
          try {
            const localHour = Number(
              new Intl.DateTimeFormat("en-US", {
                timeZone: s.timezone,
                hour: "numeric",
                hour12: false,
              }).format(new Date()),
            );
            return localHour === s.send_hour_local;
          } catch {
            return false; // invalid timezone string — skip rather than crash
          }
        });

  if (subscribers.length > 0) {
    const rows = subscribers.map((s) => ({ subscriber_id: s.id, delivery_date: today }));
    const { error: enqueueError } = await db()
      .from("deliveries")
      .upsert(rows, { onConflict: "subscriber_id,delivery_date", ignoreDuplicates: true });
    if (enqueueError) {
      return NextResponse.json({ error: enqueueError.message }, { status: 500 });
    }
  }

  await logEvent("cron_dispatch", {
    payload: { date: today, subscribers: subscribers.length, universe: universe.length },
  });

  // Fire-and-forget: kick the worker after this response is sent.
  after(async () => {
    try {
      await fetch(`${cfg.APP_URL}/api/internal/process`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.CRON_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hop: 0 }),
      });
    } catch (e) {
      console.error("Failed to kick worker:", e);
    }
  });

  return NextResponse.json({ ok: true, enqueued: subscribers.length, universe: universe.length });
}
