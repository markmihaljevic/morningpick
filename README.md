# ☕ Morningpick

**One AI-generated, personalized investment idea in your inbox every morning — and it learns from your replies.**

Each subscriber gets a daily one-stock memo (thesis, valuation, risks, catalysts) written by Claude, grounded in live market data from Financial Modeling Prep and recent news via web search. Subscribers **reply directly to the email** ("more European small caps", "less tech", "loved this one") and the system updates a persistent per-subscriber preference profile that shapes every future memo.

Self-hostable by anyone with ~30 minutes and a domain.

> ⚠️ **Not investment advice.** Memos are AI-generated, for informational and entertainment purposes only, and may contain errors. Every email carries this disclaimer.

## How it works

```
                     ┌────────────────────────────────────────────┐
  Vercel Cron ──────▶│ /api/cron/dispatch                         │
  (every morning)    │  build daily candidate universe (FMP)      │
                     │  enqueue one delivery per subscriber       │
                     └───────────────┬────────────────────────────┘
                                     ▼
                     ┌────────────────────────────────────────────┐
                     │ /api/internal/process  (self-reinvoking)   │
                     │  1. pick ticker for subscriber (Claude)    │
                     │  2. fetch fundamentals (FMP, cached/day)   │
                     │  3. write memo (Claude + web search)       │
                     │  4. send via Resend                        │
                     │     reply-to: reply+<memoId>@reply.domain  │
                     └───────────────┬────────────────────────────┘
                                     ▼
   subscriber replies ──▶ Resend inbound ──▶ /api/webhooks/resend
                                     │  verify signature, drop auto-replies
                                     │  interpret feedback (Claude, JSON)
                                     │  update preference profile
                                     ▼
                          tomorrow's memo is smarter
```

**Stack:** Next.js (App Router) · Supabase Postgres · Resend (outbound + inbound) · Claude API · Financial Modeling Prep · Vercel (hosting + cron)

## What you need

| Service | Purpose | Cost |
|---|---|---|
| A domain | email sending + receiving | ~$10/yr |
| [Anthropic API](https://platform.claude.com) | memo generation & feedback interpretation | ~$0.05–0.15 per memo |
| [Resend](https://resend.com) | outbound email + inbound replies | free tier: 3,000 emails/mo |
| [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs) | market data | free tier: 250 req/day (≈40 distinct tickers/day, shared across subscribers via cache) |
| [Supabase](https://supabase.com) | Postgres database | free tier |
| [Vercel](https://vercel.com) | hosting + daily cron | free Hobby plan works |

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USER/morningpick && cd morningpick
npm install
cp .env.example .env.local
```

### 2. Supabase

Create a project at [supabase.com](https://supabase.com), then run the migration:

- Dashboard → SQL Editor → paste `supabase/migrations/0001_init.sql` → Run
  (or `supabase db push` with the CLI)

Put the project URL and **service_role** key (Project Settings → API keys) into `.env.local`.

### 3. Domain + Resend

1. Buy a domain (e.g. `morningpick.example`).
2. In Resend → **Domains**, add a **sending domain** — use a subdomain like `mail.yourdomain.com` — and add the SPF/DKIM DNS records it gives you.
3. In Resend → **Receiving**, add a **receiving domain** — a different subdomain like `reply.yourdomain.com` — and add its MX record.
4. Create an API key → `RESEND_API_KEY`.
5. Webhook setup happens after your first deploy (step 5).

Set `EMAIL_DOMAIN=mail.yourdomain.com` and `REPLY_DOMAIN=reply.yourdomain.com`.

### 4. Test locally (no domain needed)

```bash
# Iterate on memo quality without sending anything:
npx tsx scripts/generate-memo.ts          # auto-picks a ticker for a test profile
npx tsx scripts/generate-memo.ts AAPL     # or force one

# Full local pipeline (needs Resend key + verified domain to actually send):
npx tsx scripts/seed-dev.ts you@example.com
npm run dev
curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/dispatch
```

### 5. Deploy to Vercel

```bash
npx vercel
```

- Add every variable from `.env.example` in Vercel → Project → Settings → Environment Variables (set `APP_URL` to your deployment URL).
- `vercel.json` schedules the cron at **04:30 UTC weekdays** — adjust to taste. Hobby plan allows daily crons; the exact minute may drift within the hour.
- After deploying, in Resend → **Webhooks**, add `https://YOUR_APP/api/webhooks/resend` subscribed to `email.received`, `email.bounced`, `email.complained`. Copy the signing secret into `RESEND_WEBHOOK_SECRET` and redeploy.

### 6. Try it end-to-end

1. Sign up on your landing page, confirm via email.
2. Reply to the welcome email describing your investment style — you should get a short "Got it" acknowledgment and see your profile in the `preference_profiles` table.
3. Trigger a morning run manually: `curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_APP/api/cron/dispatch`
4. Reply to the memo with feedback; tomorrow's memo adapts.

## Design notes

- **One memo per subscriber per day** is enforced with a unique constraint — retries can't double-send.
- **The delivery queue** (`deliveries` + `claim_deliveries()`) uses `FOR UPDATE SKIP LOCKED` with stale-claim reclaim, and the worker chains fresh invocations via `after()` to stay inside Vercel's function time limits (~3 memos per invocation, hop-capped).
- **FMP budget**: all FMP responses are cached per day in Postgres and shared across subscribers; a hard daily counter (`FMP_DAILY_BUDGET`) makes the pipeline fail loudly rather than send memos with stale numbers.
- **Grounding**: the memo prompt forbids inventing figures — numbers must come from the FMP JSON or a cited web-search result.
- **Reply safety**: header-based auto-reply/OOO detection runs before any LLM call; the feedback interpreter is tool-less with schema-constrained output and treats email bodies as untrusted data; acknowledgments are throttled (1 per 6h) to break mail loops; senders must match the memo owner.
- **Deliverability**: double opt-in only, `List-Unsubscribe` One-Click headers, bounce/complaint webhooks auto-suppress, restrained HTML. Warm the domain slowly.
- **Timezones (v1)**: everyone gets the memo at the same UTC time (Hobby-plan compatible). Per-user delivery hours are schema-ready (`timezone`, `send_hour_local`) — switch `DELIVERY_MODE=hourly` and change the cron to `0 * * * *` on Vercel Pro.

## Costs at scale

Rough per-subscriber-per-day: 2 Claude calls (~$0.05–0.15 with Sonnet) + shared FMP calls + 1 email. 50 subscribers ≈ $3–8/day in API costs. Set `MEMO_MODEL=claude-haiku-4-5` for cheaper (weaker) memos.

## License

MIT — see [LICENSE](LICENSE).
