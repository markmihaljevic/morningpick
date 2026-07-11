-- Judgment-picked peer groups (John's rule: peer selection is a reasoning
-- call, not a screen). One row per subject ticker; rationales print under
-- the comp table. Reused while younger than six months, then re-verified.
create table if not exists peer_groups (
  symbol text primary key,
  peers jsonb not null,          -- [{ticker, name, rationale}]
  compiled_at timestamptz not null default now()
);
alter table peer_groups enable row level security;
