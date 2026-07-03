-- The idea pipeline: names worth tracking that didn't make today's note.
-- Selection's near-misses and pre-flight rejects land here and get another
-- shot on later mornings — picked when their catalyst arrives, not
-- reconstructed from a blank slate at 04:30.
create table if not exists public.watchlist (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references public.subscribers(id) on delete cascade,
  ticker text not null,
  name text,
  reason text not null,
  next_catalyst_date date,
  added_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (subscriber_id, ticker)
);
alter table public.watchlist enable row level security;
create index if not exists watchlist_subscriber_idx on public.watchlist (subscriber_id, last_seen_at);
