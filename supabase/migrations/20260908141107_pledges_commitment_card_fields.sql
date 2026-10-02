-- 20260908141107  pledges_commitment_card_fields
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- Fields added by the revised "Commitment Card" (Sept 2026 language).
alter table public.pledges
  add column recurring_setup boolean not null default false,
  add column recurring_method text check (recurring_method in ('ach','card')),
  add column first_gift_amount numeric(12,2) check (first_gift_amount is null or first_gift_amount >= 0);
