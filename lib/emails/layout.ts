import { config } from "../config";
import { BRAND, TAGLINE } from "../brand";

const CANVAS = "#FFFFFF"; // clean white canvas — the note carries the brand
const MONO = "Menlo, Consolas, 'Courier New', monospace";

export interface LayoutArgs {
  unsubscribeToken: string;
  /** Subscriber's desk token — renders the "your research desk" footer link. */
  portalToken?: string;
  /** Set for free-tier recipients: renders The Desk upgrade band above the footer. */
  upgradeUrl?: string;
  /** Shown under the masthead, e.g. "PREPARED FOR MARK@EXAMPLE.COM" */
  preparedFor?: string;
  /** Date line in the masthead, e.g. "3 July 2026" */
  dateLine?: string;
}

/**
 * Shared HTML shell for all outbound email — the paper research note floating
 * on the dark ink canvas, mirroring the website's hero artifact. Disclaimer
 * and unsubscribe footer are hard-coded — never model-generated.
 */
export function emailLayout(bodyHtml: string, args: LayoutArgs): string {
  const cfg = config();
  const unsubUrl = `${cfg.APP_URL}/unsubscribe/${args.unsubscribeToken}`;

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:${CANVAS};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${CANVAS};border-collapse:collapse;">
<tr><td align="center" style="padding:28px 12px 40px;">

  <!-- The note -->
  <table role="presentation" width="700" cellpadding="0" cellspacing="0" style="max-width:700px;width:100%;border-collapse:collapse;border:1px solid ${BRAND.rule};">

    <!-- Masthead -->
    <tr><td style="background-color:${BRAND.ink};border-bottom:3px solid ${BRAND.gold};padding:20px 30px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="vertical-align:bottom;">
            <div style="width:20px;height:10px;background-color:${BRAND.gold};border-radius:10px 10px 0 0;margin-bottom:7px;"></div>
            <span style="font-family:${BRAND.sans};font-size:16px;letter-spacing:4px;color:${BRAND.paper};font-weight:400;">MORNING<span style="font-weight:700;">PICK</span></span>
          </td>
          <td style="vertical-align:bottom;text-align:right;">
            <span style="font-family:${MONO};font-size:10px;letter-spacing:2px;color:#8FA0B0;">${(args.dateLine ?? TAGLINE).toUpperCase()}</span>
          </td>
        </tr>
      </table>
    </td></tr>

    <!-- Paper body -->
    <tr><td style="background-color:${BRAND.paper};padding:0;">
      ${
        args.preparedFor
          ? `<div style="padding:16px 30px 0;">
              <span style="font-family:${MONO};font-size:9px;letter-spacing:2px;color:${BRAND.slate};">PRIVATE RESEARCH NOTE · PREPARED FOR ${escapeHtml(args.preparedFor.toUpperCase())}</span>
            </div>`
          : ""
      }
      <div style="padding:18px 30px 26px;font-family:${BRAND.serif};color:${BRAND.ink};font-size:16px;line-height:1.68;">
        ${bodyHtml}
      </div>
    </td></tr>

    ${
      args.upgradeUrl
        ? `<!-- Upgrade band — free tier only -->
    <tr><td style="background-color:${BRAND.paper};border-top:1px solid ${BRAND.rule};padding:16px 30px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle;">
          <span style="font-family:${MONO};font-size:10px;letter-spacing:1.5px;color:${BRAND.slate};">FREE MONDAY NOTE · <span style="color:${BRAND.ink};font-weight:700;">THE DESK IS DAILY</span> + Q&amp;A + FOLLOW-UPS</span>
        </td>
        <td style="vertical-align:middle;text-align:right;white-space:nowrap;">
          <a href="${args.upgradeUrl}" style="font-family:${MONO};font-size:10px;letter-spacing:1.5px;color:${BRAND.gold};font-weight:700;text-decoration:none;border-bottom:2px solid ${BRAND.gold};padding-bottom:2px;">UPGRADE&nbsp;→</a>
        </td>
      </tr></table>
    </td></tr>
    `
        : ""
    }<!-- Ink footer — bookends the masthead -->
    <tr><td style="background-color:${BRAND.ink};border-top:3px solid ${BRAND.gold};padding:18px 30px;">
      <p style="margin:0 0 10px;font-family:${MONO};font-size:10px;letter-spacing:1px;color:#8FA0B0;line-height:1.9;">
        <span style="color:${BRAND.gold};font-weight:700;">YOUR ANALYST LISTENS.</span>
        Reply to this email in plain language —<br/>
        <span style="color:${BRAND.paper};">"more like this" · "go deeper on the risks" · "smaller companies" · "never this sector again"</span>
      </p>
      <p style="margin:0;font-family:${BRAND.sans};font-size:10px;color:#5C7183;line-height:1.7;">
        Not investment advice. This note is AI-generated, for informational and entertainment purposes only,
        and may contain errors. Always do your own research and consider consulting a licensed financial adviser.<br/>
        ${escapeHtml(cfg.POSTAL_ADDRESS)} · <a href="https://morningpick.ai" style="color:#8FA0B0;">morningpick.ai</a>${
          args.portalToken
            ? ` · <a href="${cfg.APP_URL}/me/${args.portalToken}" style="color:#8FA0B0;">Your research desk</a>`
            : ""
        } · <a href="${unsubUrl}" style="color:#8FA0B0;">Unsubscribe</a>
      </p>
    </td></tr>

  </table>

</td></tr>
</table>
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
