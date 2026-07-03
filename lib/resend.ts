import { Resend } from "resend";
import { config } from "./config";
import { htmlToText } from "./emails/text-part";

let client: Resend | null = null;

export function resend(): Resend {
  if (!client) {
    client = new Resend(config().RESEND_API_KEY);
  }
  return client;
}

export function fromAddress(): string {
  const cfg = config();
  // Test mode before a domain is verified: Resend lets you send from
  // onboarding@resend.dev to your own account email only.
  if (cfg.EMAIL_DOMAIN === "resend.dev") {
    return `${cfg.EMAIL_FROM_NAME} <onboarding@resend.dev>`;
  }
  return `${cfg.EMAIL_FROM_NAME} <memo@${cfg.EMAIL_DOMAIN}>`;
}

export function replyAddress(localPart: string): string {
  return `reply+${localPart}@${config().REPLY_DOMAIN}`;
}

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  unsubscribeToken?: string;
}

export async function sendEmail(args: SendEmailArgs): Promise<string> {
  const cfg = config();
  const headers: Record<string, string> = {};
  if (args.unsubscribeToken) {
    const unsubUrl = `${cfg.APP_URL}/api/unsubscribe?token=${args.unsubscribeToken}`;
    headers["List-Unsubscribe"] = `<${unsubUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  const { data, error } = await resend().emails.send({
    from: fromAddress(),
    to: args.to,
    subject: args.subject,
    html: args.html,
    // Plain-text alternative part — HTML-only mail is a spam-filter signal.
    text: htmlToText(args.html),
    replyTo: args.replyTo,
    headers,
  });
  if (error) {
    throw new Error(`Resend send failed: ${error.name}: ${error.message}`);
  }
  return data!.id;
}

export interface ReceivedEmail {
  id: string;
  from: string;
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
}

// The webhook payload is metadata-only; the body must be fetched separately.
// Raw fetch keeps us independent of SDK version support for this endpoint.
export async function getReceivedEmail(emailId: string): Promise<ReceivedEmail> {
  const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${config().RESEND_API_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch received email ${emailId}: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  // Headers may arrive as an array of {name, value} or an object; normalize.
  let headers: Record<string, string> = {};
  if (Array.isArray(body.headers)) {
    for (const h of body.headers) {
      if (h?.name) headers[h.name.toLowerCase()] = String(h.value ?? "");
    }
  } else if (body.headers && typeof body.headers === "object") {
    for (const [k, v] of Object.entries(body.headers)) {
      headers[k.toLowerCase()] = String(v ?? "");
    }
  }
  return {
    id: body.id ?? emailId,
    from: body.from ?? "",
    to: Array.isArray(body.to) ? body.to : [body.to].filter(Boolean),
    subject: body.subject ?? null,
    text: body.text ?? null,
    html: body.html ?? null,
    headers,
  };
}
