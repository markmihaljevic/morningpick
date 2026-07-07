import { config } from "../config";

// A normal person's email font stack — whatever the client's "plain email"
// looks like. No brand serif, no letterhead, no card.
const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const TEXT = "#202124"; // Gmail's body text color
const MUTED = "#5f6368";
const LINK = "#1155cc"; // Gmail link blue

export interface LayoutArgs {
  unsubscribeToken: string;
  /** Set for paying subscribers: renders the "manage billing" footer link. */
  billingUrl?: string;
  /** Set for free-tier recipients: renders the upgrade line above the footer. */
  upgradeUrl?: string;
  /** "What I know about you" transparency link in the fine print. */
  profileUrl?: string;
  /** Unused in the plain shell (kept for callers); the client shows the real date/recipient. */
  preparedFor?: string;
  dateLine?: string;
}

/**
 * The shell for every outbound email — deliberately unbranded. This should
 * look like a normal email a person typed in Gmail: plain sans-serif on
 * white, no masthead, no card, no design. The writing is the whole thing.
 * Only the small legal footer (disclaimer + one-click unsubscribe) is fixed.
 */
export function emailLayout(bodyHtml: string, args: LayoutArgs): string {
  const cfg = config();
  const unsubUrl = `${cfg.APP_URL}/unsubscribe/${args.unsubscribeToken}`;
  const link = (href: string, text: string) =>
    `<a href="${href}" style="color:${MUTED};text-decoration:underline;">${text}</a>`;

  const footerLinks = [
    args.profileUrl ? link(args.profileUrl, "what I know about you") : "",
    args.billingUrl ? link(args.billingUrl, "billing") : "",
    link(unsubUrl, "unsubscribe"),
  ].filter(Boolean);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#ffffff;">
<div style="max-width:600px;margin:0;padding:16px 18px 28px;font-family:${SANS};font-size:15px;line-height:1.5;color:${TEXT};">

  ${bodyHtml}

  ${
    args.upgradeUrl
      ? `<p style="margin:20px 0 0;color:${MUTED};font-size:14px;">P.S. You're on the free Monday note — the full desk writes every morning and answers your questions in thread. <a href="${args.upgradeUrl}" style="color:${LINK};">Get the daily letter</a> whenever you like.</p>`
      : ""
  }

  <div style="margin-top:26px;padding-top:12px;border-top:1px solid #eeeeee;color:${MUTED};font-size:12px;line-height:1.6;">
    Not investment advice — AI-generated, for information only, and may contain errors. Do your own research.<br/>
    ${footerLinks.join(" · ")}
  </div>

</div>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
