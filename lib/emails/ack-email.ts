import { emailLayout } from "./layout";
import { escapeHtml } from "./layout";

export function renderAckEmail(ackSummary: string, unsubscribeToken: string): string {
  const body = `
    <p style="margin:0 0 14px;">${escapeHtml(ackSummary)}</p>
    <p style="margin:0 0 14px;color:#5C6670;">Your future memos will reflect this. Reply anytime
    to refine further.</p>`;
  return emailLayout(body, { unsubscribeToken });
}
