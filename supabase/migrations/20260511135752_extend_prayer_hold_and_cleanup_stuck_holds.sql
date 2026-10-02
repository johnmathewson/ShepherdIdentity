-- 20260511135752  extend_prayer_hold_and_cleanup_stuck_holds
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- Magic-link Prayer Week flow needs a longer hold than the default 30s
-- to survive an email round-trip. extend_prayer_hold() is called by
-- /api/auth visitor_magic_link right before we trigger the OTP send,
-- so a casual click still releases in 30s but a committed sign-in
-- gets 10 minutes of breathing room.
CREATE OR REPLACE FUNCTION public.extend_prayer_hold(p_hold_token uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_row prayer_week_signups;
BEGIN
  SELECT * INTO v_row
    FROM prayer_week_signups
    WHERE hold_token = p_hold_token AND status = 'held'
    LIMIT 1;

  IF NOT FOUND THEN
    RETURN json_build_object('error', 'hold_not_found');
  END IF;

  -- If the slot was already confirmed by someone else, drop our stale
  -- hold and tell the caller — the page will show "just taken".
  IF EXISTS (
    SELECT 1 FROM prayer_week_signups
    WHERE slot_id = v_row.slot_id AND status = 'confirmed'
  ) THEN
    DELETE FROM prayer_week_signups WHERE id = v_row.id;
    RETURN json_build_object('error', 'slot_taken');
  END IF;

  UPDATE prayer_week_signups
    SET hold_expires_at = now() + interval '10 minutes'
    WHERE id = v_row.id;

  RETURN json_build_object('success', true, 'expires_in_seconds', 600);
END;
$function$;

-- Free the slot inventory: 22 anonymous 'held' rows from the broken
-- short-TTL era have been blocking slots from re-appearing as open.
DELETE FROM prayer_week_signups
  WHERE status = 'held' AND hold_expires_at < now();
