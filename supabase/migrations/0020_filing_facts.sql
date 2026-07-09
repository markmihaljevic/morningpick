create table if not exists filing_facts (
  symbol text not null,
  metric text not null,
  value text not null,
  source text,
  as_of date,
  updated_at timestamptz not null default now(),
  primary key (symbol, metric)
);
alter table filing_facts enable row level security;
