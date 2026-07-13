/**
 * Generate a note through the full production pipeline (desk editor,
 * pre-flight, all note kinds) for a real subscriber and SEND it to them as
 * a demo — without touching the memos table or the delivery queue.
 *
 *   npx tsx scripts/send-demo.ts you@example.com
 *   FORCE_KIND=review npx tsx scripts/send-demo.ts you@example.com
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { writeFileSync } from "fs";
import { db } from "../lib/db";
import type { Profile } from "../lib/profile";
import { type ScreenParams } from "../lib/screens";
import { getCoverageContext, coverageForPrompt } from "../lib/coverage";
import { decideNote, fallbackNote, type NoteKind } from "../lib/desk-editor";
import { selectIdeaWithPreflight, updateWatchlist, hasReportedSince } from "../lib/select-idea";
import { fetchTickerData, fetchHeadlines, fetchUpcomingEarnings, type TickerData } from "../lib/fmp";
import { generateVerifiedMemo } from "../lib/memo";
import { renderMemoEmail } from "../lib/emails/memo-email";
import { buildResearchLinks } from "../lib/research-links";
import { getOrBuildBrief } from "../lib/research";
import { getPortfolio } from "../lib/portfolio";
import { greetingName } from "../lib/greeting";
import { buildTearSheet } from "../lib/tear-sheet";
import { buildFullReport } from "../lib/full-report";
import { buildCompTable } from "../lib/comp-table";
import { writeCoverNote, fallbackCoverBody, bareTicker } from "../lib/cover-note";
import { normalizeCompanyName } from "../lib/company-key";
import { config } from "../lib/config";
import { sendEmail, replyAddress } from "../lib/resend";

const REPEAT_EXCLUSION_DAYS = 90; // match the worker

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npx tsx scripts/send-demo.ts you@example.com");
    process.exit(1);
  }

  const { data: subscriber, error } = await db()
    .from("subscribers")
    .select(
      "id, email, unsubscribe_token, portal_token, plan, first_name, preference_profiles(structured, philosophy, version, screens, screens_version)",
    )
    .eq("email", email)
    .single();
  if (error) throw new Error(`Subscriber not found: ${error.message}`);

  const row = Array.isArray(subscriber.preference_profiles)
    ? subscriber.preference_profiles[0]
    : subscriber.preference_profiles;
  const profile: Profile = {
    structured: (row?.structured as Record<string, unknown>) ?? {},
    philosophy: (row?.philosophy as string) ?? "",
  };

  const { items: coverageItems, taste } = await getCoverageContext(subscriber.id);
  const coverage = coverageForPrompt(coverageItems);

  // DEMO_TICKER=THX.L forces a full idea note on one name — bypasses selection
  // and the conviction gate so a preview always shows the whole idea+one-pager
  // experience, even for a high-bar profile that would otherwise book-review.
  const demoTicker = process.env.DEMO_TICKER?.trim();
  // DEMO_SECOND_LOOK=THX.V forces a reconciliation second look (no-repeat
  // rule 3): finds the subscriber's most recent prior note for that COMPANY
  // (any listing, keyed by ISIN/name) and writes the "what changed + reconcile
  // the earlier figures" note the gate produces when a company re-qualifies.
  const demoSecondLook = process.env.DEMO_SECOND_LOOK?.trim();
  let decision =
    demoTicker
      ? { kind: "idea" as NoteKind, reason: `forced demo idea on ${demoTicker}` }
      : (process.env.FORCE_KIND as NoteKind | undefined) &&
          ["second_look", "review"].includes(process.env.FORCE_KIND!)
        ? await fallbackNote({ coverageItems, reason: `forced ${process.env.FORCE_KIND} demo` })
        : await decideNote({ coverageItems, dailyPlan: true });

  if (demoSecondLook) {
    const { identityForTicker } = await import("../lib/company-key");
    const id = await identityForTicker(demoSecondLook);
    const { data: prior } = await db()
      .from("memos")
      .select("id, ticker, delivery_date")
      .eq("subscriber_id", subscriber.id)
      .eq("company_key", id.key)
      .order("delivery_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!prior) throw new Error(`No prior note for ${demoSecondLook} (company key ${id.key}) to reconcile.`);
    decision = {
      kind: "second_look" as NoteKind,
      ticker: demoSecondLook,
      revisit: { memoId: prior.id as string, date: prior.delivery_date as string },
      reason: `New reported results since the ${prior.delivery_date} note (sent as ${prior.ticker}). Open with what changed since that note, and reconcile every figure you quote from it onto today's consistent basis — if a prior figure was mis-based (e.g. a currency mix), correct it plainly.`,
    } as typeof decision & { ticker: string; revisit: { memoId: string; date: string } };
  }
  console.error(`Desk decision: ${decision.kind} — ${decision.reason}`);

  let ticker = "";
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
  let memoKind: NoteKind = decision.kind;

  if (decision.kind === "idea" && demoTicker) {
    ticker = demoTicker;
    data = await fetchTickerData(demoTicker);
    const p = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as { companyName?: string } | undefined;
    companyName = p?.companyName;
    selectionRationale = `Forced demo idea on ${demoTicker} — showcasing the full idea note, one-pager, and sector-aware comp table.`;
    console.error(`Forced demo ticker: ${ticker} (${companyName ?? "?"})`);
  } else if (decision.kind === "idea") {
    const since = new Date(Date.now() - REPEAT_EXCLUSION_DAYS * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const recentCoverage = coverageItems.filter((c) => c.date >= since);
    const excluded: string[] = [];
    for (const c of recentCoverage) {
      if (!(await hasReportedSince(c.ticker, c.date))) excluded.push(c.ticker);
    }
    // Identity-keyed sent history (no-repeat rule 1) — mirrors the worker.
    const { data: sentRows } = await db()
      .from("memos")
      .select("id, ticker, company_key, company_name, delivery_date")
      .eq("subscriber_id", subscriber.id)
      .neq("ticker", "REVIEW")
      .gte("delivery_date", new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10))
      .order("delivery_date", { ascending: false })
      .limit(400); // must cover the full window for DAILY subscribers (~285 sends/400d)
    const sentCompanies = (sentRows ?? [])
      .filter((r) => r.company_key && r.company_key !== "kind:review")
      .map((r) => ({
        key: r.company_key as string,
        nameKey: r.company_name ? `name:${normalizeCompanyName(r.company_name as string)}` : null,
        ticker: r.ticker as string,
        memoId: r.id as string,
        date: r.delivery_date as string,
      }));
    console.error("Running idea funnel with pre-flight…");
    const idea = await selectIdeaWithPreflight({
      subscriberId: subscriber.id,
      profile,
      profileVersion: (row?.version as number) ?? 0,
      storedScreens: (row?.screens as ScreenParams[]) ?? [],
      storedScreensVersion: (row?.screens_version as number) ?? -1,
      excluded,
      recentTickers: coverageItems.slice(0, 10).map((c) => c.ticker),
      taste,
      sentCompanies,
    });
    for (const a of idea.attempts) {
      console.error(
        `  preflight ${a.ticker}: ${a.write ? "WRITE" : "VETO"} (${a.expectedConviction}/10 — ${a.reason})`,
      );
    }
    if (!idea.ok) {
      const failSummary = idea.attempts
        .map((a) => `${a.ticker} (${a.expectedConviction}/10: ${a.reason})`)
        .join("; ");
      decision = await fallbackNote({
        coverageItems,
        reason: `today's candidates failed pre-flight: ${failSummary}`,
      });
      memoKind = decision.kind;
      console.error(`Fallback decision: ${decision.kind} — ${decision.reason}`);
    }
    await updateWatchlist({
      subscriberId: subscriber.id,
      pickedTicker: decision.kind === "idea" ? idea.ticker : null,
      flagged: idea.flagged,
      upcomingEarnings: idea.upcomingEarnings,
    });
    console.error(`Watchlist flagged: ${idea.flagged.map((f) => f.ticker).join(", ") || "none"}`);

    if (decision.kind === "idea") {
      ticker = idea.ticker;
      companyName = idea.companyName;
      data = idea.data;
      selectionRationale = idea.ok
        ? idea.rationale
        : `${idea.rationale} — NOTE: pre-flight scored this ${idea.preflight.expectedConviction}/10 (${idea.preflight.reason}); write it with honest conviction, do not oversell.`;
      console.error(`Selected: ${ticker} — ${selectionRationale}`);
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
    reviewContext = { book: coverage, headlines: bookHeadlines, upcomingEarnings: bookEarnings };
    data = { book: coverage, headlines: bookHeadlines, upcomingEarnings: bookEarnings } as unknown as TickerData;
  }

  if (!ticker) throw new Error(`Desk decision '${decision.kind}' resolved no ticker.`);
  if (!data) data = await fetchTickerData(ticker);
  const companyProfile = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as
    | { website?: string; cik?: string; currency?: string; exchangeShortName?: string }
    | undefined;
  const referenceLinks =
    memoKind === "review" ? [] : buildResearchLinks(ticker, companyName ?? ticker, companyProfile);

  const [researchBrief, compTable] = await Promise.all([
    memoKind === "review" ? null : getOrBuildBrief(ticker, companyName, data, "demo"),
    memoKind === "review" ? null : buildCompTable({ ticker, companyName, data }),
  ]);
  const holdings = await getPortfolio(subscriber.id);
  console.error(`Research brief: ${researchBrief ? `ready (${researchBrief.sources.length} sources)` : "unavailable — legacy path"}`);
  console.error(
    `Comp table: ${compTable ? `${compTable.groupLabel} — ${compTable.columns.map((c) => c.label).join(", ")} (${compTable.rows.length} rows)` : "none"}`,
  );
  console.error(`Generating + fact-checking ${memoKind} note…`);
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
    researchBrief: researchBrief ?? undefined,
    portfolio: holdings,
    referenceLinks,
    peerComps: compTable?.textForPrompt,
  });
  console.error(
    `Verification: ${memo.verification.critical_issues.length} critical, ${memo.verification.minor_issues.length} minor issues`,
  );

  const dateLine = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  const [tearSheet, fullReport] =
    memoKind === "review"
      ? [null, null]
      : await Promise.all([
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
          buildFullReport({ markdown: memo.markdown, ticker, companyName, dateLine, data, meta: memo.meta, sources: memo.sources, compTable }),
        ]);
  console.error(
    `Attachments: one-pager ${tearSheet ? `${(tearSheet.length / 1024).toFixed(0)} KB` : "none"}, ` +
      `full report ${fullReport ? `${(fullReport.length / 1024).toFixed(0)} KB` : "none"}`,
  );

  // Cover note AFTER the PDFs so it describes what is actually attached.
  const cover = await writeCoverNote({
    fullNoteMarkdown: memo.markdown,
    ticker,
    meta: memo.meta,
    isReview: memoKind === "review",
    attachments: { onePager: tearSheet !== null, fullReport: fullReport !== null },
  });
  const hook = memo.title.replace(/^[^—:-]*[—:-]\s*/, "").trim();
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
  console.error(`Cover note: ${cover ? `${cover.body.split(/\s+/).length} words` : "FALLBACK"} — subject "${coverSubject}"`);

  const html = renderMemoEmail({
    coverNote: coverBody,
    greetingName: greetingName(subscriber.email, subscriber.first_name),
    signOffName: config().ANALYST_NAME,
    unsubscribeToken: subscriber.unsubscribe_token,
    profileUrl: `https://morningpick.ai/profile/${subscriber.portal_token}`,
    preparedFor: subscriber.email,
    dateLine,
  });
  const htmlPath = process.env.DEMO_HTML_OUT;
  if (htmlPath) {
    writeFileSync(htmlPath, html);
    console.error(`HTML written to ${htmlPath}`);
  }

  const bare = bareTicker(ticker);
  const attachments: { filename: string; content: Buffer }[] = [];
  if (tearSheet) attachments.push({ filename: `${bare}-one-pager.pdf`, content: tearSheet });
  if (fullReport) attachments.push({ filename: `${bare}-full-report.pdf`, content: fullReport });

  const resendId = await sendEmail({
    to: subscriber.email,
    subject: `[demo] ${coverSubject}`,
    html,
    replyTo: replyAddress(`demo-${crypto.randomUUID()}`),
    unsubscribeToken: subscriber.unsubscribe_token,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
  console.error(`Sent: ${resendId} → ${subscriber.email}`);
  console.log(memo.markdown);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
