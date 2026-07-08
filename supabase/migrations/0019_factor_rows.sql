-- Global factor table: one row per ticker of raw TTM factor inputs, refreshed
-- daily from FMP's bulk endpoints and shared by every subscriber. Per-user
-- scoring is a pure re-weighting of this table — no API calls, no tokens.
create table if not exists factor_rows (
  symbol text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists factor_rows_updated_at_idx on factor_rows (updated_at);
