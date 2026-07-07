import { emailLayout, escapeHtml } from "./layout";
import { config } from "../config";

/**
 * The instant confirmation an analyst would actually send — within seconds
 * of any genuine reply, before interpretation even runs. Warm, brief, and
 * honest about what happens next.
 */
export function renderReplyReceivedEmail(args: {
  unsubscribeToken: string;
  replySnippet: string;
}): string {
  const hourUTC = new Date().getUTCHours();
  const greeting = hourUTC < 10 ? "Good morning" : hourUTC < 16 ? "Good afternoon" : "Good evening";
  const body = `
    <p style="margin:0 0 14px;">${greeting},</p>
    <p style="margin:0 0 14px;">Got your note — thank you.</p>
    <p style="margin:0 0 14px;color:#5f6368;">&gt; ${escapeHtml(args.replySnippet)}</p>
    <p style="margin:0 0 14px;">I'm on it. Anything about your preferences goes straight into how I pick for you — you'll see it from the next note. If there's a question in there, the researched answer follows in this thread; give me a little while if it needs real digging.</p>
    <p style="margin:0;">— ${config().ANALYST_NAME}</p>
  `;
  return emailLayout(body, { unsubscribeToken: args.unsubscribeToken });
}
