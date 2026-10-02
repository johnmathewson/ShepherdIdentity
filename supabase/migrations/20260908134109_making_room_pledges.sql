-- 20260908134109  making_room_pledges
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- Making Room capital campaign — pledge tables.
-- All tables: RLS enabled with NO policies. anon/authenticated get nothing directly;
-- every read/write goes through edge functions using the service role.
-- The only public surface is pledge_meter(), which returns aggregates.

create table public.pledge_settings (
  id int primary key default 1 check (id = 1),
  campaign_name text not null default 'Making Room',
  goal_amount numeric(12,2) not null default 500000,
  meter_public boolean not null default true,
  show_household_count boolean not null default true,
  contact_email text,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.pledge_settings (id) values (1);

create table public.pledge_admins (
  email text primary key,
  added_by text,
  created_at timestamptz not null default now()
);
insert into public.pledge_admins (email, added_by) values
  ('john@johnmathewson.co', 'seed'),
  ('kschaap33@gmail.com', 'seed');

create table public.pledges (
  id uuid primary key default gen_random_uuid(),
  ref_code text not null unique,
  status text not null default 'active' check (status in ('active','withdrawn','void')),
  source text not null default 'online' check (source in ('online','admin')),
  donor_name text not null,
  email text,
  email_lower text generated always as (lower(email)) stored,
  phone text,
  address_line text,
  city text,
  state text,
  postal text,
  amount_total numeric(12,2) not null check (amount_total > 0),
  term_years int not null default 5 check (term_years between 1 and 5),
  frequency text not null check (frequency in ('weekly','monthly','quarterly','annually','one_time')),
  installment_amount numeric(12,2),
  start_date date,
  note text,
  signature_png text,
  signature_kind text check (signature_kind in ('drawn','typed')),
  signed_name text,
  signed_at timestamptz,
  signed_ip text,
  signed_user_agent text,
  manage_token_hash text unique,
  created_by text,
  admin_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pledges_email_lower_idx on public.pledges (email_lower);
create index pledges_status_idx on public.pledges (status);

create table public.pledge_revisions (
  id bigserial primary key,
  pledge_id uuid not null references public.pledges(id) on delete cascade,
  actor text not null,
  action text not null,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index pledge_revisions_pledge_idx on public.pledge_revisions (pledge_id);

create table public.pledge_email_log (
  id bigserial primary key,
  pledge_id uuid references public.pledges(id) on delete set null,
  to_email text not null,
  kind text not null,
  status text not null,
  resend_id text,
  error text,
  created_at timestamptz not null default now()
);

create table public.pledge_rate_limit (
  key text primary key,
  window_start timestamptz not null default now(),
  count int not null default 1
);

alter table public.pledge_settings enable row level security;
alter table public.pledge_admins enable row level security;
alter table public.pledges enable row level security;
alter table public.pledge_revisions enable row level security;
alter table public.pledge_email_log enable row level security;
alter table public.pledge_rate_limit enable row level security;

revoke all on public.pledge_settings, public.pledge_admins, public.pledges,
  public.pledge_revisions, public.pledge_email_log, public.pledge_rate_limit
  from anon, authenticated;

create or replace function public.pledge_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger pledges_updated_at before update on public.pledges
  for each row execute function public.pledge_set_updated_at();

-- Public aggregate for the goal meter. Aggregates only, never rows.
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
    'as_of', now()
  )
  from public.pledge_settings s where s.id = 1;
$$;
revoke all on function public.pledge_meter() from public;
grant execute on function public.pledge_meter() to anon, authenticated, service_role;
