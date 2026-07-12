-- Company identity for the no-repeat rule: ISIN when known, else normalized
-- name. THX.L and THX.V are one company; a send consumes every listing.
-- (Applied to the live DB on 2026-07-12; committed here so every environment
-- built from migrations reproduces the schema the code requires.)
alter table memos add column if not exists company_key text;
create index if not exists memos_subscriber_company_key_idx on memos (subscriber_id, company_key);
