-- 20260608195701  add_is_saved_to_social_share
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


alter table public.devotional_social_share
  add column if not exists is_saved boolean not null default false,
  add column if not exists saved_at timestamptz;

-- Backfill: anything that exists today is implicitly "saved" so the
-- library doesn't lose the test generation already there.
update public.devotional_social_share
   set is_saved = true, saved_at = coalesce(saved_at, generated_at)
 where is_saved = false;
