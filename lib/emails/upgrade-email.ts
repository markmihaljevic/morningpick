import { emailLayout } from "./layout";
import { config } from "../config";

/**
 * Sent when a free subscriber asks the research desk a question — the desk
 * answers questions on the daily plan. Warm, short, one clear action, plain.
 */
export function renderUpgradeNudgeEmail(args: {
  unsubscribeToken: string;
  portalToken: string;
  firstQuestion: string;
}): string {
  const cfg = config();
  const upgradeUrl = `${cfg.APP_URL}/api/upgrade/${args.portalToken}`;
  const body = `
    <p style="margin:0 0 14px;">Good question — and exactly the kind I dig into for subscribers on the daily desk:</p>
    <p style="margin:0 0 14px;color:#5f6368;">&gt; ${escape(args.firstQuestion)}</p>
    <p style="margin:0 0 14px;">You're on the free Monday note. The daily desk is the full thing: a fresh research note every weekday morning, researched answers to your replies (like this one), and follow-ups when a covered name moves or reports.</p>
    <p style="margin:0 0 14px;"><a href="${upgradeUrl}" style="color:#1155cc;">Join the daily desk — $99/mo</a>. MOI Global member? Use your member email and the partner rate applies automatically.</p>
    <p style="margin:14px 0 0;">— Your analyst</p>
  `;
  return emailLayout(body, { unsubscribeToken: args.unsubscribeToken });
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
