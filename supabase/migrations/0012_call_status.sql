-- The book: every idea is an open call until the analyst closes it.
-- 'active'   — the call stands
-- 'watching' — thesis under pressure; the analyst flagged it
-- 'closed'   — played out or broken; stated plainly in a follow-up
alter table public.memos
  add column if not exists call_status text not null default 'active',
  add column if not exists call_closed_at timestamptz,
  add column if not exists call_close_reason text;

alter table public.memos drop constraint if exists memos_call_status_check;
alter table public.memos
  add constraint memos_call_status_check check (call_status in ('active', 'watching', 'closed'));
