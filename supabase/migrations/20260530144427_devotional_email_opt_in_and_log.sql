-- 20260530144427  devotional_email_opt_in_and_log
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


-- 1. Per-user email opt-in flag (default ON; matches the product decision)
alter table public.profiles
  add column if not exists devotional_email_opt_in boolean not null default true;

-- Backfill any existing nulls (defensive; default should have handled this)
update public.profiles set devotional_email_opt_in = true where devotional_email_opt_in is null;

-- Index for the daily cron's "who needs an email" query
create index if not exists profiles_devotional_email_opt_in_idx
  on public.profiles (devotional_email_opt_in)
  where devotional_email_opt_in = true;

-- 2. Audit log of every email send attempt
create table if not exists public.devotional_email_log (
  id            uuid primary key default gen_random_uuid(),
  devotional_id uuid not null references public.devotionals(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  email         text not null,
  status        text not null check (status in ('sent','failed','skipped')),
  resend_id     text,
  error         text,
  sent_at       timestamptz not null default now(),
  unique (devotional_id, user_id)  -- idempotency: never send twice for the same devotional
);

create index if not exists devotional_email_log_devotional_idx
  on public.devotional_email_log (devotional_id);
create index if not exists devotional_email_log_user_idx
  on public.devotional_email_log (user_id);

alter table public.devotional_email_log enable row level security;

-- Members can see their own send history
create policy devotional_email_log_select_own on public.devotional_email_log
  for select to authenticated using (user_id = auth.uid());

-- Admins can see everything (useful for debugging)
create policy devotional_email_log_select_admin on public.devotional_email_log
  for select to authenticated using (
    exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = 'admin')
  );

-- Writes only via service-role (edge function), so no INSERT policy needed for authenticated users.

-- 3. Helper view: today's eligible recipients (used by the edge function)
-- Returns users opted in who haven't already received today's devotional.
-- We pass the devotional_id as a parameter via a function.
create or replace function public.devotional_email_recipients(p_devotional_id uuid)
returns table (user_id uuid, email text, display_name text)
language sql
security definer
set search_path = public
stable
as $$
  select p.id, p.email, p.display_name
  from public.profiles p
  where p.devotional_email_opt_in = true
    and p.email is not null
    and p.email != ''
    and not exists (
      select 1 from public.devotional_email_log l
      where l.user_id = p.id and l.devotional_id = p_devotional_id
    );
$$;

-- Only callable by service role (called from the edge function); revoke from authenticated for safety
revoke all on function public.devotional_email_recipients(uuid) from public, authenticated;
grant execute on function public.devotional_email_recipients(uuid) to service_role;
