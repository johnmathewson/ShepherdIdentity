// pledge-admin — staff actions. Caller must be a signed-in Supabase user whose
// email is in pledge_admins. Everything runs with the service role after that.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  admin, ANON_KEY, cleanPledge, corsHeaders, HttpError, json, SUPABASE_URL,
  hashToken, newRefCode, newToken, readJson, sendPledgeEmail, logRevision, buildCardPdf,
} from "./shared.ts";

async function requireAdmin(req: Request): Promise<string> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token || !ANON_KEY) throw new HttpError(401, "Please sign in.");
  const userSb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const { data: { user }, error } = await userSb.auth.getUser();
  if (error || !user?.email) throw new HttpError(401, "Please sign in.");
  const email = user.email.toLowerCase();
  const { data } = await admin().from("pledge_admins").select("email").eq("email", email).maybeSingle();
  if (!data) throw new HttpError(403, `${email} is not an admin for this campaign.`);
  return email;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, req);
  const sb = admin();
  try {
    const me = await requireAdmin(req);
    const body = await readJson(req);
    const action = String(body.action || "");
    const actor = `admin:${me}`;

    if (action === "overview") {
      const [{ data: settings }, { data: meter }, { data: pledges }] = await Promise.all([
        sb.from("pledge_settings").select("*").eq("id", 1).single(),
        sb.rpc("pledge_meter"),
        sb.from("pledges").select("id,ref_code,status,source,donor_name,email,phone,city,state,amount_total,term_years,frequency,installment_amount,start_date,recurring_setup,recurring_method,first_gift_amount,signature_kind,signed_at,created_at,updated_at,created_by,admin_note,pco_sync_status,pco_sync_error,pco_person_id,pco_pledge_id").order("created_at", { ascending: false }),
      ]);
      return json({ ok: true, me, settings, meter, pledges: pledges || [] }, 200, req);
    }

    if (action === "get") {
      const id = String(body.id || "");
      const [{ data: p }, { data: revisions }, { data: emails }] = await Promise.all([
        sb.from("pledges").select("*").eq("id", id).single(),
        sb.from("pledge_revisions").select("*").eq("pledge_id", id).order("created_at", { ascending: false }),
        sb.from("pledge_email_log").select("*").eq("pledge_id", id).order("created_at", { ascending: false }),
      ]);
      if (!p) throw new HttpError(404, "Pledge not found.");
      const { manage_token_hash: _h, ...rest } = p;
      return json({ ok: true, pledge: rest, revisions: revisions || [], emails: emails || [] }, 200, req);
    }

    if (action === "add") {
      const p = cleanPledge(body, { requireEmail: false });
      const sendEmail = body.send_email === true && !!p.email;
      const token = newToken();
      const row = {
        ...p,
        ref_code: await newRefCode(sb),
        status: "active", source: "admin",
        created_by: me,
        admin_note: body.admin_note ? String(body.admin_note).slice(0, 2000) : null,
        signed_name: body.signed_name ? String(body.signed_name).slice(0, 120) : null,
        signed_at: body.signed_at ? String(body.signed_at) : null,
        manage_token_hash: p.email ? await hashToken(token) : null,
      };
      const { data, error } = await sb.from("pledges").insert(row).select("*").single();
      if (error) throw new HttpError(500, "Could not save the pledge: " + error.message);
      await logRevision(sb, data.id, actor, "created_by_admin", null, data);
      let email_sent = false;
      if (sendEmail) email_sent = (await sendPledgeEmail(sb, "admin_added", data, token, { attachCard: true })).ok;
      return json({ ok: true, pledge: data, email_sent }, 200, req);
    }

    if (action === "update") {
      const id = String(body.id || "");
      const { data: before } = await sb.from("pledges").select("*").eq("id", id).single();
      if (!before) throw new HttpError(404, "Pledge not found.");
      const p = cleanPledge({ ...before, ...body }, { requireEmail: false });
      const patch: Record<string, unknown> = { ...p };
      if ("admin_note" in body) patch.admin_note = body.admin_note ? String(body.admin_note).slice(0, 2000) : null;
      if (body.status && ["active", "withdrawn", "void"].includes(String(body.status))) patch.status = body.status;
      if ("signed_name" in body) patch.signed_name = body.signed_name ? String(body.signed_name).slice(0, 120) : null;
      const { data, error } = await sb.from("pledges").update(patch).eq("id", id).select("*").single();
      if (error) throw new HttpError(500, "Could not save: " + error.message);
      await logRevision(sb, id, actor, "updated_by_admin", before, data);
      let email_sent = false;
      if (body.notify_donor === true && data.email) {
        const token = newToken();
        await sb.from("pledges").update({ manage_token_hash: await hashToken(token) }).eq("id", id);
        email_sent = (await sendPledgeEmail(sb, "updated", data, token, { attachCard: true })).ok;
      }
      const { manage_token_hash: _h, ...rest } = data;
      return json({ ok: true, pledge: rest, email_sent }, 200, req);
    }

    if (action === "set_status") {
      const id = String(body.id || ""), status = String(body.status || "");
      if (!["active", "withdrawn", "void"].includes(status)) throw new HttpError(400, "Bad status.");
      const { data: before } = await sb.from("pledges").select("status").eq("id", id).single();
      const { data, error } = await sb.from("pledges").update({ status }).eq("id", id).select("*").single();
      if (error || !data) throw new HttpError(500, "Could not update.");
      await logRevision(sb, id, actor, `status:${status}`, before, { status });
      const { manage_token_hash: _h, ...rest } = data;
      return json({ ok: true, pledge: rest }, 200, req);
    }

    if (action === "send_link") {
      const id = String(body.id || "");
      const { data: p } = await sb.from("pledges").select("*").eq("id", id).single();
      if (!p) throw new HttpError(404, "Pledge not found.");
      if (!p.email) throw new HttpError(400, "This pledge has no email address.");
      const token = newToken();
      await sb.from("pledges").update({ manage_token_hash: await hashToken(token) }).eq("id", id);
      const r = await sendPledgeEmail(sb, "link", p, token, { attachCard: true });
      if (!r.ok) throw new HttpError(500, "Email failed: " + r.error);
      return json({ ok: true }, 200, req);
    }

    if (action === "card_pdf") {
      const id = String(body.id || "");
      const { data: p } = await sb.from("pledges").select("*").eq("id", id).single();
      if (!p) throw new HttpError(404, "Pledge not found.");
      const bytes = await buildCardPdf(p);
      return new Response(bytes, { headers: { "content-type": "application/pdf", ...corsHeaders(req) } });
    }

    if (action === "settings_update") {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: me };
      if (body.goal_amount != null) { const g = Number(body.goal_amount); if (!(g > 0)) throw new HttpError(400, "Goal must be positive."); patch.goal_amount = g; }
      if (body.campaign_name != null) patch.campaign_name = String(body.campaign_name).slice(0, 80);
      if (body.meter_public != null) patch.meter_public = !!body.meter_public;
      if (body.show_household_count != null) patch.show_household_count = !!body.show_household_count;
      if ("contact_email" in body) patch.contact_email = body.contact_email ? String(body.contact_email).trim().toLowerCase().slice(0, 200) : null;
      const { data, error } = await sb.from("pledge_settings").update(patch).eq("id", 1).select("*").single();
      if (error) throw new HttpError(500, error.message);
      return json({ ok: true, settings: data }, 200, req);
    }

    if (action === "admins_list") {
      const { data } = await sb.from("pledge_admins").select("*").order("created_at");
      return json({ ok: true, admins: data || [] }, 200, req);
    }
    if (action === "admins_add") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email.");
      await sb.from("pledge_admins").upsert({ email, added_by: me });
      const { data: list } = await sb.auth.admin.listUsers({ perPage: 1000 });
      if (!list?.users?.some((u) => (u.email || "").toLowerCase() === email)) {
        await sb.auth.admin.createUser({ email, email_confirm: true });
      }
      return json({ ok: true }, 200, req);
    }
    if (action === "admins_remove") {
      const email = String(body.email || "").trim().toLowerCase();
      const { count } = await sb.from("pledge_admins").select("*", { count: "exact", head: true });
      if ((count || 0) <= 1) throw new HttpError(400, "You can't remove the last admin.");
      await sb.from("pledge_admins").delete().eq("email", email);
      return json({ ok: true }, 200, req);
    }

    throw new HttpError(400, "Unknown action.");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("pledge-admin", e);
    return json({ error: e instanceof HttpError ? e.message : "Something went wrong." }, status, req);
  }
});
