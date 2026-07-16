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
import { buildResearchLinks } from "@/lib/research-links";
import { extractPitchPrice } from "@/lib/performance";
import { isDailyPlan } from "@/lib/billing";
import { getOrBuildBrief } from "@/lib/research";
import { getPortfolio } from "@/lib/portfolio";
import { greetingName } from "@/lib/greeting";
import { buildTearSheet } from "@/lib/tear-sheet";
import { buildFullReport } from "@/lib/full-report";
import { buildCompTable } from "@/lib/comp-table";
import { identityFromProfile, normalizeCompanyName } from "@/lib/company-key";
import { writeCoverNote, fallbackCoverBody, writeNoIdeaNote, fallbackNoIdeaBody, bareTicker } from "@/lib/cover-note";
import {
  getCoverageContext,
  coverageForPrompt,
  extractReviewGist,
  type CoverageItem,
} from "@/lib/coverage";
import { decideNote, noIdeaNote, type NoteKind } from "@/lib/desk-editor";
import { selectIdeaWithPreflight, updateWatchlist, hasReportedSince } from "@/lib/select-idea";
import { sendEmail, replyAddress } from "@/lib/resend";

export const runtime = "nodejs";
export const maxDuration = 800;

const MAX_HOPS = 300;

/** The email's attachments: the one-page fact sheet, then the full report. */
function buildAttachments(
  ticker: string,
  tearSheet: Buffer | null,
  fullReport: Buffer | null,
): { filename: string; content: Buffer }[] | undefined {
  const bare = bareTicker(ticker);
  const out: { filename: string; content: Buffer }[] = [];
  if (tearSheet) out.push({ filename: `${bare}-one-pager.pdf`, content: tearSheet });
  if (fullReport) out.push({ filename: `${bare}-full-report.pdf`, content: fullReport });
  return out.length > 0 ? out : undefined;
}
// Don't start a new memo unless at least this much runtime remains.
const REPEAT_EXCLUSION_DAYS = 90;

interface DeliveryRow {
  id: string;
  subscriber_id: string;
  delivery_date: string;
  attempts: number;
  plan?: SavedPlan | null;
}

/** The desk's checkpointed plan — everything generation needs except the
 * (per-day-cached, cheap to refetch) ticker dataset. */
interface SavedPlan {
  kind: NoteKind;
  ticker: string;
  companyName?: string;
  selectionRationale: string;
  followupContext?: { originalMarkdown: string; originalDate: string; priceThen: number | null; priceNow: number | null; triggerDetail: string };
  secondLookContext?: { originalMarkdown: string; originalDate: string; development: string };
  reviewContext?: { book: unknown[]; headlines: Record<string, { date: string; title: string; site: string }[]>; upcomingEarnings: Record<string, string>; priorReviews?: { date: string; headline: string; action: string }[] };
  noIdeaContext?: {
    attempts: { ticker: string; expectedConviction: number; reason: string }[];
    funnel?: import("@/lib/select-idea").FunnelStats;
  };
  /** The placing line + honest-conviction signals for idea notes (July 16):
   * "first of the N names that cleared your filters this morning". */
  funnelContext?: {
    rank: number | null;
    cleared: number;
    blockedAhead: number;
    quietList: boolean;
    conviction: number;
    convictionReason: string;
    whatWouldChange: string;
  };
  referenceLinks: { label: string; url: string }[];
  researchLinks: { label: string; url: string }[];
  primarySources: { url: string; title: string; type: "interview" | "earnings_call" | "deep_dive" | "analysis"; note: string }[];
  coverage: unknown[];
  firstNote: boolean;
  recentProfileChange?: string;
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

  // Claim ONE delivery, respond IMMEDIATELY, then do the work in after().
  // Vercel cancels an invocation when its caller disconnects — and every
  // kick here is fire-and-forget (dispatch after(), chain hops, manual
  // curls). Decoupling the response from the work means caller lifetime
  // can never kill a memo mid-generation again. One delivery per hop; the
  // chain continues until the queue is empty.
  const { data: batch, error } = await db().rpc("claim_deliveries", { batch: 1 });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const delivery = ((batch ?? []) as DeliveryRow[])[0];
  if (!delivery) {
    return NextResponse.json({ ok: true, processed: 0, done: true });
  }

  after(async () => {
    try {
      await processDelivery(delivery);
      await db().from("deliveries").update({ status: "sent" }).eq("id", delivery.id);
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
    // Chain the next hop — its handler responds instantly, so this short
    // fire-and-forget fetch is safe.
    try {
      await fetch(`${cfg.APP_URL}/api/internal/process`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.CRON_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ hop: hop + 1, chain }),
        signal: AbortSignal.timeout(15_000),
      }).catch((e) => console.error("Failed to chain worker:", e));
    } catch (e) {
      console.error("Failed to chain worker:", e);
    }
  });

  return NextResponse.json({ ok: true, claimed: delivery.id, hop, chain });
}

/**
 * The desk's morning decision for one delivery: note kind, ticker, contexts,
 * curated links. Runs ONCE per delivery — checkpointed on the row so retries
 * resume at generation with a full function budget.
 */
async function buildPlan(
  delivery: DeliveryRow,
  subscriberId: string,
  subscriberPlanTier: string,
  profile: Profile,
  profileRow: { version?: unknown; screens?: unknown; screens_version?: unknown } | null,
  coverageItems: CoverageItem[],
): Promise<SavedPlan> {
  const coverage = coverageForPrompt(coverageItems);
  const firstNote = coverageItems.length === 0;

  // Visible learning: what they told the analyst in the last 48 hours.
  const { data: recentFeedback } = await db()
    .from("feedback")
    .select("interpretation, created_at")
    .eq("subscriber_id", subscriberId)
    .gte("created_at", new Date(Date.now() - 48 * 3600 * 1000).toISOString())
    .order("created_at", { ascending: false })
    .limit(3);
  const recentProfileChange =
    (recentFeedback ?? [])
      .map((f) => f.interpretation as { is_investment_feedback?: boolean; ack_summary?: string } | null)
      .filter((i) => i?.is_investment_feedback && i?.ack_summary)
      .map((i) => i!.ack_summary!)
      .slice(0, 2)
      .join(" · ") || undefined;

  // The desk editor decides what kind of note this morning deserves —
  // calendar-first (John's rule 1), dated by the DELIVERY date so a retried
  // morning keeps its kind across midnight.
  let decision = await decideNote({
    coverageItems,
    dailyPlan: isDailyPlan(subscriberPlanTier),
    date: new Date(`${delivery.delivery_date}T04:30:00Z`),
  });

  let ticker = "";
  let companyName: string | undefined;
  let selectionRationale = decision.reason;
  let followupContext: SavedPlan["followupContext"];
  let secondLookContext: SavedPlan["secondLookContext"];
  let reviewContext: SavedPlan["reviewContext"];
  let noIdeaContext: SavedPlan["noIdeaContext"];
  let funnelContext: SavedPlan["funnelContext"];
  let data: TickerData | null = null;
  let kindOverride: NoteKind | null = null;

  if (decision.kind === "idea") {
    const since = new Date(Date.now() - REPEAT_EXCLUSION_DAYS * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    // Pool-level exclusion, RELEASE-AWARE (rule 2): a results release after
    // the send re-admits the ticker to the pool so the walk gate can convert
    // it into a reconciled second look — otherwise the 90-day blanket makes
    // the requalification machinery unreachable for the sent listing.
    const recentCoverage = coverageItems.filter((c) => c.date >= since);
    const excluded: string[] = [];
    for (const c of recentCoverage) {
      const released = await hasReportedSince(c.ticker, c.date);
      if (!released) excluded.push(c.ticker);
    }

    // (Cross-day veto memory RETIRED, July 16: with the conviction gate gone
    // there are no vetoes to remember — the score judges, the top survivor
    // ships. Feedback moves a weight or a filter, never a hidden bar.)

    // Identity-keyed sent history (no-repeat rule 1): every listing of a
    // sent company is consumed by one send — THX.L and THX.V are one idea.
    const { data: sentRows } = await db()
      .from("memos")
      .select("id, ticker, company_key, company_name, delivery_date")
      .eq("subscriber_id", subscriberId)
      .neq("ticker", "REVIEW")
      .neq("ticker", "NO_IDEA") // sentinel rows must not eat the 400-row window
      .gte("delivery_date", new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10))
      .order("delivery_date", { ascending: false })
      .limit(400); // must cover the full window for DAILY subscribers (~285 sends/400d)
    const sentCompanies = (sentRows ?? [])
      // "kind:*" keys are day-type sentinels (review, no_idea), never companies.
      .filter((r) => r.company_key && !(r.company_key as string).startsWith("kind:"))
      .map((r) => ({
        key: r.company_key as string,
        nameKey: r.company_name ? `name:${normalizeCompanyName(r.company_name as string)}` : null,
        ticker: r.ticker as string,
        memoId: r.id as string,
        date: r.delivery_date as string,
      }));

    const idea = await selectIdeaWithPreflight({
      subscriberId,
      profile,
      profileVersion: (profileRow?.version as number) ?? 0,
      storedScreens: (profileRow?.screens as ScreenParams[]) ?? [],
      storedScreensVersion: (profileRow?.screens_version as number) ?? -1,
      excluded,
      sentCompanies,
    });

    if (!idea.ok) {
      // Rule 5 (John, July 16): the only legitimate empty morning is the
      // screen itself returning zero survivors (or every survivor already
      // held) — the email states the funnel in numbers and asks which
      // filter to loosen. Never a silent review, never a vague apology.
      decision = noIdeaNote({ reason: idea.rationale });
      await logEvent("empty_funnel", {
        subscriberId,
        payload: { funnel: idea.funnel, reason: idea.rationale },
      });
      noIdeaContext = { attempts: idea.attempts, funnel: idea.funnel };
    }

    await updateWatchlist({
      subscriberId,
      pickedTicker: decision.kind === "idea" ? idea.ticker : null,
      flagged: idea.flagged,
      upcomingEarnings: idea.upcomingEarnings,
    });

    if (decision.kind === "idea") {
      ticker = idea.ticker;
      companyName = idea.companyName;
      data = idea.data;
      funnelContext = {
        rank: idea.funnel.rank,
        cleared: idea.funnel.ranked,
        blockedAhead: idea.funnel.blockedAhead.length,
        quietList: idea.funnel.quietList,
        conviction: idea.preflight.expectedConviction,
        convictionReason: idea.preflight.reason,
        whatWouldChange: idea.preflight.whatWouldChange,
      };
      // Rule 4: conviction carries the quality signal, not silence. The name
      // ships at whatever the honest number is; a quiet list is said plainly.
      selectionRationale =
        `${idea.rationale} — conviction ${idea.preflight.expectedConviction}/10 (${idea.preflight.reason}).` +
        (idea.preflight.whatWouldChange ? ` What would raise it: ${idea.preflight.whatWouldChange}` : "") +
        (idea.funnel.quietList
          ? ` — QUIET LIST: today's top score sits well below its trailing average; frame this plainly as the best of a quiet list, never oversold.`
          : "");

      // Rule 3: a company that re-qualified on new results writes as a
      // SECOND LOOK — the note opens with what changed since the last send
      // and reconciles any figure quoted from that note onto a consistent
      // basis. Never a fresh pitch that pretends the history isn't there.
      if (idea.requalifiedFrom) {
        const { data: original } = await db()
          .from("memos")
          .select("content_md")
          .eq("id", idea.requalifiedFrom.memoId)
          .single();
        kindOverride = "second_look";
        secondLookContext = {
          originalMarkdown: original?.content_md ?? "(original note unavailable)",
          originalDate: idea.requalifiedFrom.date,
          development: `New reported results since the ${idea.requalifiedFrom.date} note (sent as ${idea.requalifiedFrom.ticker}). Open with what changed, and reconcile every figure you quote from that note onto today's consistent basis — if a prior figure was mis-based, correct it plainly.`,
        };
        await logEvent("norepeat_requalified", {
          subscriberId,
          payload: { ticker, prior: idea.requalifiedFrom.ticker, priorDate: idea.requalifiedFrom.date },
        });
      }
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
  } else if (decision.kind === "no_idea") {
    // The idea slot, honestly empty: a sentinel row (like REVIEW) so the day
    // has its record; no dataset, no attachments, no company identity.
    ticker = "NO_IDEA";
    selectionRationale = decision.reason;
  } else if (decision.kind === "review") {
    ticker = "REVIEW";
    selectionRationale = decision.reason;
    const bookTickers = [...new Set(coverageItems.map((c) => c.ticker))].filter(
      (t) => t !== "REVIEW" && t !== "NO_IDEA",
    );
    const [bookHeadlines, bookEarnings, priorReviewRows] = await Promise.all([
      fetchHeadlines(bookTickers),
      fetchUpcomingEarnings(bookTickers, 30),
      // The last two reviews' headline + act-item, so this one repeats neither
      // without new information (John's July 14 P.S.).
      db()
        .from("memos")
        .select("delivery_date, content_md")
        .eq("subscriber_id", subscriberId)
        .eq("kind", "review")
        .not("sent_at", "is", null)
        .order("delivery_date", { ascending: false })
        .limit(2),
    ]);
    const priorReviews = (priorReviewRows.data ?? []).map((r) => ({
      date: r.delivery_date as string,
      ...extractReviewGist((r.content_md as string) ?? ""),
    }));
    reviewContext = {
      book: coverage,
      headlines: bookHeadlines,
      upcomingEarnings: bookEarnings,
      priorReviews,
    };
  }

  if (!ticker) {
    throw new Error(`Desk decision '${decision.kind}' resolved no ticker — aborting delivery.`);
  }
  const tickerless = decision.kind === "review" || decision.kind === "no_idea";
  if (!data && !tickerless) data = await fetchTickerData(ticker);
  const companyProfile = (data && (Array.isArray(data.profile) ? data.profile[0] : data.profile)) as
    | { website?: string; cik?: string; currency?: string; exchangeShortName?: string }
    | undefined;
  // Deterministic registry links (IR page, filings) for inline citing. The
  // shared research brief already surfaces the primary sources that matter,
  // so we no longer run a separate (expensive) discovery pass per subscriber.
  const researchLinks = tickerless ? [] : buildResearchLinks(ticker, companyName ?? ticker, companyProfile);

  return {
    kind: kindOverride ?? decision.kind,
    ticker,
    companyName,
    selectionRationale,
    followupContext,
    secondLookContext,
    reviewContext,
    noIdeaContext,
    funnelContext,
    referenceLinks: researchLinks,
    researchLinks,
    primarySources: [],
    coverage,
    firstNote,
    recentProfileChange,
  };
}

export async function processDelivery(delivery: DeliveryRow): Promise<void> {
  const { data: subscriber, error: subError } = await db()
    .from("subscribers")
    .select(
      "id, email, status, unsubscribe_token, portal_token, plan, first_name, preference_profiles(structured, philosophy, version, screens, screens_version)",
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
  // The attachments that carry the argument: a one-page fact sheet and the
  // full written report. Skipped on the rare crash-recovery reuse path, and on
  // reviews which have no single ticker.
  let tearSheet: Buffer | null = null;
  let fullReport: Buffer | null = null;
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
    // The analyst's memory: recent notes with live returns + subscriber
    // reactions. Needed on every path (book strip); quotes are day-cached.
    const { items: coverageItems } = await getCoverageContext(subscriber.id);

    let plan = delivery.plan ?? null;
    let data: TickerData | null = null;

    if (plan?.ticker) {
      // Resume: a previous attempt already decided the morning — go straight
      // to generation with a full, fresh function budget.
      console.log(`Resuming checkpointed plan for ${delivery.id}: ${plan.kind} on ${plan.ticker}`);
    } else {
      plan = await buildPlan(delivery, subscriber.id, subscriber.plan, profile, profileRow, coverageItems);
      await db().from("deliveries").update({ plan }).eq("id", delivery.id);
      await logEvent("plan_checkpointed", {
        subscriberId: subscriber.id,
        payload: { deliveryId: delivery.id, kind: plan.kind, ticker: plan.ticker },
      });
    }

    // Hydrate generation inputs from the plan.
    ticker = plan.ticker;
    const memoKind = plan.kind;

    if (memoKind === "no_idea") {
      // Rule 5 (John, July 16): the only legitimate empty morning — the
      // screen itself returned zero survivors (or every survivor is already
      // held). The email states the funnel in numbers, names names, and asks
      // which filter to loosen. No memo pipeline, no attachments. Composed,
      // inserted, and sent here; keep the send tail in sync with the shared
      // one at the bottom of this function.
      const note =
        (await writeNoIdeaNote({
          attempts: plan.noIdeaContext?.attempts ?? [],
          funnel: plan.noIdeaContext?.funnel,
          reason: plan.selectionRationale,
        })) ?? fallbackNoIdeaBody(plan.noIdeaContext?.funnel);
      const dateLine = new Date(delivery.delivery_date + "T00:00:00Z").toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
      title = note.subject;
      memoId = crypto.randomUUID();
      html = renderMemoEmail({
        coverNote: note.body,
        greetingName: greetingName(subscriber.email, subscriber.first_name),
        signOffName: config().ANALYST_NAME,
        firstNote: plan.firstNote,
        unsubscribeToken: subscriber.unsubscribe_token,
        billingUrl:
          subscriber.plan === "paid"
            ? `${config().APP_URL}/api/billing/${subscriber.portal_token}`
            : undefined,
        profileUrl: `${config().APP_URL}/profile/${subscriber.portal_token}`,
        upgradeUrl: isDailyPlan(subscriber.plan)
          ? undefined
          : `${config().APP_URL}/api/upgrade/${subscriber.portal_token}`,
        preparedFor: subscriber.email,
        dateLine,
      });
      const { error: noIdeaError } = await db().from("memos").insert({
        id: memoId,
        subscriber_id: subscriber.id,
        delivery_date: delivery.delivery_date,
        ticker: "NO_IDEA",
        company_key: "kind:no_idea", // sentinel — never a company identity
        company_name: null,
        title,
        content_md: `# ${note.subject}\n\n${note.body}\n\n## The funnel (internal record)\n\n${
          plan.noIdeaContext?.funnel ? JSON.stringify(plan.noIdeaContext.funnel, null, 1) : "(no funnel stats)"
        }\n\n${(plan.noIdeaContext?.attempts ?? [])
          .map((a) => `- ${a.ticker}: ${a.reason}`)
          .join("\n")}`,
        content_html: html,
        model: config().MEMO_MODEL,
        reply_address: replyAddress(memoId),
        kind: "no_idea",
        pitch_price: null,
        pitch_currency: null,
        extras: { attempts: plan.noIdeaContext?.attempts ?? [], funnel: plan.noIdeaContext?.funnel ?? null, dateLine },
      });
      if (noIdeaError) throw new Error(`Memo insert failed: ${noIdeaError.message}`);

      const noIdeaResendId = await sendEmail({
        to: subscriber.email,
        subject: title,
        html,
        replyTo: replyAddress(memoId),
        unsubscribeToken: subscriber.unsubscribe_token,
      });
      await db()
        .from("memos")
        .update({ resend_message_id: noIdeaResendId, sent_at: new Date().toISOString() })
        .eq("id", memoId);
      await logEvent("memo_sent", {
        subscriberId: subscriber.id,
        payload: { memoId, ticker: "NO_IDEA", resendId: noIdeaResendId },
      });
      return;
    }
    const companyName = plan.companyName;
    const selectionRationale = plan.selectionRationale;
    const followupContext = plan.followupContext;
    const secondLookContext = plan.secondLookContext;
    const reviewContext = plan.reviewContext;
    const referenceLinks = plan.referenceLinks;
    const researchLinks = plan.researchLinks;
    const coverage = plan.coverage;
    const firstNote = plan.firstNote;
    const recentProfileChange = plan.recentProfileChange;

    data =
      memoKind === "review" && reviewContext
        ? ({
            book: reviewContext.book,
            headlines: reviewContext.headlines,
            upcomingEarnings: reviewContext.upcomingEarnings,
          } as unknown as TickerData)
        : await fetchTickerData(ticker);


    // Research once, write per subscriber: acquire the day's shared fact
    // base for this ticker (built by whichever worker gets here first).
    // null → legacy self-researched path, so a brief failure never blocks.
    // The comp table (sector-aware, filing facts cached) builds in parallel —
    // ONE table feeds the writer, the verifier, and the one-pager alike.
    const [researchBrief, compTable] = await Promise.all([
      memoKind === "review" ? null : getOrBuildBrief(ticker, companyName, data, delivery.id),
      memoKind === "review" ? null : buildCompTable({ ticker, companyName, data }),
    ]);

    // Context-only holdings: the writer sees what they own; selection doesn't.
    const holdings = await getPortfolio(subscriber.id);

    // Final queue attempt: ship good over perfect — fewer tool rounds, no
    // editorial pass, one repair round. Slow-API days must not eat all three
    // attempts chasing a ceiling that depth can't fit under.
    const lightMode = (delivery.attempts ?? 0) >= 3;
    if (lightMode) console.warn(`Final attempt for ${delivery.id} — light mode.`);
    const memo = await generateVerifiedMemo({
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
      researchBrief: researchBrief ?? undefined,
      portfolio: holdings,
      referenceLinks,
      peerComps: compTable?.textForPrompt,
      light: lightMode,
    });
    const h1Title = memo.title; // "TICKER — hook" — the attached report's title
    if (memoKind === "followup") metaForVerdict = memo.meta;
    quality = {
      kind: memoKind,
      ticker,
      conviction: memo.meta?.conviction ?? null,
      // Retired with the pick step (July 16) — its "catalyst strength N/10"
      // phrase was the only producer; a regex over free text would now only
      // ever false-positive on assessor prose.
      catalystStrength: null,
      editorialRevised: memo.editorial.revised,
      editorialIssues: memo.editorial.issueCount,
      verifyCritical: memo.verification.critical_issues.length,
      verifyMinor: memo.verification.minor_issues.length,
      genMs: Date.now() - genStartedAt,
    };
    const pitch = extractPitchPrice(data);
    const dateLine = new Date(delivery.delivery_date + "T00:00:00Z").toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });

    // Build the attachments FIRST: page one can legitimately come back null
    // (it must pass its own fact-check to ship), and the cover note must
    // describe what is ACTUALLY attached — never promise a one-pager that
    // failed its gate.
    if (memoKind !== "review" && config().ATTACH_TEARSHEET === "true") {
      [tearSheet, fullReport] = await Promise.all([
        // Page one: the memo page, distilled from the verified note and
        // fact-checked on its own; null (report-only send) if it can't pass.
        buildTearSheet({
          ticker,
          companyName,
          firstName: greetingName(subscriber.email, subscriber.first_name),
          dateLine,
          data,
          meta: memo.meta,
          fullNoteMarkdown: memo.markdown,
          verifySources: memo.sources,
          peerComps: compTable?.textForPrompt,
          peers: compTable?.rows.filter((r) => !r.self).map((r) => ({ symbol: r.ticker, name: r.name })),
        }),
        // The report carries the full workings: chart, comps, scenarios.
        buildFullReport({
          markdown: memo.markdown,
          ticker,
          companyName,
          dateLine,
          data,
          meta: memo.meta,
          sources: memo.sources,
          compTable,
        }),
      ]);
    }

    // The email is a short cover note distilled from the verified full note.
    // Fail-open to a clean subject + one-liner if the distillation errors.
    const cover = await writeCoverNote({
      fullNoteMarkdown: memo.markdown,
      ticker,
      meta: memo.meta,
      isReview: memoKind === "review",
      attachments: { onePager: tearSheet !== null, fullReport: fullReport !== null },
      funnel: memoKind === "idea" || memoKind === "second_look" ? plan.funnelContext : undefined,
    });
    const hook = h1Title.replace(/^[^—:-]*[—:-]\s*/, "").trim();
    // Rule 4: the subject says what the email IS — reviews lead "Your book —";
    // a ticker subject promises a fresh idea.
    const coverSubject =
      cover?.subject ||
      (memoKind === "review"
        ? `Your book — ${hook || "today's read-through"}`
        : `${bareTicker(ticker)}: ${hook || "today's idea"}`);
    const coverBody =
      cover?.body ||
      fallbackCoverBody({
        isReview: memoKind === "review",
        oneLiner: memo.meta?.one_liner,
        onePager: tearSheet !== null,
        fullReport: fullReport !== null,
      });
    title = coverSubject; // the DB title + email subject = what the reader saw

    memoId = crypto.randomUUID();
    html = renderMemoEmail({
      coverNote: coverBody,
      greetingName: greetingName(subscriber.email, subscriber.first_name),
      signOffName: config().ANALYST_NAME,
      firstNote,
      unsubscribeToken: subscriber.unsubscribe_token,
      billingUrl:
        subscriber.plan === "paid"
          ? `${config().APP_URL}/api/billing/${subscriber.portal_token}`
          : undefined,
      profileUrl: `${config().APP_URL}/profile/${subscriber.portal_token}`,
      upgradeUrl: isDailyPlan(subscriber.plan)
        ? undefined
        : `${config().APP_URL}/api/upgrade/${subscriber.portal_token}`,
      preparedFor: subscriber.email,
      dateLine,
    });
    const { error: memoError } = await db().from("memos").insert({
      id: memoId,
      subscriber_id: subscriber.id,
      delivery_date: delivery.delivery_date,
      ticker,
      // Identity key (no-repeat rule 1): one send consumes the company on
      // every exchange it trades — THX.L and THX.V share this key.
      company_key: memoKind === "review" ? "kind:review" : identityFromProfile(data.profile).key,
      company_name: companyName ?? null,
      title,
      content_md: memo.markdown,
      content_html: html,
      model: memo.model,
      reply_address: replyAddress(memoId),
      kind: memoKind,
      pitch_price: pitch.price,
      pitch_currency: pitch.currency,
      // Keep only what coverage/telemetry read back — the email is prose now.
      extras: { researchLinks, sources: memo.sources, meta: memo.meta, dateLine },
    });
    if (memoError) throw new Error(`Memo insert failed: ${memoError.message}`);
  }

  const resendId = await sendEmail({
    to: subscriber.email,
    subject: title,
    html,
    replyTo: replyAddress(memoId),
    unsubscribeToken: subscriber.unsubscribe_token,
    attachments: buildAttachments(ticker, tearSheet, fullReport),
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
