import { emailLayout } from "./layout";
import { BRAND } from "../brand";

const MONO = "Menlo, Consolas, 'Courier New', monospace";

/** The desk acknowledges a question that needs real research time. */
export function renderOnItEmail(args: {
  unsubscribeToken: string;
  firstQuestion: string;
}): string {
  const body = `
    <p style="margin:0 0 8px;font-family:${MONO};font-size:10px;letter-spacing:2px;color:${BRAND.gold};font-weight:700;">YOUR ANALYST IS ON IT</p>
    <div style="border-left:3px solid ${BRAND.gold};padding:2px 0 2px 14px;margin:0 0 16px;">
      <span style="font-family:${BRAND.serif};font-size:16px;font-style:italic;color:${BRAND.ink};">"${escape(args.firstQuestion)}"</span>
    </div>
    <p style="margin:0;">Good question — it needs real digging (filings, transcripts, the tape), not a quick reply. The researched answer lands in this thread shortly.</p>
  `;
  return emailLayout(body, { unsubscribeToken: args.unsubscribeToken });
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
