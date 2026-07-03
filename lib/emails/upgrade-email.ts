import { emailLayout } from "./layout";
import { BRAND } from "../brand";
import { config } from "../config";

const MONO = "Menlo, Consolas, 'Courier New', monospace";

/**
 * Sent when a free subscriber asks the research desk a question — the desk
 * answers questions on the daily plan. Warm, short, one clear action.
 */
export function renderUpgradeNudgeEmail(args: {
  unsubscribeToken: string;
  portalToken: string;
  firstQuestion: string;
}): string {
  const cfg = config();
  const upgradeUrl = `${cfg.APP_URL}/api/upgrade/${args.portalToken}`;
  const body = `
    <p style="margin:0 0 15px;">Good question — and exactly the kind I dig into for subscribers on the daily desk:</p>
    <div style="border-left:3px solid ${BRAND.gold};padding:2px 0 2px 14px;margin:0 0 18px;">
      <span style="font-family:${BRAND.serif};font-size:16px;font-style:italic;color:${BRAND.ink};">"${escape(
        args.firstQuestion,
      )}"</span>
    </div>
    <p style="margin:0 0 15px;">You're on the free Monday note. <strong style="color:${BRAND.ink};">The Desk</strong> is the full product: a fresh research note every weekday morning, researched answers to your replies (like this one), and follow-ups when a covered name moves or reports.</p>
    <div style="margin:24px 0 8px;">
      <a href="${upgradeUrl}"
         style="display:inline-block;background:${BRAND.ink};color:${BRAND.paper};font-family:${MONO};font-size:11px;letter-spacing:2px;padding:12px 24px;text-decoration:none;border-bottom:2px solid ${BRAND.gold};">
        JOIN THE DESK — $99/MO
      </a>
    </div>
    <p style="margin:0;font-family:${BRAND.sans};font-size:12px;color:${BRAND.slate};">MOI Global member? Enter your member code at checkout for the partner rate.</p>
  `;
  return emailLayout(body, {
    unsubscribeToken: args.unsubscribeToken,
    dateLine: "THE DESK",
  });
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
