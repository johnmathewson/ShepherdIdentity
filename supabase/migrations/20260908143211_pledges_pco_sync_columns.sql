-- 20260908143211  pledges_pco_sync_columns
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

alter table public.pledges
  add column pco_person_id text,
  add column pco_pledge_id text,
  add column pco_sync_status text check (pco_sync_status in ('synced','failed','needs_review','removed')),
  add column pco_sync_error text,
  add column pco_synced_at timestamptz,
  add column pco_review jsonb;
create index pledges_pco_sync_status_idx on public.pledges (pco_sync_status);

alter table public.pledge_settings
  add column pco_campaign_id text,
  add column pco_fund_id text,
  add column pco_totals jsonb,
  add column pco_totals_at timestamptz;

-- Meter now also exposes what has actually been received (from PCO, cached).
create or replace function public.pledge_meter()
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'campaign_name', s.campaign_name,
    'goal', s.goal_amount,
    'meter_public', s.meter_public,
    'show_household_count', s.show_household_count,
    'total', coalesce((select sum(amount_total) from public.pledges where status = 'active'), 0),
    'count', coalesce((select count(*) from public.pledges where status = 'active'), 0),
    'received', coalesce((s.pco_totals->>'received_total')::numeric, null),
    'received_at', s.pco_totals_at,
    'as_of', now()
  )
  from public.pledge_settings s where s.id = 1;
$$;
