import { config } from "../config";
import { BRAND, BRAND_NAME, TAGLINE } from "../brand";

export interface LayoutArgs {
  unsubscribeToken: string;
  /** Shown under the masthead, e.g. "PREPARED FOR MARK@EXAMPLE.COM" */
  preparedFor?: string;
  /** Date line in the masthead, e.g. "3 July 2026" */
  dateLine?: string;
}

/**
 * Shared HTML shell for all outbound email — the Morningpick research-note
 * look: ink masthead with rising-sun mark, paper body, gold accents. The
 * disclaimer and unsubscribe footer are hard-coded — never model-generated.
 */
export function emailLayout(bodyHtml: string, args: LayoutArgs): string {
  const cfg = config();
  const unsubUrl = `${cfg.APP_URL}/unsubscribe/${args.unsubscribeToken}`;

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:${BRAND.paper};">
  <div style="max-width:660px;margin:0 auto;padding:0 0 40px;">

    <!-- Masthead -->
    <div style="background-color:${BRAND.ink};border-bottom:3px solid ${BRAND.gold};padding:22px 28px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="vertical-align:middle;">
            <div style="width:22px;height:11px;background-color:${BRAND.gold};border-radius:11px 11px 0 0;margin-bottom:6px;"></div>
            <span style="font-family:${BRAND.sans};font-size:17px;letter-spacing:4px;color:${BRAND.paper};font-weight:400;">MORNING<span style="font-weight:700;">PICK</span></span>
          </td>
          <td style="vertical-align:bottom;text-align:right;">
            ${
              args.dateLine
                ? `<span style="font-family:${BRAND.sans};font-size:11px;letter-spacing:2px;color:#8fa0b0;">${args.dateLine.toUpperCase()}</span>`
                : `<span style="font-family:${BRAND.sans};font-size:11px;letter-spacing:2px;color:#8fa0b0;">${TAGLINE.toUpperCase()}</span>`
            }
          </td>
        </tr>
      </table>
    </div>

    ${
      args.preparedFor
        ? `<div style="padding:12px 28px 0;">
            <span style="font-family:${BRAND.sans};font-size:10px;letter-spacing:2px;color:${BRAND.slate};">PRIVATE RESEARCH NOTE · PREPARED FOR ${escapeHtml(args.preparedFor.toUpperCase())}</span>
          </div>`
        : ""
    }

    <!-- Body -->
    <div style="padding:20px 28px 0;font-family:${BRAND.serif};color:${BRAND.ink};font-size:16px;line-height:1.68;">
      ${bodyHtml}
    </div>

    <!-- Footer -->
    <div style="padding:28px 28px 0;">
      <hr style="border:none;border-top:1px solid ${BRAND.rule};margin:0 0 16px;" />
      <div style="font-family:${BRAND.sans};font-size:11px;color:${BRAND.slate};line-height:1.7;">
        <p style="margin:0 0 8px;">
          This email is for informational and entertainment purposes only and is
          <strong>not investment advice</strong>, a recommendation, or an offer to buy or sell any
          security. The content is generated with the assistance of AI and may contain errors.
          Always do your own research and consider consulting a licensed financial adviser.
        </p>
        <p style="margin:0 0 8px;">
          Reply directly to this email to tell us how to improve your memos — your feedback shapes
          what you get tomorrow.
        </p>
        <p style="margin:0;">
          ${escapeHtml(cfg.POSTAL_ADDRESS)} ·
          <a href="${unsubUrl}" style="color:${BRAND.slate};">Unsubscribe</a>
        </p>
      </div>
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
