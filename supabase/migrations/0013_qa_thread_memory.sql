-- Thread memory: the desk's answer is stored on the reply that asked,
-- so a follow-up question in the same thread knows what was already said.
alter table public.feedback
  add column if not exists answer_md text;
