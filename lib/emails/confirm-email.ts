import { config } from "../config";
import { emailLayout } from "./layout";

export function renderConfirmEmail(confirmToken: string, unsubscribeToken: string): string {
  const url = `${config().APP_URL}/confirm/${confirmToken}`;
  const body = `
    <h1 style="font-size:22px;margin:0 0 16px;">Confirm your subscription</h1>
    <p style="margin:0 0 14px;">You (or someone using your email address) signed up for a daily,
    personalized investment idea memo. Click below to confirm:</p>
    <p style="margin:24px 0;">
      <a href="${url}" style="background:#10202F;color:#FBFAF6;padding:12px 24px;text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-size:14px;letter-spacing:2px;border-bottom:2px solid #B08C3D;">CONFIRM SUBSCRIPTION</a>
    </p>
    <p style="margin:0 0 14px;color:#5C6670;font-size:14px;">If you didn't sign up, ignore this
    email and you won't hear from us again.</p>`;
  return emailLayout(body, { unsubscribeToken });
}
