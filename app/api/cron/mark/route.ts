import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { logEvent } from "@/lib/db";
import { markAllMemos } from "@/lib/performance";
import { sendAdminAlert } from "@/lib/alerts";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Nightly (after US close): mark every sent pick against fresh quotes. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const cfg = config();
  if (req.headers.get("authorization") !== `Bearer ${cfg.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await markAllMemos();
    await logEvent("memos_marked", { payload: result });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sendAdminAlert("Nightly performance mark FAILED", [message]);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
