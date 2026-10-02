-- 20260908160118  pledges_allow_pco_source
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

alter table public.pledges drop constraint if exists pledges_source_check;
alter table public.pledges add constraint pledges_source_check check (source in ('online','admin','pco'));
alter table public.pledges drop constraint if exists pledges_frequency_check;
alter table public.pledges add constraint pledges_frequency_check check (frequency in ('weekly','monthly','quarterly','annually','one_time','unspecified'));
-- Pull runs alongside the totals refresh every 15 minutes.
select cron.unschedule('pledge-pco-totals');
select cron.schedule('pledge-pco-pull', '*/15 * * * *', $$select public.pledge_pco_call('{"action":"pull"}'::jsonb);$$);
