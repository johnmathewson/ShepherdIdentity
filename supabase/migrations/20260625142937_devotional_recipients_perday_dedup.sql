-- 20260625142937  devotional_recipients_perday_dedup
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

CREATE OR REPLACE FUNCTION public.devotional_email_recipients(p_devotional_id uuid)
 RETURNS TABLE(user_id uuid, email text, display_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.id, p.email, p.display_name
  from public.profiles p
  where p.devotional_email_opt_in = true
    and p.email is not null
    and p.email <> ''
    and not exists (
      select 1
      from public.devotional_email_log l
      join public.devotionals d on d.id = l.devotional_id
      where l.user_id = p.id
        and l.devotional_id = p_devotional_id
        and l.status = 'sent'
        and (l.sent_at at time zone 'America/Indiana/Indianapolis')::date = d.publish_date
    );
$function$;
