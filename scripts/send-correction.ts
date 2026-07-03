/**
 * Errata: send an in-thread correction for a sent memo. Pros forgive
 * errors; they don't forgive silence.
 *
 *   npx tsx scripts/send-correction.ts <memoId> "What was wrong and what's right."
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });

import { db, logEvent } from "../lib/db";
import { sendEmail, replyAddress } from "../lib/resend";
import { emailLayout } from "../lib/emails/layout";
import { BRAND } from "../lib/brand";

async function main() {
  const [memoId, ...words] = process.argv.slice(2);
  const correction = words.join(" ").trim();
  if (!memoId || !correction) {
    console.error('Usage: npx tsx scripts/send-correction.ts <memoId> "correction text"');
    process.exit(1);
  }

  const { data: memo, error } = await db()
    .from("memos")
    .select("id, ticker, title, subscriber_id, subscribers(email, unsubscribe_token)")
    .eq("id", memoId)
    .single();
  if (error || !memo) throw new Error(`Memo not found: ${error?.message}`);
  const sub = (Array.isArray(memo.subscribers) ? memo.subscribers[0] : memo.subscribers) as {
    email: string;
    unsubscribe_token: string;
  };

  const body = `
    <p style="margin:0 0 8px;font-family:Menlo,Consolas,monospace;font-size:10px;letter-spacing:2px;color:${BRAND.gold};font-weight:700;">CORRECTION</p>
    <p style="margin:0 0 14px;font-family:${BRAND.sans};font-size:12.5px;color:${BRAND.slate};">Re: ${escapeHtml(memo.title ?? memo.ticker)}</p>
    <p style="margin:0 0 15px;">${escapeHtml(correction)}</p>
    <p style="margin:0;font-family:${BRAND.sans};font-size:13px;color:${BRAND.slate};">We correct our own record, always. The note's PDF and archive copy stand as originally sent, with this correction attached to the thread.</p>
  `;
  const html = emailLayout(body, { unsubscribeToken: sub.unsubscribe_token });

  const resendId = await sendEmail({
    to: sub.email,
    subject: `Correction — ${memo.title ?? memo.ticker}`,
    html,
    replyTo: replyAddress(memo.id),
    unsubscribeToken: sub.unsubscribe_token,
  });
  await logEvent("correction_sent", {
    subscriberId: memo.subscriber_id,
    payload: { memoId, correction: correction.slice(0, 300) },
  });
  console.error(`Correction sent: ${resendId} → ${sub.email}`);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
