-- 20260530153447  schedule_daily_devotional_email_cron
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


-- 1. Enable extensions
create extension if not exists pg_net  with schema extensions;
create extension if not exists pg_cron with schema extensions;

-- 2. Wrapper function the cron calls.
-- Date-guarded: silently skips firing until 2026-06-01 Eastern.
-- Reads the service-role key from Vault, so the key never lives in a
-- cron definition or a SQL log. Requires the user to seed the vault
-- one time (see deploy notes).
create or replace function public.cron_send_daily_devotional()
returns void
language plpgsql
security definer
set search_path = public
as $func$
declare
  today_eastern date := (now() at time zone 'America/Indiana/Indianapolis')::date;
  start_date    date := '2026-06-01';
  svc_key       text;
begin
  if today_eastern < start_date then
    raise notice 'devotional cron: skipping (today=% < start=%)', today_eastern, start_date;
    return;
  end if;
  select decrypted_secret into svc_key
  from vault.decrypted_secrets
  where name = 'devotional_service_key'
  limit 1;
  if svc_key is null or svc_key = '' then
    raise warning 'devotional cron: vault secret devotional_service_key not set';
    return;
  end if;
  perform net.http_post(
    url     := 'https://epkuvykamufrrgbacbel.supabase.co/functions/v1/send-devotional-email',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || svc_key,
      'Content-Type',  'application/json'
    ),
    body    := '{}'::jsonb
  );
end;
$func$;

-- 3. Schedule daily at 11:00 UTC.
-- Eastern equivalent: 6 AM EST during winter, 7 AM EDT during DST.
-- Unschedule any prior copy first so reruns of this migration are clean.
do $sched$
begin
  if exists (select 1 from cron.job where jobname = 'send-daily-devotional') then
    perform cron.unschedule('send-daily-devotional');
  end if;
  perform cron.schedule(
    'send-daily-devotional',
    '0 11 * * *',
    'select public.cron_send_daily_devotional();'
  );
end;
$sched$;

-- 4. Placeholder rows for May 29–31 so members keep seeing a teaser
-- on the home view. (Cron won't fire on these days thanks to the
-- 2026-06-01 date guard, so no emails will go out for them.)
insert into public.devotionals (publish_date, title, teaser, body, author, published)
values
  ('2026-05-29', 'Daily Devotional — Coming Soon',
   'Our first devotional drops Monday, June 1. See you then.',
   E'Starting Monday, June 1, you''ll find a fresh devotional here each morning — Scripture, a thought to sit with, sometimes a worship song or a clip from Sunday, and space for your own notes.\n\nUntil then, take a breath. Listen for what the Father is whispering today.',
   'Shepherd Formation', true),
  ('2026-05-30', 'Daily Devotional — Coming Soon',
   'Our first devotional drops Monday, June 1. See you then.',
   E'Starting Monday, June 1, you''ll find a fresh devotional here each morning — Scripture, a thought to sit with, sometimes a worship song or a clip from Sunday, and space for your own notes.\n\nUntil then, take a breath. Listen for what the Father is whispering today.',
   'Shepherd Formation', true),
  ('2026-05-31', 'Daily Devotional — Coming Soon',
   'Our first devotional drops Monday, June 1. See you then.',
   E'Starting Monday, June 1, you''ll find a fresh devotional here each morning — Scripture, a thought to sit with, sometimes a worship song or a clip from Sunday, and space for your own notes.\n\nUntil then, take a breath. Listen for what the Father is whispering today.',
   'Shepherd Formation', true)
on conflict (publish_date) do nothing;
