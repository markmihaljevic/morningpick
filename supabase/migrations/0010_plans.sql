-- Paid tier. plan semantics:
--   free — the Monday note only; no reply Q&A, no follow-ups
--   paid — daily note + reply Q&A + follow-ups (Stripe subscription)
--   comp — daily product, comped (founding members, partners)
alter table public.subscribers
  add column if not exists plan text not null default 'free',
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text;

alter table public.subscribers drop constraint if exists subscribers_plan_check;
alter table public.subscribers
  add constraint subscribers_plan_check check (plan in ('free', 'paid', 'comp'));

create index if not exists subscribers_stripe_customer_idx
  on public.subscribers (stripe_customer_id);

-- Founding subscribers (everyone who signed up before the paid tier existed)
-- keep the full daily product, comped.
update public.subscribers set plan = 'comp' where plan = 'free';
