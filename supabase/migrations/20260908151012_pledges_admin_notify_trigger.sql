-- 20260908151012  pledges_admin_notify_trigger
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- Generic fire-and-forget call into any pledge-* edge function.
create or replace function public.pledge_fn_call(p_fn text, p_body jsonb)
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
    raise warning 'pledge_fn_call: service key missing from vault';
    return null;
  end if;
  select net.http_post(
    url := 'https://epkuvykamufrrgbacbel.supabase.co/functions/v1/' || p_fn,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := p_body,
    timeout_milliseconds := 30000
  ) into v_id;
  return v_id;
end $$;
revoke all on function public.pledge_fn_call(text, jsonb) from public, anon, authenticated;

-- Admin notifications: new pledge (any source) and donor withdraw/restore.
-- Delayed 3s so the PCO sync status is usually known by the time the email renders.
create or replace function public.pledge_notify_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event text;
begin
  if tg_op = 'INSERT' then
    v_event := 'created';
  elsif new.status = 'withdrawn' and old.status = 'active' then
    v_event := 'withdrawn';
  elsif new.status = 'active' and old.status = 'withdrawn' then
    v_event := 'restored';
  else
    return new;
  end if;
  perform public.pledge_fn_call('pledge-notify', jsonb_build_object('pledge_id', new.id, 'event', v_event));
  return new;
end $$;
drop trigger if exists pledges_admin_notify on public.pledges;
create trigger pledges_admin_notify
  after insert or update of status on public.pledges
  for each row execute function public.pledge_notify_enqueue();
