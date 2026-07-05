-- Self-reported holdings: the authoritative list behind "you hold X".
-- Edited on the profile page; context-only for now (the writer sees it,
-- selection is unchanged).
create table if not exists public.portfolio (
  subscriber_id uuid not null references public.subscribers(id) on delete cascade,
  ticker text not null,
  name text,
  note text,
  added_at timestamptz not null default now(),
  primary key (subscriber_id, ticker)
);
alter table public.portfolio enable row level security;
