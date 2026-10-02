-- 20260908143338  pledges_pco_sync_trigger_and_cron
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- Fire-and-forget call into the pledge-pco-sync edge function (service key from Vault).
create or replace function public.pledge_pco_call(p_body jsonb)
returns bigint
language plpgsql
security definer
set search_path = public, net, vault
as $$
declare
  v_key text;
  v_id bigint;
begin
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'devotional_service_key' limit 1;
  if v_key is null then
    raise warning 'pledge_pco_call: service key missing from vault';
    return null;
  end if;
  select net.http_post(
    url := 'https://epkuvykamufrrgbacbel.supabase.co/functions/v1/pledge-pco-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := p_body,
    timeout_milliseconds := 30000
  ) into v_id;
  return v_id;
end $$;
revoke all on function public.pledge_pco_call(jsonb) from public, anon, authenticated;

-- Row trigger: any change that matters to PCO enqueues a sync. The sync
-- function only writes pco_* columns, which are not in the UPDATE OF list,
-- so it never re-fires itself.
create or replace function public.pledge_pco_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.pledge_pco_call(jsonb_build_object('action', 'sync', 'pledge_id', new.id));
  return new;
end $$;
drop trigger if exists pledges_pco_sync on public.pledges;
create trigger pledges_pco_sync
  after insert or update of amount_total, status, email, donor_name, phone on public.pledges
  for each row execute function public.pledge_pco_enqueue();

-- Cron: refresh "given so far" every 15 minutes; reconcile nightly (3:15 AM Eastern ≈ 07:15 UTC).
select cron.schedule('pledge-pco-totals', '*/15 * * * *', $$select public.pledge_pco_call('{"action":"totals"}'::jsonb);$$);
select cron.schedule('pledge-pco-reconcile', '15 7 * * *', $$select public.pledge_pco_call('{"action":"reconcile"}'::jsonb);$$);
