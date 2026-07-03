import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { config } from "@/lib/config";
import { db, logEvent } from "@/lib/db";
import type { Profile } from "@/lib/profile";
import { getSubscriberScreens, buildCandidatePool, type ScreenParams } from "@/lib/screens";
import { shortlistCandidates, enrichShortlist, finalSelect } from "@/lib/selection";
import { sendAdminAlert } from "@/lib/alerts";
import { fetchTickerData, fetchHeadlines, fetchUpcomingEarnings } from "@/lib/fmp";
import { generateVerifiedMemo } from "@/lib/memo";
import { renderMemoEmail } from "@/lib/emails/memo-email";
import { buildFiveYearChartUrl } from "@/lib/chart";
import { buildResearchLinks } from "@/lib/research-links";
import { extractPitchPrice } from "@/lib/performance";
import { buildKeyStats } from "@/lib/stats";
import { buildStreetItems } from "@/lib/street";
import { discoverPrimarySources } from "@/lib/enrich-sources";
import { isDailyPlan } from "@/lib/billing";
import { getCoverageContext, coverageForPrompt, checkFollowupTrigger } from "@/lib/coverage";
import { sendEmail, replyAddress } from "@/lib/resend";

export const runtime = "nodejs";
export const maxDuration = 800;

const MAX_HOPS = 300;
// Don't start a new memo unless at least this much runtime remains.
const PER_MEMO_RESERVE_MS = 420_000; // fetch-heavy memos run 4-7 min end to end
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
  const { hop = 0, chain = 0 } = (await req.json().catch(() => ({}))) as {
    hop?: number;
    chain?: number;
  };
  if (hop >= MAX_HOPS) {
    await logEvent("worker_hop_cap", { payload: { hop, chain } });
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
        body: JSON.stringify({ hop: hop + 1, chain }),
      });
    } catch (e) {
      console.error("Failed to chain worker:", e);
    }
  });

  return NextResponse.json({ ok: true, processed, chained: true, hop, chain });
}

async function processDelivery(delivery: DeliveryRow): Promise<void> {
  const { data: subscriber, error: subError } = await db()
    .from("subscribers")
    .select(
      "id, email, status, unsubscribe_token, portal_token, plan, preference_profiles(structured, philosophy, version, screens, screens_version)",
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
    // The analyst's memory: recent notes with live returns + subscriber reactions.
    const { items: coverageItems, taste } = await getCoverageContext(subscriber.id);
    const coverage = coverageForPrompt(coverageItems);
    const firstNote = coverageItems.length === 0;

    // A covered name reporting earnings or moving sharply takes priority over
    // a new idea — analysts follow up on their own calls.
    const trigger = isDailyPlan(subscriber.plan) ? await checkFollowupTrigger(coverageItems) : null;

    let memoKind: "idea" | "followup" = "idea";
    let companyName: string | undefined;
    let selectionRationale = "";
    let followupContext:
      | { originalMarkdown: string; originalDate: string; priceThen: number | null; priceNow: number | null; triggerDetail: string }
      | undefined;

    if (trigger) {
      memoKind = "followup";
      ticker = trigger.ticker;
      const { data: original } = await db()
        .from("memos")
        .select("content_md, company_name")
        .eq("id", trigger.lastNote.memoId)
        .single();
      companyName = original?.company_name ?? undefined;
      selectionRationale = trigger.detail;
      followupContext = {
        originalMarkdown: original?.content_md ?? "(original note unavailable)",
        originalDate: trigger.lastNote.date,
        priceThen: trigger.lastNote.pitchPrice,
        priceNow: trigger.lastNote.priceNow,
        triggerDetail: trigger.detail,
      };
    } else {
      const since = new Date(Date.now() - REPEAT_EXCLUSION_DAYS * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      const excluded = coverageItems.filter((c) => c.date >= since).map((c) => c.ticker);
      const recent = coverageItems.slice(0, 10).map((c) => ({ ticker: c.ticker }));

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
      const shortlist = await shortlistCandidates(profile, pool, excluded, recent, taste);
      const [enriched, headlines, upcomingEarnings] = await Promise.all([
        enrichShortlist(shortlist),
        fetchHeadlines(shortlist.map((c) => c.ticker)),
        fetchUpcomingEarnings(shortlist.map((c) => c.ticker)),
      ]);
      // Sector variety: resolve recent tickers' sectors from today's pool.
      const sectorByTicker = new Map(pool.map((c) => [c.ticker.toUpperCase(), c.sector]));
      const recentWithSectors = recent.map((r) => ({
        ...r,
        sector: sectorByTicker.get(r.ticker.toUpperCase()) ?? undefined,
      }));
      const selection = await finalSelect(
        profile,
        enriched,
        recentWithSectors,
        taste,
        headlines,
        upcomingEarnings,
      );
      ticker = selection.ticker;
      selectionRationale = selection.rationale;
      companyName = pool.find((c) => c.ticker.toUpperCase() === ticker.toUpperCase())?.name;
    }

    const [data, primarySources] = await Promise.all([
      fetchTickerData(ticker),
      discoverPrimarySources(ticker, companyName ?? ticker),
    ]);
    const companyProfile = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as
      | { website?: string; cik?: string; currency?: string; exchangeShortName?: string }
      | undefined;
    const researchLinks = buildResearchLinks(ticker, companyName ?? ticker, companyProfile);
    const referenceLinks = [
      ...researchLinks,
      ...primarySources.map((s) => ({ label: s.title, url: s.url })),
    ];

    const [memo, chartUrl] = await Promise.all([
      generateVerifiedMemo({
        profile,
        ticker,
        companyName,
        data,
        selectionRationale,
        coverage,
        followup: followupContext,
        referenceLinks,
      }),
      buildFiveYearChartUrl(ticker, companyProfile?.currency),
    ]);
    title = memo.title;
    const stats = buildKeyStats(data);
    const street = buildStreetItems(data);
    const pitch = extractPitchPrice(data);
    const dateLine = new Date(delivery.delivery_date + "T00:00:00Z").toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

    memoId = crypto.randomUUID();
    html = renderMemoEmail({
      markdown: memo.markdown,
      firstNote,
      unsubscribeToken: subscriber.unsubscribe_token,
      billingUrl:
        subscriber.plan === "paid"
          ? `${config().APP_URL}/api/billing/${subscriber.portal_token}`
          : undefined,
      upgradeUrl: isDailyPlan(subscriber.plan)
        ? undefined
        : `${config().APP_URL}/api/upgrade/${subscriber.portal_token}`,
      preparedFor: subscriber.email,
      dateLine,
      stats,
      street,
      meta: memo.meta,
      primarySources,
      chartUrl,
      sources: memo.sources,
      pdfUrl: `${config().APP_URL}/api/memo/${memoId}/pdf`,
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
      kind: memoKind,
      pitch_price: pitch.price,
      pitch_currency: pitch.currency,
      extras: { chartUrl, researchLinks, sources: memo.sources, stats, street, meta: memo.meta, primarySources, dateLine },
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
