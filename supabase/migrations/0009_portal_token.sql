-- Personal desk links: a per-subscriber token that unlocks a read-only,
-- personalized view of their memo history at /me/<token>. No login —
-- possession of the link (delivered by email) is the authentication,
-- same model as unsubscribe/confirm links.
alter table public.subscribers
  add column if not exists portal_token uuid not null default gen_random_uuid();

create unique index if not exists subscribers_portal_token_idx
  on public.subscribers (portal_token);
