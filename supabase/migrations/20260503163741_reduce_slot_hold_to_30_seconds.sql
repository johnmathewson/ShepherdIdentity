-- 20260503163741  reduce_slot_hold_to_30_seconds
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

CREATE OR REPLACE FUNCTION public.hold_prayer_slot(p_slot_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hold_token UUID;
  v_existing prayer_week_signups;
BEGIN
  DELETE FROM prayer_week_signups
    WHERE slot_id = p_slot_id AND status = 'held' AND hold_expires_at < now();
  SELECT * INTO v_existing FROM prayer_week_signups WHERE slot_id = p_slot_id;
  IF FOUND THEN RETURN json_build_object('error', 'slot_taken'); END IF;
  v_hold_token := gen_random_uuid();
  INSERT INTO prayer_week_signups (slot_id, status, hold_token, hold_expires_at)
  VALUES (p_slot_id, 'held', v_hold_token, now() + interval '30 seconds');
  RETURN json_build_object('success', true, 'hold_token', v_hold_token, 'expires_in_seconds', 30);
END; $function$;
