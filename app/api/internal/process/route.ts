import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { config } from "@/lib/config";
import { db, logEvent } from "@/lib/db";
import type { Profile } from "@/lib/profile";
import { type ScreenParams } from "@/lib/screens";
import { sendAdminAlert } from "@/lib/alerts";
import { fetchTickerData, fetchHeadlines, fetchUpcomingEarnings, type TickerData } from "@/lib/fmp";
import { generateVerifiedMemo } from "@/lib/memo";
import { renderMemoEmail } from "@/lib/emails/memo-email";
import { buildFiveYearChartUrl } from "@/lib/chart";
import { buildResearchLinks } from "@/lib/research-links";
import { extractPitchPrice } from "@/lib/performance";
import { buildKeyStats } from "@/lib/stats";
import { buildCompsRows } from "@/lib/comps";
import { buildStreetItems } from "@/lib/street";
import { discoverPrimarySources } from "@/lib/enrich-sources";
import { isDailyPlan } from "@/lib/billing";
import { getCoverageContext, coverageForPrompt, buildBookRows } from "@/lib/coverage";
import { decideNote, fallbackNote, type NoteKind } from "@/lib/desk-editor";
import { selectIdeaWithPreflight } from "@/lib/select-idea";
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
  let ticker = "";
  let title: string;
  // Follow-up verdicts (stands/watching/closed) update the book after send.
  let metaForVerdict: { call_status?: string; close_reason?: string } | null = null;
  let quality: Record<string, unknown> | null = null;
  const genStartedAt = Date.now();

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

    // Visible learning: what they told the analyst in the last 48 hours.
    const { data: recentFeedback } = await db()
      .from("feedback")
      .select("interpretation, created_at")
      .eq("subscriber_id", subscriber.id)
      .gte("created_at", new Date(Date.now() - 48 * 3600 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(3);
    const recentProfileChange = (recentFeedback ?? [])
      .map((f) => f.interpretation as { is_investment_feedback?: boolean; ack_summary?: string } | null)
      .filter((i) => i?.is_investment_feedback && i?.ack_summary)
      .map((i) => i!.ack_summary!)
      .slice(0, 2)
      .join(" · ") || undefined;

    // The desk editor decides what kind of note this morning deserves.
    let decision = await decideNote({ coverageItems, dailyPlan: isDailyPlan(subscriber.plan) });

    let memoKind: NoteKind = decision.kind;
    let companyName: string | undefined;
    let selectionRationale = decision.reason;
    let followupContext:
      | { originalMarkdown: string; originalDate: string; priceThen: number | null; priceNow: number | null; triggerDetail: string }
      | undefined;
    let secondLookContext:
      | { originalMarkdown: string; originalDate: string; development: string }
      | undefined;
    let reviewContext:
      | { book: unknown[]; headlines: Record<string, { date: string; title: string; site: string }[]>; upcomingEarnings: Record<string, string> }
      | undefined;
    let data: TickerData | null = null;

    if (decision.kind === "idea") {
      const since = new Date(Date.now() - REPEAT_EXCLUSION_DAYS * 24 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      const excluded = coverageItems.filter((c) => c.date >= since).map((c) => c.ticker);
      const idea = await selectIdeaWithPreflight({
        subscriberId: subscriber.id,
        profile,
        profileVersion: (profileRow?.version as number) ?? 0,
        storedScreens: (profileRow?.screens as ScreenParams[]) ?? [],
        storedScreensVersion: (profileRow?.screens_version as number) ?? -1,
        excluded,
        recentTickers: coverageItems.slice(0, 10).map((c) => c.ticker),
        taste,
      });

      if (!idea.ok) {
        // Both candidates failed pre-flight — steward the book instead.
        const failSummary = idea.attempts
          .map((a) => `${a.ticker} (${a.expectedConviction}/10: ${a.reason})`)
          .join("; ");
        decision = await fallbackNote({
          coverageItems,
          reason: `today's candidates failed pre-flight: ${failSummary}`,
        });
        memoKind = decision.kind;
        await logEvent("preflight_fallback", {
          subscriberId: subscriber.id,
          payload: { attempts: idea.attempts, fellBackTo: decision.kind },
        });
      }

      if (decision.kind === "idea") {
        ticker = idea.ticker;
        companyName = idea.companyName;
        data = idea.data;
        selectionRationale = idea.ok
          ? idea.rationale
          : `${idea.rationale} — NOTE: pre-flight scored this ${idea.preflight.expectedConviction}/10 (${idea.preflight.reason}); write it with honest conviction, do not oversell.`;
      }
    }

    if (decision.kind === "followup" && decision.followup) {
      const trigger = decision.followup;
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
    } else if (decision.kind === "second_look" && decision.ticker && decision.revisit) {
      ticker = decision.ticker;
      const { data: original } = await db()
        .from("memos")
        .select("content_md, company_name")
        .eq("id", decision.revisit.memoId)
        .single();
      companyName = original?.company_name ?? undefined;
      selectionRationale = decision.reason;
      secondLookContext = {
        originalMarkdown: original?.content_md ?? "(original note unavailable)",
        originalDate: decision.revisit.date,
        development: decision.reason,
      };
    } else if (decision.kind === "review") {
      ticker = "REVIEW";
      selectionRationale = decision.reason;
      const bookTickers = [...new Set(coverageItems.map((c) => c.ticker))].filter(
        (t) => t !== "REVIEW",
      );
      const [bookHeadlines, bookEarnings] = await Promise.all([
        fetchHeadlines(bookTickers),
        fetchUpcomingEarnings(bookTickers, 30),
      ]);
      reviewContext = {
        book: coverage,
        headlines: bookHeadlines,
        upcomingEarnings: bookEarnings,
      };
      data = { book: coverage, headlines: bookHeadlines, upcomingEarnings: bookEarnings } as unknown as TickerData;
    }

    if (!ticker) {
      throw new Error(`Desk decision '${decision.kind}' resolved no ticker — aborting delivery.`);
    }
    if (!data) data = await fetchTickerData(ticker);
    const primarySources =
      memoKind === "review" ? [] : await discoverPrimarySources(ticker, companyName ?? ticker);
    const companyProfile = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as
      | { website?: string; cik?: string; currency?: string; exchangeShortName?: string }
      | undefined;
    const researchLinks =
      memoKind === "review" ? [] : buildResearchLinks(ticker, companyName ?? ticker, companyProfile);
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
        secondLook: secondLookContext,
        review: reviewContext,
        recentProfileChange,
        referenceLinks,
      }),
      memoKind === "review"
        ? Promise.resolve(null)
        : buildFiveYearChartUrl(ticker, companyProfile?.currency),
    ]);
    title = memo.title;
    if (memoKind === "followup") metaForVerdict = memo.meta;
    quality = {
      kind: memoKind,
      ticker,
      conviction: memo.meta?.conviction ?? null,
      catalystStrength: Number(selectionRationale.match(/catalyst strength (\d+)\/10/)?.[1] ?? NaN) || null,
      editorialRevised: memo.editorial.revised,
      editorialIssues: memo.editorial.issueCount,
      verifyCritical: memo.verification.critical_issues.length,
      verifyMinor: memo.verification.minor_issues.length,
      genMs: Date.now() - genStartedAt,
    };
    const stats = memoKind === "review" ? [] : buildKeyStats(data);
    const street = memoKind === "review" ? [] : buildStreetItems(data);
    const comps = memoKind === "review" ? [] : buildCompsRows(ticker, data);
    // The Monday ledger: open calls marked to market (also under review notes).
    const isMonday = new Date().getUTCDay() === 1;
    const book = isMonday || memoKind === "review" ? buildBookRows(coverageItems) : [];
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
      comps,
      book,
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
      extras: { chartUrl, researchLinks, sources: memo.sources, stats, street, comps, meta: memo.meta, primarySources, dateLine },
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
  if (quality) {
    await logEvent("memo_quality", { subscriberId: subscriber.id, payload: quality });
  }

  // A follow-up's verdict updates the book: the original call's status
  // changes across every note on that ticker for this subscriber.
  const verdict = existingMemo
    ? null
    : ((): { status: string; reason: string | null } | null => {
        const meta = metaForVerdict;
        if (!meta || !meta.call_status || meta.call_status === "n/a") return null;
        if (meta.call_status === "closed") return { status: "closed", reason: meta.close_reason ?? null };
        if (meta.call_status === "watching") return { status: "watching", reason: null };
        return { status: "active", reason: null };
      })();
  if (verdict) {
    await db()
      .from("memos")
      .update({
        call_status: verdict.status,
        call_close_reason: verdict.reason,
        call_closed_at: verdict.status === "closed" ? new Date().toISOString() : null,
      })
      .eq("subscriber_id", subscriber.id)
      .eq("ticker", ticker);
    await logEvent("call_status_changed", {
      subscriberId: subscriber.id,
      payload: { ticker, status: verdict.status, reason: verdict.reason },
    });
  }
}
