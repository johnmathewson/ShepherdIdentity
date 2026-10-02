// pledge-notify — emails the campaign admins when a pledge arrives or is
// withdrawn. Fired by a pg_net trigger on public.pledges (service-role JWT).
// Body: { pledge_id, event: 'created' | 'withdrawn' | 'restored', to_override? }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("PLEDGE_FROM") || "Shepherd Church <prayer@nwiprays.com>";
const SITE_URL = (Deno.env.get("PLEDGE_SITE_URL") || "https://pledge.shepherdchurch.co").replace(/\/$/, "");

const FREQ: Record<string, { label: string; perYear: number; per: string }> = {
  weekly: { label: "Weekly", perYear: 52, per: "week" }, monthly: { label: "Monthly", perYear: 12, per: "month" },
  quarterly: { label: "Quarterly", perYear: 4, per: "quarter" }, annually: { label: "Annually", perYear: 1, per: "year" },
  one_time: { label: "One-time", perYear: 0, per: "gift" },
};
const money = (n: unknown) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const json = (b: unknown, s: number) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });

function jwtRole(t: string): string | null {
  try { const p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); return JSON.parse(atob(p + "=".repeat((4 - p.length % 4) % 4))).role || null; } catch { return null; }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (jwtRole(token) !== "service_role") return json({ error: "unauthorized" }, 401);
  const svc = createClient(SUPABASE_URL, token, { auth: { persistSession: false } });
  const { error: authErr } = await svc.from("pledge_settings").select("id", { head: true, count: "exact" });
  if (authErr) return json({ error: "unauthorized" }, 401);
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body.pledge_id || "");
    const event = String(body.event || "created");
    const { data: p } = await db.from("pledges").select("*").eq("id", id).single();
    if (!p) return json({ error: "pledge not found" }, 404);
    const [{ data: admins }, { data: settings }] = await Promise.all([
      db.from("pledge_admins").select("email"), db.from("pledge_settings").select("contact_email").eq("id", 1).maybeSingle(),
    ]);
    const to = body.to_override ? [String(body.to_override)] : [...new Set([...(admins || []).map((a: any) => a.email), settings?.contact_email].filter(Boolean))];
    if (!to.length) return json({ ok: false, error: "no recipients" }, 200);

    const f = FREQ[p.frequency] || FREQ.monthly;
    const inst = p.frequency === "one_time" ? Number(p.amount_total) : Number(p.amount_total) / (f.perYear * Number(p.term_years || 5));
    const schedule = p.frequency === "one_time" ? "One-time gift" : `${f.label} · about ${money(inst)} per ${f.per} · ${p.term_years} year${p.term_years > 1 ? "s" : ""}`;
    const title = event === "withdrawn" ? `Pledge withdrawn — ${p.donor_name} (${p.ref_code})`
      : event === "restored" ? `Pledge restored — ${p.donor_name} (${p.ref_code})`
      : `New pledge — ${money(p.amount_total)} from ${p.donor_name} (${p.ref_code})`;
    const rows: [string, string][] = [
      ["Donor", p.donor_name], ["Email", p.email || "—"], ["Phone", p.phone || "—"],
      ["Total pledge", money(p.amount_total)], ["Schedule", schedule],
      ["Start", p.start_date || "with first gift"],
      ["Recurring giving", p.recurring_setup ? `Yes${p.recurring_method ? " — " + (p.recurring_method === "ach" ? "bank draft (ACH)" : "card") : ""}` : "not requested"],
      ["First gift today", Number(p.first_gift_amount) > 0 ? money(p.first_gift_amount) : "—"],
      ["Source", p.source === "admin" ? `Recorded by ${p.created_by || "admin"}` : "Online"],
      ["Planning Center", p.pco_sync_status || "pending"],
    ];
    if (p.note) rows.push(["Note", p.note]);
    const table = rows.map(([k, v]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #DCE2EA;font-family:Montserrat,Arial,sans-serif;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#626F86;width:36%;vertical-align:top">${esc(k)}</td><td style="padding:8px 0;border-bottom:1px solid #DCE2EA;font-family:Lato,Arial,sans-serif;font-size:15px;color:#1B2027">${esc(v)}</td></tr>`).join("");
    const html = `<!DOCTYPE html><html><body style="margin:0;background:#F6F6FF;font-family:Lato,Arial,sans-serif;color:#1B2027"><table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff">
<tr><td style="background:#1B2027;padding:18px 24px;border-top:4px solid #FF4018"><p style="margin:0;font-family:Montserrat,Arial,sans-serif;font-weight:700;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#FF4018">Making Room · Admin</p><p style="margin:4px 0 0;font-family:Montserrat,Arial,sans-serif;font-weight:800;font-size:20px;color:#fff">${esc(title)}</p></td></tr>
<tr><td style="padding:22px 24px"><table width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #1B2027">${table}</table>
<p style="margin:20px 0 0"><a href="${SITE_URL}/admin" style="display:inline-block;background:#1B2027;color:#fff;text-decoration:none;padding:12px 20px;font-family:Montserrat,Arial,sans-serif;font-weight:600;font-size:14px">Open admin</a></p>
<p style="margin:14px 0 0;font-size:12px;color:#626F86">The signed card is available from the admin drawer (Download card). You're receiving this because you're a Making Room admin.</p></td></tr></table></td></tr></table></body></html>`;
    const text = `${title}\n\n` + rows.map(([k, v]) => `${k}: ${v}`).join("\n") + `\n\nAdmin: ${SITE_URL}/admin`;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to, subject: title, html, text }),
    });
    const j = await r.json().catch(() => ({}));
    await db.from("pledge_email_log").insert({ pledge_id: p.id, to_email: to.join(","), kind: `admin_${event}`, status: r.ok ? "sent" : "failed", resend_id: j.id || null, error: r.ok ? null : JSON.stringify(j).slice(0, 400) });
    return json({ ok: r.ok, to, id: j.id || null, error: r.ok ? null : j }, 200);
  } catch (e) {
    console.error("pledge-notify", e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
