-- Morningpick initial schema
create schema if not exists extensions;
create extension if not exists citext with schema extensions;

create type subscriber_status as enum ('pending', 'active', 'unsubscribed', 'bounced');
create type delivery_status as enum ('pending', 'processing', 'sent', 'failed', 'skipped');

create table subscribers (
  id                uuid primary key default gen_random_uuid(),
  email             extensions.citext not null unique,
  status            subscriber_status not null default 'pending',
  timezone          text not null default 'Europe/Zurich',
  send_hour_local   smallint not null default 7,
  confirm_token     uuid not null default gen_random_uuid(),
  unsubscribe_token uuid not null default gen_random_uuid(),
  confirmed_at      timestamptz,
  created_at        timestamptz not null default now()
);
create index subscribers_status on subscribers (status);

create table preference_profiles (
  subscriber_id uuid primary key references subscribers(id) on delete cascade,
  structured    jsonb not null default '{}',
  philosophy    text not null default '',
  version       int not null default 0,
  updated_at    timestamptz not null default now()
);

create table memos (
  id                uuid primary key default gen_random_uuid(),
  subscriber_id     uuid not null references subscribers(id) on delete cascade,
  delivery_date     date not null,
  ticker            text not null,
  company_name      text,
  title             text,
  content_md        text not null,
  content_html      text not null,
  model             text not null,
  resend_message_id text,
  reply_address     text,
  sent_at           timestamptz,
  created_at        timestamptz not null default now(),
  unique (subscriber_id, delivery_date)
);
create index memos_sub_ticker on memos (subscriber_id, ticker);
create index memos_resend_message_id on memos (resend_message_id);

create table deliveries (
  id            uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references subscribers(id) on delete cascade,
  delivery_date date not null,
  status        delivery_status not null default 'pending',
  attempts      int not null default 0,
  last_error    text,
  claimed_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (subscriber_id, delivery_date)
);
create index deliveries_pending on deliveries (status, delivery_date);

create table feedback (
  id               uuid primary key default gen_random_uuid(),
  subscriber_id    uuid not null references subscribers(id) on delete cascade,
  memo_id          uuid references memos(id) on delete set null,
  inbound_email_id text unique,
  raw_subject      text,
  cleaned_body     text,
  interpretation   jsonb,
  applied          boolean not null default false,
  ack_sent         boolean not null default false,
  created_at       timestamptz not null default now()
);

create table daily_universe (
  universe_date date not null,
  ticker        text not null,
  snapshot      jsonb not null,
  source        text not null,
  primary key (universe_date, ticker)
);

create table fmp_cache (
  cache_key  text primary key,
  payload    jsonb not null,
  fetched_at timestamptz not null default now()
);

create table fmp_budget (
  budget_date date primary key,
  used        int not null default 0
);

create table events (
  id            bigint generated always as identity primary key,
  subscriber_id uuid,
  type          text not null,
  payload       jsonb,
  ip_hash       text,
  created_at    timestamptz not null default now()
);
create index events_type_time on events (type, created_at);
create index events_type_ip on events (type, ip_hash, created_at);

-- Atomic queue claim: only active subscribers, with stale-claim reclaim.
create or replace function claim_deliveries(batch int)
returns setof deliveries
language sql
security definer
set search_path = public
as $$
  update deliveries d
  set status = 'processing', claimed_at = now(), attempts = d.attempts + 1
  where d.id in (
    select del.id
    from deliveries del
    join subscribers s on s.id = del.subscriber_id
    where s.status = 'active'
      and (
        del.status = 'pending'
        or (del.status = 'processing' and del.claimed_at < now() - interval '10 minutes')
      )
      and del.attempts < 3
    order by del.delivery_date
    limit batch
    for update of del skip locked
  )
  returning d.*;
$$;

-- Atomic FMP budget increment; returns new total for the day.
create or replace function increment_fmp_budget(n int)
returns int
language sql
security definer
set search_path = public
as $$
  insert into fmp_budget (budget_date, used)
  values (current_date, n)
  on conflict (budget_date) do update set used = fmp_budget.used + excluded.used
  returning used;
$$;

-- Only the service role may call the queue/budget functions (they are exposed
-- via PostgREST RPC otherwise).
revoke execute on function claim_deliveries(int) from public, anon, authenticated;
revoke execute on function increment_fmp_budget(int) from public, anon, authenticated;
grant execute on function claim_deliveries(int) to service_role;
grant execute on function increment_fmp_budget(int) to service_role;

-- Deny-all RLS: the app accesses these tables exclusively through the
-- service-role key in server routes. No policies = no anon/authenticated access.
alter table subscribers enable row level security;
alter table preference_profiles enable row level security;
alter table memos enable row level security;
alter table deliveries enable row level security;
alter table feedback enable row level security;
alter table daily_universe enable row level security;
alter table fmp_cache enable row level security;
alter table fmp_budget enable row level security;
alter table events enable row level security;
