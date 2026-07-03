import { emailLayout } from "./layout";

export function renderWelcomeEmail(unsubscribeToken: string): string {
  const body = `
    <h1 style="font-size:22px;margin:0 0 16px;">You're in. First memo arrives tomorrow morning.</h1>
    <p style="margin:0 0 14px;">Every morning you'll get one AI-generated stock idea — thesis,
    valuation, risks — grounded in current market data.</p>
    <p style="margin:0 0 14px;"><strong>Want it personalized from day one? Just reply to this
    email</strong> and describe your investment style in a few sentences:</p>
    <ul style="margin:0 0 14px;padding-left:22px;">
      <li style="margin:0 0 6px;">Which markets and regions interest you (US, Europe, Asia…)?</li>
      <li style="margin:0 0 6px;">Company size — large caps, small caps, or a mix?</li>
      <li style="margin:0 0 6px;">Style — value, growth, quality, contrarian, dividends?</li>
      <li style="margin:0 0 6px;">Sectors you love or want to avoid?</li>
    </ul>
    <p style="margin:0 0 14px;">You can also reply to any daily memo — "more like this",
    "too US-heavy", "never pitch airlines again" — and your future memos will adapt.</p>`;
  return emailLayout(body, { unsubscribeToken });
}
