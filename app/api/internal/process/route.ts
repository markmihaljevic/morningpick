import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { config } from "@/lib/config";
import { db, logEvent } from "@/lib/db";
import type { Profile } from "@/lib/profile";
import { getSubscriberScreens, buildCandidatePool, type ScreenParams } from "@/lib/screens";
import { shortlistCandidates, enrichShortlist, finalSelect } from "@/lib/selection";
import { sendAdminAlert } from "@/lib/alerts";
import { fetchTickerData } from "@/lib/fmp";
import { generateVerifiedMemo } from "@/lib/memo";
import { renderMemoEmail } from "@/lib/emails/memo-email";
import { buildFiveYearChartUrl } from "@/lib/chart";
import { buildResearchLinks } from "@/lib/research-links";
import { sendEmail, replyAddress } from "@/lib/resend";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_HOPS = 50;
// Don't start a new memo unless at least this much runtime remains.
const PER_MEMO_RESERVE_MS = 200_000;
const REPEAT_EXCLUSION_DAYS = 90;

interface DeliveryRow {
  id: string;
  subscriber_id: string;
  delivery_date: string;
  attempts: number;
}

/**
 * Self-reinvoking batch worker. Claims deliveries atomically, generates and
 * sends memos, and chains a fresh invocation when time runs short.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const cfg = config();
  if (req.headers.get("authorization") !== `Bearer ${cfg.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { hop = 0 } = (await req.json().catch(() => ({}))) as { hop?: number };
  if (hop >= MAX_HOPS) {
    await logEvent("worker_hop_cap", { payload: { hop } });
    return NextResponse.json({ ok: false, error: "hop cap reached" });
  }

  const startedAt = Date.now();
  let processed = 0;

  // Claim ONE delivery at a time, and only while enough runtime remains to
  // finish a full memo before the platform kills the function. Anything left
  // is picked up by the chained invocation below — nothing is ever claimed
  // and then abandoned mid-generation.
  while (Date.now() < startedAt + maxDuration * 1000 - PER_MEMO_RESERVE_MS) {
    const { data: batch, error } = await db().rpc("claim_deliveries", { batch: 1 });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const delivery = ((batch ?? []) as DeliveryRow[])[0];
    if (!delivery) {
      return NextResponse.json({ ok: true, processed, done: true });
    }

    try {
      await processDelivery(delivery);
      await db().from("deliveries").update({ status: "sent" }).eq("id", delivery.id);
      processed++;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Delivery ${delivery.id} failed:`, message);
      // claim_deliveries already incremented attempts and excludes attempts >= 3.
      const exhausted = delivery.attempts >= 3;
      await db()
        .from("deliveries")
        .update({
          status: exhausted ? "failed" : "pending",
          last_error: message.slice(0, 1000),
        })
        .eq("id", delivery.id);
      await logEvent("delivery_failed", {
        subscriberId: delivery.subscriber_id,
        payload: { deliveryId: delivery.id, error: message.slice(0, 500) },
      });
      if (exhausted) {
        await sendAdminAlert("Delivery permanently FAILED", [
          `Subscriber ${delivery.subscriber_id} will get NO memo today (${delivery.delivery_date}).`,
          `All ${delivery.attempts} attempts exhausted. Last error:`,
          message.slice(0, 1000),
          ``,
          `To retry: reset the delivery to pending with attempts=0 and re-kick the worker.`,
        ]);
      }
    }
  }

  // Time ran short with work possibly remaining — chain a fresh invocation.
  after(async () => {
    try {
      await fetch(`${cfg.APP_URL}/api/internal/process`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.CRON_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hop: hop + 1 }),
      });
    } catch (e) {
      console.error("Failed to chain worker:", e);
    }
  });

  return NextResponse.json({ ok: true, processed, chained: true, hop });
}

async function processDelivery(delivery: DeliveryRow): Promise<void> {
  const { data: subscriber, error: subError } = await db()
    .from("subscribers")
    .select(
      "id, email, status, unsubscribe_token, preference_profiles(structured, philosophy, version, screens, screens_version)",
    )
    .eq("id", delivery.subscriber_id)
    .single();
  if (subError) throw new Error(`Subscriber load failed: ${subError.message}`);
  if (subscriber.status !== "active") {
    await db().from("deliveries").update({ status: "skipped" }).eq("id", delivery.id);
    return;
  }

  // Idempotency: a memo row may exist from a previous crashed attempt.
  const { data: existingMemo } = await db()
    .from("memos")
    .select("id, content_html, ticker, title, sent_at, reply_address")
    .eq("subscriber_id", subscriber.id)
    .eq("delivery_date", delivery.delivery_date)
    .maybeSingle();
  if (existingMemo?.sent_at) return; // already sent — just mark delivery done

  const profileRow = Array.isArray(subscriber.preference_profiles)
    ? subscriber.preference_profiles[0]
    : subscriber.preference_profiles;
  const profile: Profile = {
    structured: (profileRow?.structured as Record<string, unknown>) ?? {},
    philosophy: (profileRow?.philosophy as string) ?? "",
  };

  let memoId: string;
  let html: string;
  let ticker: string;
  let title: string;

  if (existingMemo) {
    // Generated but not sent — reuse it instead of paying for regeneration.
    memoId = existingMemo.id;
    html = existingMemo.content_html;
    ticker = existingMemo.ticker;
    title = existingMemo.title ?? `${ticker} — today's idea`;
  } else {
    const since = new Date(Date.now() - REPEAT_EXCLUSION_DAYS * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const { data: recentMemos } = await db()
      .from("memos")
      .select("ticker, delivery_date")
      .eq("subscriber_id", subscriber.id)
      .gte("delivery_date", since)
      .order("delivery_date", { ascending: false });
    const excluded = (recentMemos ?? []).map((m) => m.ticker);
    const recent = (recentMemos ?? []).slice(0, 10).map((m) => ({ ticker: m.ticker }));

    // Profile-aware funnel: derived screens → broad pool → shortlist →
    // valuation enrichment → final pick.
    const screens = await getSubscriberScreens(
      subscriber.id,
      profile,
      (profileRow?.version as number) ?? 0,
      (profileRow?.screens as ScreenParams[]) ?? [],
      (profileRow?.screens_version as number) ?? -1,
    );
    const pool = await buildCandidatePool(screens);
    const shortlist = await shortlistCandidates(profile, pool, excluded, recent);
    const enriched = await enrichShortlist(shortlist);
    const selection = await finalSelect(profile, enriched, recent);
    ticker = selection.ticker;

    const companyName = pool.find(
      (c) => c.ticker.toUpperCase() === ticker.toUpperCase(),
    )?.name;

    const data = await fetchTickerData(ticker);
    const memo = await generateVerifiedMemo({
      profile,
      ticker,
      companyName,
      data,
      selectionRationale: selection.rationale,
    });
    title = memo.title;

    const companyProfile = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as
      | { website?: string; cik?: string; currency?: string; exchangeShortName?: string }
      | undefined;
    const chartUrl = await buildFiveYearChartUrl(ticker, companyProfile?.currency);
    const researchLinks = buildResearchLinks(ticker, companyName ?? ticker, companyProfile);

    memoId = crypto.randomUUID();
    html = renderMemoEmail({
      markdown: memo.markdown,
      unsubscribeToken: subscriber.unsubscribe_token,
      chartUrl,
      researchLinks,
      sources: memo.sources,
    });
    const { error: memoError } = await db().from("memos").insert({
      id: memoId,
      subscriber_id: subscriber.id,
      delivery_date: delivery.delivery_date,
      ticker,
      company_name: companyName ?? null,
      title,
      content_md: memo.markdown,
      content_html: html,
      model: memo.model,
      reply_address: replyAddress(memoId),
    });
    if (memoError) throw new Error(`Memo insert failed: ${memoError.message}`);
  }

  const resendId = await sendEmail({
    to: subscriber.email,
    subject: title,
    html,
    replyTo: replyAddress(memoId),
    unsubscribeToken: subscriber.unsubscribe_token,
  });

  await db()
    .from("memos")
    .update({ resend_message_id: resendId, sent_at: new Date().toISOString() })
    .eq("id", memoId);
  await logEvent("memo_sent", {
    subscriberId: subscriber.id,
    payload: { memoId, ticker, resendId },
  });
}
