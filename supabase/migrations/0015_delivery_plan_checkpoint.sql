-- Checkpoint: the desk's plan for a delivery (kind, ticker, contexts,
-- reference links) persists on the row once decided, so a retry resumes
-- at generation instead of re-running the whole morning funnel — one
-- delivery attempt no longer has to fit funnel + generation in a single
-- function budget.
alter table public.deliveries
  add column if not exists plan jsonb;
