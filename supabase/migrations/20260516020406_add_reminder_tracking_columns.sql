-- 20260516020406  add_reminder_tracking_columns
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- Per-signup tracking so we never double-send a reminder. The Saturday
-- broadcast email is a digest sent once per visitor, but it's easier to
-- mark each signup row (idempotency without joining anything).
ALTER TABLE public.prayer_week_signups
  ADD COLUMN IF NOT EXISTS broadcast_sent_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_24h_sent_at TIMESTAMPTZ;

-- Helps the cron query find candidates fast even as the signup count grows.
CREATE INDEX IF NOT EXISTS prayer_week_signups_reminder_24h_pending_idx
  ON public.prayer_week_signups (slot_id)
  WHERE status = 'confirmed' AND reminder_24h_sent_at IS NULL;
