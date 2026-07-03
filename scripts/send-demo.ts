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
import { getCoverageContext, coverageForPrompt, buildBookRows } from "../lib/coverage";
import { decideNote, fallbackNote, type NoteKind } from "../lib/desk-editor";
import { selectIdeaWithPreflight } from "../lib/select-idea";
import { fetchTickerData, fetchHeadlines, fetchUpcomingEarnings, type TickerData } from "../lib/fmp";
import { generateVerifiedMemo } from "../lib/memo";
import { renderMemoEmail } from "../lib/emails/memo-email";
import { buildFiveYearChartUrl } from "../lib/chart";
import { buildResearchLinks } from "../lib/research-links";
import { buildKeyStats } from "../lib/stats";
import { buildCompsRows } from "../lib/comps";
import { buildStreetItems } from "../lib/street";
import { discoverPrimarySources } from "../lib/enrich-sources";
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
      "id, email, unsubscribe_token, portal_token, plan, preference_profiles(structured, philosophy, version, screens, screens_version)",
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

  let decision =
    (process.env.FORCE_KIND as NoteKind | undefined) &&
    ["second_look", "review"].includes(process.env.FORCE_KIND!)
      ? await fallbackNote({ coverageItems, reason: `forced ${process.env.FORCE_KIND} demo` })
      : await decideNote({ coverageItems, dailyPlan: true });
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

  if (decision.kind === "idea") {
    const since = new Date(Date.now() - REPEAT_EXCLUSION_DAYS * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    const excluded = coverageItems.filter((c) => c.date >= since).map((c) => c.ticker);
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
    });
    for (const a of idea.attempts) {
      console.error(
        `  preflight ${a.ticker}: ${a.write ? "WRITE" : "PASS"} (${a.expectedConviction}/10 — ${a.reason})`,
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
  console.error(
    `Primary sources: ${primarySources.map((s) => `[${s.type}] ${s.title}`).join(" | ") || "none"}`,
  );

  console.error(`Generating + fact-checking ${memoKind} note…`);
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
      referenceLinks,
    }),
    memoKind === "review"
      ? Promise.resolve(null)
      : buildFiveYearChartUrl(ticker, companyProfile?.currency),
  ]);
  console.error(
    `Verification: ${memo.verification.critical_issues.length} critical, ${memo.verification.minor_issues.length} minor issues`,
  );
  console.error(`Chart: ${chartUrl ?? "none"}`);

  const html = renderMemoEmail({
    markdown: memo.markdown,
    unsubscribeToken: subscriber.unsubscribe_token,
    preparedFor: subscriber.email,
    dateLine: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    stats: memoKind === "review" ? [] : buildKeyStats(data),
    street: memoKind === "review" ? [] : buildStreetItems(data),
    comps: memoKind === "review" ? [] : buildCompsRows(ticker, data),
    book:
      process.env.FORCE_BOOK || new Date().getUTCDay() === 1 || memoKind === "review"
        ? buildBookRows(coverageItems)
        : [],
    meta: memoKind === "review" ? null : memo.meta,
    primarySources,
    chartUrl,
    sources: memo.sources,
  });
  const htmlPath = process.env.DEMO_HTML_OUT;
  if (htmlPath) {
    writeFileSync(htmlPath, html);
    console.error(`HTML written to ${htmlPath}`);
  }

  const resendId = await sendEmail({
    to: subscriber.email,
    subject: `[demo] ${memo.title}`,
    html,
    replyTo: replyAddress(`demo-${crypto.randomUUID()}`),
    unsubscribeToken: subscriber.unsubscribe_token,
  });
  console.error(`Sent: ${resendId} → ${subscriber.email}`);
  console.log(memo.markdown);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
