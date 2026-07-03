import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { config } from "@/lib/config";
import { db, logEvent } from "@/lib/db";
import { sendAdminAlert } from "@/lib/alerts";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Vercel Cron target. Enqueues one delivery per due subscriber and kicks the
 * batch worker. Candidate screening is profile-aware and happens in the
 * worker per subscriber (cached across subscribers with similar screens).
 * A second daily cron run acts as a sweeper: enqueueing is idempotent and
 * the worker reclaims stalled deliveries.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const cfg = config();
  if (req.headers.get("authorization") !== `Bearer ${cfg.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const today = new Date().toISOString().slice(0, 10);

    const { data: allActive, error } = await db()
      .from("subscribers")
      .select("id, timezone, send_hour_local")
      .eq("status", "active");
    if (error) throw new Error(`Subscriber query failed: ${error.message}`);

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
      if (enqueueError) throw new Error(`Enqueue failed: ${enqueueError.message}`);
    }

    await logEvent("cron_dispatch", {
      payload: { date: today, subscribers: subscribers.length },
    });

    // Fire-and-forget: kick N parallel worker chains after this response is
    // sent. Chains never collide (claim_deliveries uses SKIP LOCKED) and each
    // exits as soon as the queue is empty, so over-provisioning is harmless.
    const chains = Math.min(cfg.WORKER_CONCURRENCY, Math.max(subscribers.length, 1));
    after(async () => {
      await Promise.allSettled(
        Array.from({ length: chains }, (_, chain) =>
          fetch(`${cfg.APP_URL}/api/internal/process`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cfg.CRON_SECRET}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ hop: 0, chain }),
          }).catch((e) => console.error(`Failed to kick worker chain ${chain}:`, e)),
        ),
      );
    });

    return NextResponse.json({ ok: true, enqueued: subscribers.length, chains });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sendAdminAlert("Morning dispatch FAILED", [
      `The cron dispatch threw before enqueueing deliveries:`,
      message,
      ``,
      `No memos will go out until this is fixed and the sweeper (or a manual trigger) reruns.`,
    ]);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
