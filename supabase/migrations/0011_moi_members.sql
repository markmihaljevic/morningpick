-- MOI Global member list (imported via scripts/import-moi-members.ts).
-- Membership is detected by email at signup/sign-in and unlocks the
-- partner rate at checkout automatically — no promo code to type.
create table if not exists public.moi_members (
  email text primary key, -- stored lowercase
  added_at timestamptz not null default now()
);
alter table public.moi_members enable row level security;

alter table public.subscribers
  add column if not exists moi_member boolean not null default false;

update public.subscribers s
  set moi_member = true
  from public.moi_members m
  where lower(s.email) = m.email;
