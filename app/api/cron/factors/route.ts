import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { config } from "@/lib/config";
import { ensureFactorTable } from "@/lib/factor-table";

export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * Nightly factor-table pre-warm: rebuild the shared TTM factor inputs before
 * the morning dispatch so the first delivery never pays the ~60s bulk build.
 * Idempotent — ensureFactorTable's build lock makes double-runs harmless, and
 * the morning workers self-heal if this cron ever misses.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const cfg = config();
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${cfg.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  after(async () => {
    try {
      await ensureFactorTable();
    } catch (e) {
      console.error("Factor pre-warm failed (workers will self-heal):", e);
    }
  });
  return NextResponse.json({ ok: true });
}
