-- Performance tracking: price at pitch time, nightly mark, and a per-subscriber
-- portal token for the no-login dashboard.
alter table memos
  add column pitch_price numeric,
  add column pitch_currency text,
  add column last_price numeric,
  add column last_price_at timestamptz,
  add column return_pct numeric;

alter table subscribers
  add column portal_token uuid not null default gen_random_uuid();
create index subscribers_portal_token on subscribers (portal_token);
