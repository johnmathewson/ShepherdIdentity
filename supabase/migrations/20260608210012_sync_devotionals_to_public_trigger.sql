-- 20260608210012  sync_devotionals_to_public_trigger
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


-- Trigger that mirrors devotional inserts/updates/deletes to the public
-- Go Find Jesus app (formationtool.com) by POSTing to its sync-devotional-in
-- edge function. Authenticates with a shared secret stored in Shepherd's
-- vault under the name `shepherd_sync_secret` (same value must also live
-- in the Go Find Jesus project's secrets as SHEPHERD_SYNC_SECRET).
--
-- pg_net is fire-and-forget. Pastor Ken's INSERT/UPDATE on devotionals is
-- never blocked by network or downstream errors. If the public endpoint
-- is down, the request is still logged in net._http_response with the
-- status code, and re-saving the devotional re-triggers a fresh attempt.

create or replace function public.sync_devotional_to_public()
returns trigger
language plpgsql
security definer
set search_path = public
as $func$
declare
  sync_secret   text;
  endpoint_url  text := 'https://qtykoynnsyvrdkyeviwg.supabase.co/functions/v1/sync-devotional-in';
  payload       jsonb;
begin
  select decrypted_secret into sync_secret
    from vault.decrypted_secrets
   where name = 'shepherd_sync_secret'
   limit 1;

  if sync_secret is null or sync_secret = '' then
    raise notice 'sync_devotional_to_public: vault secret shepherd_sync_secret not set, skipping';
    return coalesce(new, old);
  end if;

  payload := jsonb_build_object(
    'type', tg_op,
    'record',     case when tg_op = 'DELETE' then null else to_jsonb(new) end,
    'old_record', case when tg_op = 'INSERT' then null else to_jsonb(old) end
  );

  perform net.http_post(
    url     := endpoint_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || sync_secret,
      'Content-Type',  'application/json'
    ),
    body    := payload
  );

  return coalesce(new, old);
end;
$func$;

drop trigger if exists devotionals_sync_to_public on public.devotionals;
create trigger devotionals_sync_to_public
  after insert or update or delete on public.devotionals
  for each row execute function public.sync_devotional_to_public();
