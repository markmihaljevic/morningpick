/**
 * Generate a memo through the full profile-aware funnel for a real
 * subscriber and SEND it to them as a demo — without touching the memos
 * table or the delivery queue (tomorrow's real run is unaffected).
 *
 *   npx tsx scripts/send-demo.ts you@example.com
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { writeFileSync } from "fs";
import { db } from "../lib/db";
import type { Profile } from "../lib/profile";
import { getSubscriberScreens, buildCandidatePool, type ScreenParams } from "../lib/screens";
import { shortlistCandidates, enrichShortlist, finalSelect } from "../lib/selection";
import { fetchTickerData, fetchHeadlines, fetchUpcomingEarnings } from "../lib/fmp";
import { generateVerifiedMemo } from "../lib/memo";
import { renderMemoEmail } from "../lib/emails/memo-email";
import { buildFiveYearChartUrl } from "../lib/chart";
import { buildResearchLinks } from "../lib/research-links";
import { buildKeyStats } from "../lib/stats";
import { buildStreetItems } from "../lib/street";
import { discoverPrimarySources } from "../lib/enrich-sources";
import { sendEmail, replyAddress } from "../lib/resend";

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npx tsx scripts/send-demo.ts you@example.com");
    process.exit(1);
  }

  const { data: subscriber, error } = await db()
    .from("subscribers")
    .select(
      "id, email, unsubscribe_token, portal_token, preference_profiles(structured, philosophy, version, screens, screens_version)",
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

  const { data: recentMemos } = await db()
    .from("memos")
    .select("ticker")
    .eq("subscriber_id", subscriber.id)
    .order("delivery_date", { ascending: false })
    .limit(30);
  const recent = (recentMemos ?? []).map((m) => ({ ticker: m.ticker }));

  console.error("Deriving screens…");
  const screens = await getSubscriberScreens(
    subscriber.id,
    profile,
    (row?.version as number) ?? 0,
    (row?.screens as ScreenParams[]) ?? [],
    (row?.screens_version as number) ?? -1,
  );
  console.error(screens.map((s) => `  • ${s.label}`).join("\n"));

  console.error("Building pool…");
  const pool = await buildCandidatePool(screens);
  console.error(`Pool: ${pool.length} candidates`);

  const shortlist = await shortlistCandidates(profile, pool, recent.map((r) => r.ticker), recent);
  console.error(`Shortlist: ${shortlist.map((c) => c.ticker).join(", ")}`);

  const [enriched, headlines, upcomingEarnings] = await Promise.all([
    enrichShortlist(shortlist),
    fetchHeadlines(shortlist.map((c) => c.ticker)),
    fetchUpcomingEarnings(shortlist.map((c) => c.ticker)),
  ]);
  console.error(`Headlines for ${Object.keys(headlines).length} of ${shortlist.length} tickers`);
  console.error(`Upcoming earnings for ${Object.keys(upcomingEarnings).length} tickers`);
  const sectorByTicker = new Map(pool.map((c) => [c.ticker.toUpperCase(), c.sector]));
  const recentWithSectors = recent.map((r) => ({
    ...r,
    sector: sectorByTicker.get(r.ticker.toUpperCase()) ?? undefined,
  }));
  const selection = await finalSelect(profile, enriched, recentWithSectors, undefined, headlines, upcomingEarnings);
  console.error(`Selected: ${selection.ticker} — ${selection.rationale}`);

  const companyName = pool.find((c) => c.ticker === selection.ticker)?.name;
  const [data, primarySources] = await Promise.all([
    fetchTickerData(selection.ticker),
    discoverPrimarySources(selection.ticker, companyName ?? selection.ticker),
  ]);
  const companyProfile0 = (Array.isArray(data.profile) ? data.profile[0] : data.profile) as
    | { website?: string; cik?: string; currency?: string; exchangeShortName?: string }
    | undefined;
  const referenceLinks = [
    ...buildResearchLinks(selection.ticker, companyName ?? selection.ticker, companyProfile0),
    ...primarySources.map((s) => ({ label: s.title, url: s.url })),
  ];
  console.error(`Primary sources: ${primarySources.map((s) => `[${s.type}] ${s.title}`).join(" | ") || "none cleared the bar"}`);
  console.error("Generating + fact-checking memo…");
  const memo = await generateVerifiedMemo({
    profile,
    ticker: selection.ticker,
    companyName,
    data,
    selectionRationale: selection.rationale,
    referenceLinks,
  });
  console.error(
    `Verification: ${memo.verification.critical_issues.length} critical, ${memo.verification.minor_issues.length} minor issues`,
  );

  const chartUrl = await buildFiveYearChartUrl(selection.ticker, companyProfile0?.currency);
  console.error(`Chart: ${chartUrl ?? "unavailable"}`);

  const html = renderMemoEmail({
    markdown: memo.markdown,
    unsubscribeToken: subscriber.unsubscribe_token,
    preparedFor: subscriber.email,
    dateLine: new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    stats: buildKeyStats(data),
    street: buildStreetItems(data),
    meta: memo.meta,
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
