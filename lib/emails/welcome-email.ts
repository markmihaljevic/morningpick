import { emailLayout } from "./layout";

export function renderWelcomeEmail(unsubscribeToken: string): string {
  const body = `
    <h1 style="font-size:22px;margin:0 0 16px;">You're in — your first note is being written right now.</h1>
    <p style="margin:0 0 14px;">Your analyst is screening the world's exchanges for you as you read
    this. The finished research note — thesis, valuation, risks, every figure fact-checked — lands
    in this inbox <strong>within the hour</strong>. After that: a fresh note every Monday morning,
    free (The Desk gets one every weekday).</p>
    <p style="margin:0 0 14px;"><strong>While it's being written, reply to this email</strong> and
    describe how you invest, in plain language — every note from the next one onward adapts to it:</p>
    <ul style="margin:0 0 14px;padding-left:22px;">
      <li style="margin:0 0 6px;">Which markets and regions interest you (US, Europe, Asia…)?</li>
      <li style="margin:0 0 6px;">Company size — large caps, small caps, or a mix?</li>
      <li style="margin:0 0 6px;">Style — value, growth, quality, contrarian, dividends?</li>
      <li style="margin:0 0 6px;">Sectors you love or want to avoid?</li>
    </ul>
    <p style="margin:0 0 14px;">You can also reply to any note — "more like this",
    "too US-heavy", "never pitch airlines again" — and your analyst remembers.</p>`;
  return emailLayout(body, { unsubscribeToken });
}
