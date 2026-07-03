-- Record the price each memo was pitched at. No tracking product is built on
-- this yet — it exists so a future track record can reach back to launch day.
alter table memos
  add column pitch_price numeric,
  add column pitch_currency text;
