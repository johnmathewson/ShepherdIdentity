-- 20260329171100  add_transcribe_interpret_to_ai_usage_check
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

ALTER TABLE public.ai_usage DROP CONSTRAINT IF EXISTS ai_usage_feature_check;
ALTER TABLE public.ai_usage ADD CONSTRAINT ai_usage_feature_check CHECK (feature = ANY (ARRAY['chat'::text, 'identity_synthesis'::text, 'dream_interpretation'::text, 'interpret'::text, 'transcribe'::text]));
