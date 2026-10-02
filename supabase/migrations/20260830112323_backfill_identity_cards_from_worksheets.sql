-- 20260830112323  backfill_identity_cards_from_worksheets
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- One-time backfill: every existing identityWorksheet becomes that user's primary card.
-- Skips profiles whose worksheet is entirely blank, and is idempotent via the source guard.

insert into public.identity_cards (
  user_id, label, identity_statement, callings, spiritual_gifts,
  passion, vocation, ministry, natural_abilities,
  is_primary, source, sort_order, created_at, updated_at
)
select
  p.id,
  'My identity',
  nullif(trim(p.state->'identityWorksheet'->>'identityStatement'), ''),
  nullif(trim(p.state->'identityWorksheet'->>'callings'), ''),
  nullif(trim(p.state->'identityWorksheet'->>'spiritualGifts'), ''),
  nullif(trim(p.state->'identityWorksheet'->>'passion'), ''),
  nullif(trim(p.state->'identityWorksheet'->>'vocation'), ''),
  nullif(trim(p.state->'identityWorksheet'->>'ministry'), ''),
  nullif(trim(p.state->'identityWorksheet'->>'naturalAbilities'), ''),
  true,
  'worksheet',
  0,
  coalesce(p.created_at, now()),
  coalesce(p.updated_at, now())
from public.profiles p
where jsonb_typeof(p.state->'identityWorksheet') = 'object'
  and coalesce(
        nullif(trim(p.state->'identityWorksheet'->>'identityStatement'), ''),
        nullif(trim(p.state->'identityWorksheet'->>'callings'), ''),
        nullif(trim(p.state->'identityWorksheet'->>'spiritualGifts'), ''),
        nullif(trim(p.state->'identityWorksheet'->>'passion'), ''),
        nullif(trim(p.state->'identityWorksheet'->>'vocation'), ''),
        nullif(trim(p.state->'identityWorksheet'->>'ministry'), ''),
        nullif(trim(p.state->'identityWorksheet'->>'naturalAbilities'), '')
      ) is not null
  and not exists (
        select 1 from public.identity_cards c
        where c.user_id = p.id and c.source = 'worksheet'
      );
