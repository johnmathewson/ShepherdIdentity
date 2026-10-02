-- 20260910131510  pledge_donations_mirror
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- Mirror of Planning Center Giving donations designated to the campaign fund.
-- Amount = the campaign-fund portion only (a split gift stores just its Building part).
create table public.pledge_donations (
  pco_donation_id text primary key,
  pco_person_id text,
  donor_name text,
  received_at timestamptz not null,
  amount numeric(12,2) not null,
  total_amount numeric(12,2),
  payment_method text,
  payment_status text,
  refunded boolean not null default false,
  pco_updated_at timestamptz,
  synced_at timestamptz not null default now()
);
create index pledge_donations_person_idx on public.pledge_donations (pco_person_id);
create index pledge_donations_received_idx on public.pledge_donations (received_at);
alter table public.pledge_donations enable row level security;
revoke all on public.pledge_donations from public, anon, authenticated;

alter table public.pledge_settings add column pco_donations_synced_at timestamptz;
