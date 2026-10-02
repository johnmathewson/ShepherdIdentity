// pledge-pco-sync — mirrors Making Room pledges into Planning Center Giving, pulls PCO-entered pledges back, and mirrors campaign-fund gifts.
// Actions: ping · sync {pledge_id} · reconcile · totals · pull · pull_donations · collections · inspect
// Auth: service_role JWT, or a signed-in user whose email is in pledge_admins.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const PCO_APP_ID = Deno.env.get("PCO_APP_ID") || "";
const PCO_SECRET = Deno.env.get("PCO_SECRET") || "";
const PCO = "https://api.planningcenteronline.com";
const CAMPAIGN_NAME = Deno.env.get("PCO_CAMPAIGN_NAME") || "Making Room";

const ALLOWED_ORIGINS = ["https://pledge.shepherdchurch.co", "https://shepherd-pledge.netlify.app"];
function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  const ok = ALLOWED_ORIGINS.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  return { "Access-Control-Allow-Origin": ok ? o : ALLOWED_ORIGINS[0], "Access-Control-Allow-Headers": "authorization,content-type,apikey,x-client-info", "Access-Control-Allow-Methods": "POST,OPTIONS", "Vary": "Origin" };
}
const json = (b: unknown, s: number, req: Request) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", ...cors(req) } });
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const sb = (): SupabaseClient => createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function jwtPayload(t: string): Record<string, unknown> | null {
  try { const p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); return JSON.parse(atob(p + "=".repeat((4 - p.length % 4) % 4))); } catch { return null; }
}
async function authorize(req: Request): Promise<string> {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "unauthorized");
  const p = jwtPayload(token);
  if (p?.role === "service_role") {
    const { error } = await createClient(SUPABASE_URL, token, { auth: { persistSession: false } }).from("pledge_settings").select("id", { head: true, count: "exact" });
    if (!error) return "service";
  }
  const userSb = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const { data: { user } } = await userSb.auth.getUser();
  if (!user?.email) throw new HttpError(401, "unauthorized");
  const { data } = await sb().from("pledge_admins").select("email").eq("email", user.email.toLowerCase()).maybeSingle();
  if (!data) throw new HttpError(403, "not an admin");
  return `admin:${user.email.toLowerCase()}`;
}

async function pco(method: string, path: string, body?: unknown): Promise<any> {
  if (!PCO_APP_ID || !PCO_SECRET) throw new HttpError(500, "PCO_APP_ID / PCO_SECRET not set");
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(PCO + path, {
      method,
      headers: { Authorization: "Basic " + btoa(`${PCO_APP_ID}:${PCO_SECRET}`), "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 429) { const wait = Number(r.headers.get("retry-after") || 2); await new Promise((res) => setTimeout(res, (wait + 0.5) * 1000)); continue; }
    if (r.status === 204) return null;
    const text = await r.text();
    let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { /* non-json */ }
    if (!r.ok) {
      const detail = j?.errors?.map((e: any) => e.detail || e.title).join("; ") || text.slice(0, 300);
      const err: any = new Error(`PCO ${method} ${path} → ${r.status}: ${detail}`); err.status = r.status; throw err;
    }
    return j;
  }
  throw new Error(`PCO ${method} ${path}: rate-limited`);
}

async function ensureCampaign(db: SupabaseClient, settings: any): Promise<{ id: string; fund_id: string | null; created: boolean }> {
  if (settings.pco_campaign_id) return { id: String(settings.pco_campaign_id), fund_id: settings.pco_fund_id, created: false };
  const list = await pco("GET", "/giving/v2/pledge_campaigns?per_page=100&include=fund");
  const match = (list?.data || []).find((c: any) => String(c.attributes?.name || "").trim().toLowerCase() === CAMPAIGN_NAME.toLowerCase());
  if (!match) throw new HttpError(409, `No pledge campaign named "${CAMPAIGN_NAME}" in Planning Center Giving yet. Create it (Giving → Pledge Campaigns) and run sync again.`);
  const fundId = match.relationships?.fund?.data?.id || null;
  await db.from("pledge_settings").update({ pco_campaign_id: match.id, pco_fund_id: fundId }).eq("id", 1);
  return { id: match.id, fund_id: fundId, created: false };
}

function splitName(donor: string): { first: string; last: string } {
  let s = donor.replace(/\(.*?\)/g, " ").replace(/\s+/g, " ").trim();
  const fam = s.match(/^the\s+(.+?)\s+family$/i);
  if (fam) return { first: "The", last: `${fam[1]} Family` };
  const parts = s.split(/\s*(?:&|\band\b|,)\s*/i).map((x) => x.trim()).filter(Boolean);
  const primary = parts[0] || s;
  const lastTok = s.split(" ").pop() || "";
  const pt = primary.split(" ");
  if (pt.length >= 2) return { first: pt.slice(0, -1).join(" "), last: pt[pt.length - 1] };
  return { first: primary, last: parts.length > 1 ? lastTok : "" };
}

async function findPeopleByEmail(email: string): Promise<string[]> {
  const r = await pco("GET", `/people/v2/emails?where[address]=${encodeURIComponent(email)}&per_page=25`);
  const ids = new Set<string>();
  for (const e of r?.data || []) {
    if (String(e.attributes?.address || "").toLowerCase() !== email.toLowerCase()) continue;
    const pid = e.relationships?.person?.data?.id; if (pid) ids.add(String(pid));
  }
  return [...ids];
}

async function createPerson(p: any): Promise<string> {
  const { first, last } = splitName(p.donor_name || "");
  const created = await pco("POST", "/people/v2/people", { data: { type: "Person", attributes: { first_name: first || "Friend", last_name: last || "" } } });
  const pid = String(created.data.id);
  if (p.email) await pco("POST", `/people/v2/people/${pid}/emails`, { data: { type: "Email", attributes: { address: p.email, location: "Home", primary: true } } }).catch(() => null);
  if (p.phone) await pco("POST", `/people/v2/people/${pid}/phone_numbers`, { data: { type: "PhoneNumber", attributes: { number: p.phone, location: "Mobile", primary: true } } }).catch(() => null);
  if (p.address_line && p.city) await pco("POST", `/people/v2/people/${pid}/addresses`, { data: { type: "Address", attributes: { street_line_1: p.address_line, city: p.city, state: p.state || "", zip: p.postal || "", location: "Home", primary: true } } }).catch(() => null);
  return pid;
}

async function syncPledge(db: SupabaseClient, pledgeId: string, actor: string): Promise<Record<string, unknown>> {
  const { data: p } = await db.from("pledges").select("*").eq("id", pledgeId).single();
  if (!p) throw new HttpError(404, "pledge not found");
  const { data: settings } = await db.from("pledge_settings").select("*").eq("id", 1).single();
  const mark = async (patch: Record<string, unknown>) => { await db.from("pledges").update({ pco_synced_at: new Date().toISOString(), ...patch }).eq("id", pledgeId); };

  try {
    const amountCents = Math.round(Number(p.amount_total) * 100);
    const active = p.status === "active";

    if (!active) {
      if (p.pco_pledge_id && p.pco_person_id) {
        await pco("DELETE", `/giving/v2/people/${p.pco_person_id}/pledges/${p.pco_pledge_id}`).catch((e: any) => { if (e.status !== 404) throw e; });
      }
      await mark({ pco_pledge_id: null, pco_sync_status: "removed", pco_sync_error: null });
      return { status: "removed" };
    }

    const campaign = await ensureCampaign(db, settings);

    let personId: string | null = p.pco_person_id ? String(p.pco_person_id) : null;
    if (!personId) {
      if (!p.email) {
        await mark({ pco_sync_status: "needs_review", pco_sync_error: "No email on the pledge — pick or create the Planning Center person manually." });
        return { status: "needs_review", reason: "no_email" };
      }
      const ids = await findPeopleByEmail(p.email);
      if (ids.length > 1) {
        await mark({ pco_sync_status: "needs_review", pco_sync_error: `Email matches ${ids.length} people in Planning Center (ids ${ids.join(", ")}). Choose one in admin.`, pco_review: { candidates: ids } });
        return { status: "needs_review", candidates: ids };
      }
      personId = ids[0] || await createPerson(p);
    }

    if (p.pco_pledge_id) {
      try {
        await pco("PATCH", `/giving/v2/people/${personId}/pledges/${p.pco_pledge_id}`, { data: { type: "Pledge", attributes: { amount_cents: amountCents } } });
        await mark({ pco_person_id: personId, pco_sync_status: "synced", pco_sync_error: null, pco_review: null });
        return { status: "synced", action: "updated", person_id: personId, pledge_id: p.pco_pledge_id };
      } catch (e: any) { if (e.status !== 404) throw e; }
    }
    const created = await pco("POST", `/giving/v2/people/${personId}/pledges`, {
      data: { type: "Pledge", attributes: { amount_cents: amountCents, pledge_campaign_id: campaign.id } },
    });
    const pcoPledgeId = String(created.data.id);
    await mark({ pco_person_id: personId, pco_pledge_id: pcoPledgeId, pco_sync_status: "synced", pco_sync_error: null, pco_review: null });
    await db.from("pledge_revisions").insert({ pledge_id: pledgeId, actor, action: "pco_synced", before: null, after: { pco_person_id: personId, pco_pledge_id: pcoPledgeId } });
    return { status: "synced", action: "created", person_id: personId, pledge_id: pcoPledgeId };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 500);
    console.error("pco sync", pledgeId, msg);
    await mark({ pco_sync_status: "failed", pco_sync_error: msg });
    return { status: "failed", error: msg };
  }
}

async function pcoAll(path: string): Promise<any[]> {
  const out: any[] = []; let url: string | null = path; let guard = 0;
  while (url && guard++ < 50) {
    const r = await pco("GET", url);
    out.push(...(r?.data || []));
    const next = r?.links?.next as string | undefined;
    url = next ? next.replace(PCO, "") : null;
  }
  return out;
}
async function personSummary(pid: string): Promise<{ name: string; email: string | null; phone: string | null }> {
  const r = await pco("GET", `/people/v2/people/${pid}?include=emails,phone_numbers`);
  const a = r?.data?.attributes || {};
  const inc = (r?.included || []) as any[];
  const emails = inc.filter((i) => i.type === "Email"); const phones = inc.filter((i) => i.type === "PhoneNumber");
  const em = emails.find((e) => e.attributes?.primary) || emails[0];
  const ph = phones.find((e) => e.attributes?.primary) || phones[0];
  return { name: [a.first_name, a.last_name].filter(Boolean).join(" ") || a.name || `Person ${pid}`, email: em?.attributes?.address || null, phone: ph?.attributes?.number || null };
}
async function pullFromPco(db: SupabaseClient, actor: string) {
  const { data: settings } = await db.from("pledge_settings").select("*").eq("id", 1).single();
  const campaign = await ensureCampaign(db, settings);
  const remote = await pcoAll(`/giving/v2/pledge_campaigns/${campaign.id}/pledges?per_page=100`);
  const { data: local } = await db.from("pledges").select("id,ref_code,status,amount_total,pco_pledge_id,updated_at,source").not("pco_pledge_id", "is", null);
  const byPco = new Map((local || []).map((l: any) => [String(l.pco_pledge_id), l]));
  const seen = new Set<string>();
  const result = { created: [] as string[], updated: [] as string[], voided: [] as string[] };

  for (const r of remote) {
    const rid = String(r.id); seen.add(rid);
    const amount = (r.attributes?.amount_cents || 0) / 100;
    const pid = String(r.relationships?.person?.data?.id || "");
    const l = byPco.get(rid);
    if (l) {
      if (l.status === "active" && Number(l.amount_total) !== amount && new Date(r.attributes?.updated_at || 0) > new Date(l.updated_at)) {
        await db.from("pledges").update({ amount_total: amount, installment_amount: null }).eq("id", l.id);
        await db.from("pledge_revisions").insert({ pledge_id: l.id, actor, action: "amount_from_pco", before: { amount_total: l.amount_total }, after: { amount_total: amount } });
        result.updated.push(l.ref_code);
      }
      continue;
    }
    if (!pid || amount <= 0) continue;
    const who = await personSummary(pid);
    const { data: ins, error } = await db.from("pledges").insert({
      ref_code: await newRefCode(db), status: "active", source: "pco",
      donor_name: who.name, email: who.email, phone: who.phone,
      amount_total: amount, term_years: 5, frequency: "unspecified", installment_amount: null,
      pco_person_id: pid, pco_pledge_id: rid, pco_sync_status: "synced", pco_synced_at: new Date().toISOString(),
      created_by: "planning-center", admin_note: "Entered directly in Planning Center Giving. Set the schedule here if known.",
    }).select("ref_code").single();
    if (error) { console.error("pull insert", error.message); continue; }
    result.created.push(ins.ref_code);
  }
  for (const l of local || []) {
    if (l.status === "active" && !seen.has(String(l.pco_pledge_id))) {
      await db.from("pledges").update({ status: "void", admin_note: "Pledge was deleted in Planning Center Giving." }).eq("id", l.id);
      await db.from("pledge_revisions").insert({ pledge_id: l.id, actor, action: "voided_deleted_in_pco", before: { status: "active" }, after: { status: "void" } });
      result.voided.push(l.ref_code);
    }
  }
  return { remote: remote.length, ...result };
}
async function newRefCode(db: SupabaseClient): Promise<string> {
  const A = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  for (let i = 0; i < 8; i++) {
    const b = new Uint8Array(5); crypto.getRandomValues(b);
    const code = "MR-" + Array.from(b).map((x) => A[x % A.length]).join("");
    const { data } = await db.from("pledges").select("id").eq("ref_code", code).maybeSingle();
    if (!data) return code;
  }
  throw new Error("ref code");
}

async function pcoAllFull(path: string): Promise<{ data: any[]; included: any[] }> {
  const data: any[] = [], included: any[] = []; let url: string | null = path; let guard = 0;
  while (url && guard++ < 200) {
    const r = await pco("GET", url);
    data.push(...(r?.data || [])); included.push(...(r?.included || []));
    const next = r?.links?.next as string | undefined;
    url = next ? next.replace(PCO, "") : null;
  }
  return { data, included };
}
async function pullDonations(db: SupabaseClient) {
  const { data: settings } = await db.from("pledge_settings").select("*").eq("id", 1).single();
  const campaign = await ensureCampaign(db, settings);
  const c = await pco("GET", `/giving/v2/pledge_campaigns/${campaign.id}`);
  const startsAt: string = c?.data?.attributes?.starts_at || "2026-09-06T00:00:00Z";
  const fundId = String(campaign.fund_id || c?.data?.relationships?.fund?.data?.id || "");
  if (!fundId) throw new Error("campaign has no fund");

  const lastSync = settings.pco_donations_synced_at ? new Date(settings.pco_donations_synced_at) : null;
  const since = lastSync ? new Date(lastSync.getTime() - 3 * 86400e3).toISOString() : null;
  let path = `/giving/v2/donations?per_page=100&include=designations&order=received_at&where[received_at][gte]=${encodeURIComponent(startsAt)}`;
  if (since) path += `&where[updated_at][gte]=${encodeURIComponent(since)}`;
  let res: { data: any[]; included: any[] };
  try { res = await pcoAllFull(path); }
  catch (e: any) {
    if (e.status !== 400 && e.status !== 422) throw e;
    res = await pcoAllFull(`/giving/v2/donations?per_page=100&include=designations&order=received_at&where[received_at][gte]=${encodeURIComponent(startsAt)}`);
  }
  const des = new Map(res.included.filter((i) => i.type === "Designation").map((i) => [String(i.id), i]));

  const names = new Map<string, string>();
  const { data: pl } = await db.from("pledges").select("pco_person_id,donor_name").not("pco_person_id", "is", null);
  for (const p of pl || []) if (p.pco_person_id && !names.has(String(p.pco_person_id))) names.set(String(p.pco_person_id), p.donor_name);
  const { data: known } = await db.from("pledge_donations").select("pco_person_id,donor_name").not("donor_name", "is", null);
  for (const k of known || []) if (k.pco_person_id && !names.has(String(k.pco_person_id))) names.set(String(k.pco_person_id), k.donor_name);

  const rows: Record<string, unknown>[] = [];
  for (const d of res.data) {
    const a = d.attributes || {};
    const parts = (d.relationships?.designations?.data || []).map((x: any) => des.get(String(x.id))).filter(Boolean);
    const cents = parts.filter((x: any) => String(x.relationships?.fund?.data?.id) === fundId).reduce((s: number, x: any) => s + (x.attributes?.amount_cents || 0), 0);
    if (cents <= 0) continue;
    const pid = d.relationships?.person?.data?.id ? String(d.relationships.person.data.id) : null;
    let name = pid ? names.get(pid) : null;
    if (pid && !name) { try { name = (await personSummary(pid)).name; } catch { name = `Person ${pid}`; } names.set(pid, name!); }
    rows.push({
      pco_donation_id: String(d.id), pco_person_id: pid, donor_name: name || (pid ? null : "Anonymous / unassigned"),
      received_at: a.received_at || a.created_at, amount: cents / 100, total_amount: (a.amount_cents || 0) / 100,
      payment_method: a.payment_method || null, payment_status: a.payment_status || null, refunded: !!a.refunded,
      pco_updated_at: a.updated_at || null, synced_at: new Date().toISOString(),
    });
  }
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await db.from("pledge_donations").upsert(rows.slice(i, i + 200), { onConflict: "pco_donation_id" });
    if (error) throw new Error("donations upsert: " + error.message);
  }
  await db.from("pledge_settings").update({ pco_donations_synced_at: new Date().toISOString() }).eq("id", 1);
  return { scanned: res.data.length, fund_gifts: rows.length, incremental: !!since };
}

async function refreshTotals(db: SupabaseClient) {
  const { data: settings } = await db.from("pledge_settings").select("*").eq("id", 1).single();
  const campaign = await ensureCampaign(db, settings);
  const c = await pco("GET", `/giving/v2/pledge_campaigns/${campaign.id}`);
  const a = c?.data?.attributes || {};
  const totals = {
    received_from_pledges: (a.received_total_from_pledges_cents || 0) / 100,
    received_outside_pledges: (a.received_total_outside_of_pledges_cents || 0) / 100,
    received_total: ((a.received_total_from_pledges_cents || 0) + (a.received_total_outside_of_pledges_cents || 0)) / 100,
    pco_goal: (a.goal_cents || 0) / 100,
    starts_at: a.starts_at, ends_at: a.ends_at,
  };
  await db.from("pledge_settings").update({ pco_totals: totals, pco_totals_at: new Date().toISOString() }).eq("id", 1);
  return totals;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, req);
  const db = sb();
  try {
    const actor = await authorize(req);
    let body: Record<string, any> = {};
    try { body = await req.json(); } catch { /* empty */ }
    const action = String(body.action || "sync");

    if (action === "ping") {
      const [org, funds, campaigns] = await Promise.all([
        pco("GET", "/giving/v2"), pco("GET", "/giving/v2/funds?per_page=100"), pco("GET", "/giving/v2/pledge_campaigns?per_page=100&include=fund"),
      ]);
      return json({
        ok: true,
        organization: org?.data?.attributes?.name || org?.data?.id || null,
        funds: (funds?.data || []).map((f: any) => ({ id: f.id, name: f.attributes?.name, visibility: f.attributes?.visibility, default: f.attributes?.default })),
        campaigns: (campaigns?.data || []).map((c: any) => ({ id: c.id, name: c.attributes?.name, goal: (c.attributes?.goal_cents || 0) / 100, starts_at: c.attributes?.starts_at, ends_at: c.attributes?.ends_at, fund_id: c.relationships?.fund?.data?.id, show_goal: c.attributes?.show_goal_in_church_center })),
      }, 200, req);
    }

    if (action === "sync") {
      const id = String(body.pledge_id || body.record?.id || "");
      if (!id) throw new HttpError(400, "pledge_id required");
      if (body.pco_person_id) await db.from("pledges").update({ pco_person_id: String(body.pco_person_id), pco_sync_status: null, pco_sync_error: null, pco_review: null }).eq("id", id);
      return json({ ok: true, result: await syncPledge(db, id, actor) }, 200, req);
    }

    if (action === "reconcile") {
      const { data: rows } = await db.from("pledges").select("id,status,pco_pledge_id,pco_sync_status")
        .or("pco_sync_status.is.null,pco_sync_status.eq.failed,and(status.eq.active,pco_pledge_id.is.null),and(status.neq.active,pco_pledge_id.not.is.null)");
      const results: Record<string, unknown>[] = [];
      for (const r of rows || []) {
        if (r.pco_sync_status === "needs_review") continue;
        results.push({ id: r.id, ...(await syncPledge(db, r.id, actor)) });
      }
      let pulled = null; try { pulled = await pullFromPco(db, actor); } catch (e) { console.error("pull", e); }
      let donations = null; try { donations = await pullDonations(db); } catch (e) { console.error("donations", e); }
      let totals = null; try { totals = await refreshTotals(db); } catch (e) { console.error("totals", e); }
      return json({ ok: true, processed: results.length, results, pulled, donations, totals }, 200, req);
    }

    if (action === "totals") return json({ ok: true, totals: await refreshTotals(db) }, 200, req);

    if (action === "pull") {
      const pulled = await pullFromPco(db, actor);
      let donations = null; try { donations = await pullDonations(db); } catch (e) { console.error("donations", e); donations = { error: String((e as Error)?.message || e) }; }
      let totals = null; try { totals = await refreshTotals(db); } catch (e) { console.error("totals", e); }
      return json({ ok: true, pulled, donations, totals }, 200, req);
    }

    if (action === "pull_donations") return json({ ok: true, donations: await pullDonations(db) }, 200, req);

    if (action === "collections") {
      const [{ data: donations }, { data: settings }] = await Promise.all([
        db.from("pledge_donations").select("*").order("received_at", { ascending: false }),
        db.from("pledge_settings").select("pco_totals,pco_totals_at,pco_donations_synced_at,pco_campaign_id,pco_fund_id").eq("id", 1).single(),
      ]);
      return json({ ok: true, donations: donations || [], settings }, 200, req);
    }

    if (action === "inspect") {
      const { data: settings } = await db.from("pledge_settings").select("*").eq("id", 1).single();
      const campaign = await ensureCampaign(db, settings);
      const [c, pl, dn] = await Promise.all([
        pco("GET", `/giving/v2/pledge_campaigns/${campaign.id}?include=fund`),
        pco("GET", `/giving/v2/pledge_campaigns/${campaign.id}/pledges?per_page=50&include=joint_giver`).catch((e: any) => ({ error: e.message })),
        pco("GET", `/giving/v2/donations?order=-received_at&per_page=${Number(body.limit) || 8}&include=designations,person`).catch((e: any) => ({ error: e.message })),
      ]);
      const inc = (dn?.included || []) as any[];
      const donations = (dn?.data || []).map((d: any) => ({
        id: d.id, received_at: d.attributes?.received_at, created_at: d.attributes?.created_at, amount: (d.attributes?.amount_cents || 0) / 100,
        payment_status: d.attributes?.payment_status, payment_method: d.attributes?.payment_method, refunded: d.attributes?.refunded,
        person_id: d.relationships?.person?.data?.id,
        person: (() => { const pid = d.relationships?.person?.data?.id; const p = inc.find((i) => i.type === "Person" && i.id === pid); return p ? `${p.attributes?.first_name} ${p.attributes?.last_name}` : null; })(),
        designations: (d.relationships?.designations?.data || []).map((x: any) => { const des = inc.find((i) => i.type === "Designation" && i.id === x.id); return des ? { amount: (des.attributes?.amount_cents || 0) / 100, fund_id: des.relationships?.fund?.data?.id } : x.id; }),
      }));
      return json({
        ok: true,
        campaign: { id: c?.data?.id, ...(c?.data?.attributes || {}), fund_id: c?.data?.relationships?.fund?.data?.id },
        pledges: pl?.error ? pl : (pl?.data || []).map((x: any) => ({ id: x.id, person_id: x.relationships?.person?.data?.id, ...(x.attributes || {}) })),
        donations: dn?.error ? dn : donations,
      }, 200, req);
    }

    throw new HttpError(400, "unknown action");
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("pledge-pco-sync", e);
    return json({ error: String((e as Error)?.message || e) }, status, req);
  }
});
