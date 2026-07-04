import { config } from "../config";
import { BRAND } from "../brand";

const MONO = "Menlo, Consolas, 'Courier New', monospace";

export interface LayoutArgs {
  unsubscribeToken: string;
  /** Set for paying subscribers: renders the "Manage billing" footer link. */
  billingUrl?: string;
  /** Set for free-tier recipients: renders the upgrade P.S. above the footer. */
  upgradeUrl?: string;
  /** Shown in the letterhead line, e.g. "MARK@EXAMPLE.COM" */
  preparedFor?: string;
  /** Date in the letterhead line, e.g. "5 July 2026" */
  dateLine?: string;
}

/**
 * The letter shell: white page, one narrow column of serif text, a whisper
 * of a letterhead, fine print at the bottom. A note from an analyst, not a
 * page from a website — the writing carries the brand. Disclaimer and
 * unsubscribe footer are hard-coded — never model-generated.
 */
export function emailLayout(bodyHtml: string, args: LayoutArgs): string {
  const cfg = config();
  const unsubUrl = `${cfg.APP_URL}/unsubscribe/${args.unsubscribeToken}`;

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#FFFFFF;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
<tr><td align="center" style="padding:32px 16px 48px;">

  <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;border-collapse:collapse;">

    <!-- Letterhead: one quiet line -->
    <tr><td style="padding:0 0 10px;border-bottom:1px solid ${BRAND.rule};">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="vertical-align:bottom;">
            <span style="font-family:${MONO};font-size:11px;letter-spacing:3px;color:${BRAND.ink};">MORNING<span style="font-weight:700;">PICK</span></span>
          </td>
          <td style="vertical-align:bottom;text-align:right;">
            <span style="font-family:${MONO};font-size:10px;letter-spacing:1.5px;color:${BRAND.slate};">${(args.dateLine ?? "").toUpperCase()}</span>
          </td>
        </tr>
      </table>
      ${
        args.preparedFor
          ? `<div style="padding-top:5px;"><span style="font-family:${MONO};font-size:9px;letter-spacing:1.5px;color:${BRAND.slate};">PRIVATE NOTE FOR ${escapeHtml(args.preparedFor.toUpperCase())}</span></div>`
          : ""
      }
    </td></tr>

    <!-- The letter -->
    <tr><td style="padding:24px 0 8px;font-family:${BRAND.serif};color:${BRAND.ink};font-size:16px;line-height:1.7;">
      ${bodyHtml}
    </td></tr>

    ${
      args.upgradeUrl
        ? `<tr><td style="padding:18px 0 0;font-family:${BRAND.serif};font-size:14px;line-height:1.7;color:${BRAND.slate};">
        <em>P.S. — You're on the free Monday note. The full desk writes every morning and answers your questions in thread; <a href="${args.upgradeUrl}" style="color:${BRAND.ink};">the daily letter is here</a> if you want it.</em>
      </td></tr>`
        : ""
    }

    <!-- Fine print -->
    <tr><td style="padding:28px 0 0;">
      <div style="border-top:1px solid ${BRAND.rule};padding-top:14px;">
        <p style="margin:0 0 8px;font-family:${BRAND.sans};font-size:12px;line-height:1.7;color:${BRAND.slate};">
          Reply to this email in plain language — preferences, questions, pushback. I read everything.
        </p>
        <p style="margin:0;font-family:${BRAND.sans};font-size:10.5px;line-height:1.7;color:#9AA3AB;">
          Not investment advice. This note is AI-generated, for informational and entertainment purposes only,
          and may contain errors. Always do your own research and consider consulting a licensed financial adviser.<br/>
          ${escapeHtml(cfg.POSTAL_ADDRESS)} · <a href="https://morningpick.ai" style="color:#9AA3AB;">morningpick.ai</a>${
            args.billingUrl
              ? ` · <a href="${args.billingUrl}" style="color:#9AA3AB;">Manage billing</a>`
              : ""
          } · <a href="${unsubUrl}" style="color:#9AA3AB;">Unsubscribe</a>
        </p>
      </div>
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
