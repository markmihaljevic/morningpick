/**
 * Inspect follow-up triggers for a subscriber, and optionally force-generate
 * a demo follow-up note on their most recent pick (sent as [demo], no memo
 * row created — the real pipeline is untouched).
 *
 *   npx tsx scripts/send-followup-demo.ts you@example.com          # inspect only
 *   npx tsx scripts/send-followup-demo.ts you@example.com --force  # generate + send
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { db } from "../lib/db";
import { getCoverageContext, coverageForPrompt, checkFollowupTrigger } from "../lib/coverage";
import { fetchTickerData } from "../lib/fmp";
import { generateVerifiedMemo } from "../lib/memo";
import { renderMemoEmail } from "../lib/emails/memo-email";
import { writeCoverNote, bareTicker } from "../lib/cover-note";
import { buildTearSheet } from "../lib/tear-sheet";
import { buildCompTable } from "../lib/comp-table";
import { buildFullReport } from "../lib/full-report";
import { config } from "../lib/config";
import { sendEmail, replyAddress } from "../lib/resend";

async function main() {
  const email = process.argv[2];
  const force = process.argv.includes("--force");
  if (!email) {
    console.error("Usage: npx tsx scripts/send-followup-demo.ts you@example.com [--force]");
    process.exit(1);
  }

  const { data: subscriber } = await db()
    .from("subscribers")
    .select("id, email, unsubscribe_token, preference_profiles(structured, philosophy)")
    .eq("email", email)
    .single();
  if (!subscriber) throw new Error("Subscriber not found");
  const row = Array.isArray(subscriber.preference_profiles)
    ? subscriber.preference_profiles[0]
    : subscriber.preference_profiles;
  const profile = {
    structured: (row?.structured as Record<string, unknown>) ?? {},
    philosophy: (row?.philosophy as string) ?? "",
  };

  const { items, taste } = await getCoverageContext(subscriber.id);
  console.error("Coverage:", JSON.stringify(coverageForPrompt(items), null, 2));
  console.error("Taste:", JSON.stringify(taste));

  const trigger = await checkFollowupTrigger(items);
  console.error("Trigger:", trigger ? `${trigger.reason} — ${trigger.detail}` : "none today");

  if (!force) return;

  // Forced demo: follow up on the oldest covered name with a pitch price.
  const target = trigger?.lastNote ?? [...items].reverse().find((i) => i.pitchPrice);
  if (!target) throw new Error("No covered name with a pitch price to follow up on.");
  const { data: original } = await db()
    .from("memos")
    .select("content_md, company_name")
    .eq("id", target.memoId)
    .single();

  console.error(`Generating follow-up on ${target.ticker}…`);
  const data = await fetchTickerData(target.ticker);
  const memo = await generateVerifiedMemo({
    profile,
    ticker: target.ticker,
    companyName: original?.company_name ?? undefined,
    data,
    selectionRationale: trigger?.detail ?? "Demo follow-up.",
    coverage: coverageForPrompt(items),
    followup: {
      originalMarkdown: original?.content_md ?? "(unavailable)",
      originalDate: target.date,
      priceThen: target.pitchPrice,
      priceNow: target.priceNow,
      triggerDetail:
        trigger?.detail ??
        `Demo trigger: reviewing the ${target.date} note on ${target.ticker} (${target.pitchPrice} → ${target.priceNow}).`,
    },
  });

  const dateLine = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const compTable = await buildCompTable({ ticker: target.ticker, companyName: original?.company_name ?? undefined, data });
  const cover = await writeCoverNote({ fullNoteMarkdown: memo.markdown, ticker: target.ticker, meta: memo.meta });
  const hook = memo.title.replace(/^[^—:-]*[—:-]\s*/, "").trim();
  const coverSubject = cover?.subject || `${bareTicker(target.ticker)}: ${hook || "an update"}`;
  const coverBody =
    cover?.body ||
    `${memo.meta?.one_liner ?? "An update on a name I flagged for you."}\n\nThe full write-up and a one-page fact sheet are attached.`;

  const html = renderMemoEmail({
    coverNote: coverBody,
    signOffName: config().ANALYST_NAME,
    unsubscribeToken: subscriber.unsubscribe_token,
    preparedFor: subscriber.email,
    dateLine,
  });
  const [tearSheet, fullReport] = await Promise.all([
    buildTearSheet({ ticker: target.ticker, companyName: original?.company_name ?? undefined, dateLine, preparedFor: subscriber.email, data, meta: memo.meta, compTable }),
    buildFullReport({ markdown: memo.markdown, ticker: target.ticker, companyName: original?.company_name ?? undefined, dateLine, data, meta: memo.meta, sources: memo.sources }),
  ]);
  const bare = bareTicker(target.ticker);
  const attachments: { filename: string; content: Buffer }[] = [];
  if (tearSheet) attachments.push({ filename: `${bare}-one-pager.pdf`, content: tearSheet });
  if (fullReport) attachments.push({ filename: `${bare}-full-report.pdf`, content: fullReport });
  const id = await sendEmail({
    to: subscriber.email,
    subject: `[demo] ${coverSubject}`,
    html,
    replyTo: replyAddress(target.memoId),
    unsubscribeToken: subscriber.unsubscribe_token,
    attachments: attachments.length > 0 ? attachments : undefined,
  });
  console.error(`Sent: ${id}`);
  console.log(memo.markdown.slice(0, 1500));
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
