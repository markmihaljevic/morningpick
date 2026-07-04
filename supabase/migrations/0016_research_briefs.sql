-- Research once per ticker per day; write once per subscriber. The brief is
-- the desk's shared, sourced fact base — the expensive tool-using research
-- runs once and every subscriber's personalized note is written from it.
create table if not exists public.research_briefs (
  ticker text not null,
  brief_date date not null,
  status text not null default 'building', -- building | ready | failed
  brief_md text,
  sources jsonb not null default '[]'::jsonb, -- [{url, title}] — inline-link whitelist
  built_by text, -- worker/chain identifier, for debugging
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  primary key (ticker, brief_date)
);
alter table public.research_briefs enable row level security;
