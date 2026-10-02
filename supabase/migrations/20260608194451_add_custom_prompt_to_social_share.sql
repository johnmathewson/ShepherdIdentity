-- 20260608194451  add_custom_prompt_to_social_share
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.


alter table public.devotional_social_share
  add column if not exists custom_prompt text;
