import { emailLayout } from "./layout";
import { BRAND } from "../brand";
import { config } from "../config";

const MONO = "Menlo, Consolas, 'Courier New', monospace";

/** The magic sign-in link — one button, nothing else to think about. */
export function renderSigninEmail(args: {
  unsubscribeToken: string;
  portalToken: string;
}): string {
  const deskUrl = `${config().APP_URL}/me/${args.portalToken}`;
  const body = `
    <p style="margin:0 0 15px;">Here's your desk — every note your analyst has written for you, in one place. Opening it on this device keeps you signed in.</p>
    <div style="margin:24px 0 18px;">
      <a href="${deskUrl}"
         style="display:inline-block;background:${BRAND.ink};color:${BRAND.paper};font-family:${MONO};font-size:11px;letter-spacing:2px;padding:12px 24px;text-decoration:none;border-bottom:2px solid ${BRAND.gold};">
        OPEN YOUR DESK →
      </a>
    </div>
    <p style="margin:0;font-family:${BRAND.sans};font-size:12px;color:${BRAND.slate};">This link is private to you — anyone with it can read your notes. If you didn't request it, you can simply ignore this email.</p>
  `;
  return emailLayout(body, {
    unsubscribeToken: args.unsubscribeToken,
    portalToken: args.portalToken,
    dateLine: "SIGN IN",
  });
}
