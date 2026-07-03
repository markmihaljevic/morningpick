-- Memos can legitimately take ~5 minutes now; 10-minute reclaim risked
-- double-processing under parallel chains. 20 minutes keeps crash recovery
-- while making reclaim-during-work practically impossible.
create or replace function claim_deliveries(batch int)
returns setof deliveries
language sql
security definer
set search_path = public
as $$
  update deliveries d
  set status = 'processing', claimed_at = now(), attempts = d.attempts + 1
  where d.id in (
    select del.id
    from deliveries del
    join subscribers s on s.id = del.subscriber_id
    where s.status = 'active'
      and (
        del.status = 'pending'
        or (del.status = 'processing' and del.claimed_at < now() - interval '20 minutes')
      )
      and del.attempts < 3
    order by del.delivery_date
    limit batch
    for update of del skip locked
  )
  returning d.*;
$$;
revoke execute on function claim_deliveries(int) from public, anon, authenticated;
grant execute on function claim_deliveries(int) to service_role;
