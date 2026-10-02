import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";
import fontkit from "https://esm.sh/@pdf-lib/fontkit@1.1.1";
import { encodeBase64, decodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";
import { encodeBase64Url } from "https://deno.land/std@0.224.0/encoding/base64url.ts";
import { fillPledgeCard, installmentFor, money, FREQUENCIES, longDate } from "./pledge-card.js";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
export const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
export const FROM = Deno.env.get("PLEDGE_FROM") || "Shepherd Church <prayer@nwiprays.com>";
export const SITE_URL = (Deno.env.get("PLEDGE_SITE_URL") || "https://pledge.shepherdchurch.co").replace(/\/$/, "");
export const ASSET_URL = (Deno.env.get("PLEDGE_ASSET_URL") || "https://shepherd-pledge.netlify.app").replace(/\/$/, "");
export const GIVING_URL = "https://shepherd-church-nwi.churchcenter.com/giving/to/building";
export const ENTITY = "Shepherd Church NWI Inc.";

const ALLOWED_ORIGINS = [
  "https://pledge.shepherdchurch.co",
  "https://shepherd-pledge.netlify.app",
];

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const ok = ALLOWED_ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization,content-type,apikey,x-client-info",
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
export function json(body: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...corsHeaders(req) },
  });
}
export class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export function admin(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
}

export function newToken(): string {
  const b = new Uint8Array(32); crypto.getRandomValues(b); return encodeBase64Url(b);
}
export async function hashToken(t: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export async function newRefCode(sb: SupabaseClient): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const b = new Uint8Array(5); crypto.getRandomValues(b);
    const code = "MR-" + Array.from(b).map((x) => ALPHABET[x % ALPHABET.length]).join("");
    const { data } = await sb.from("pledges").select("id").eq("ref_code", code).maybeSingle();
    if (!data) return code;
  }
  throw new HttpError(500, "Could not allocate a reference code");
}

export async function rateLimit(sb: SupabaseClient, key: string, limit: number, windowSec: number) {
  const now = Date.now();
  const { data } = await sb.from("pledge_rate_limit").select("*").eq("key", key).maybeSingle();
  if (!data || now - new Date(data.window_start).getTime() > windowSec * 1000) {
    await sb.from("pledge_rate_limit").upsert({ key, window_start: new Date(now).toISOString(), count: 1 });
    return;
  }
  if (data.count >= limit) throw new HttpError(429, "Too many requests — please wait a bit and try again.");
  await sb.from("pledge_rate_limit").update({ count: data.count + 1 }).eq("key", key);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v: unknown, max: number) => (v == null ? "" : String(v)).trim().slice(0, max);

export type PledgeInput = {
  donor_name: string; email: string | null; phone: string | null;
  address_line: string | null; city: string | null; state: string | null; postal: string | null;
  amount_total: number; term_years: number; frequency: string; installment_amount: number | null;
  start_date: string | null; note: string | null;
  recurring_setup: boolean; recurring_method: string | null; first_gift_amount: number | null;
  signature_png?: string | null; signature_kind?: string | null; signed_name?: string | null;
};

export function cleanPledge(body: Record<string, unknown>, opts: { requireEmail: boolean }): PledgeInput {
  const donor_name = str(body.donor_name, 120);
  if (donor_name.length < 2) throw new HttpError(400, "Please enter your name.");
  const email = str(body.email, 200).toLowerCase() || null;
  if (opts.requireEmail && !email) throw new HttpError(400, "Please enter your email.");
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, "Please enter a valid email address.");
  const amount_total = Math.round(Number(body.amount_total) * 100) / 100;
  if (!(amount_total > 0)) throw new HttpError(400, "Please enter your pledge amount.");
  if (amount_total > 5_000_000) throw new HttpError(400, "That amount is above what we can accept online.");
  const term_years = Number(body.term_years) || 5;
  if (!Number.isInteger(term_years) || term_years < 1 || term_years > 5) throw new HttpError(400, "Term must be 1–5 years.");
  const frequency = str(body.frequency, 20);
  if (!(frequency in FREQUENCIES)) throw new HttpError(400, "Please choose how you'd like to give.");
  let start_date: string | null = str(body.start_date, 10) || null;
  if (start_date && !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) start_date = null;
  return {
    donor_name, email,
    phone: str(body.phone, 40) || null,
    address_line: str(body.address_line, 160) || null,
    city: str(body.city, 80) || null,
    state: str(body.state, 40) || null,
    postal: str(body.postal, 20) || null,
    amount_total, term_years, frequency,
    installment_amount: installmentFor(amount_total, term_years, frequency),
    start_date,
    note: str(body.note, 2000) || null,
    recurring_setup: body.recurring_setup === true,
    recurring_method: body.recurring_setup === true && ["ach", "card"].includes(String(body.recurring_method)) ? String(body.recurring_method) : null,
    first_gift_amount: Number(body.first_gift_amount) > 0 ? Math.round(Number(body.first_gift_amount) * 100) / 100 : null,
  };
}

export function cleanSignature(body: Record<string, unknown>) {
  const signed_name = str(body.signed_name, 120);
  if (signed_name.length < 2) throw new HttpError(400, "Please type your full name.");
  const png = String(body.signature_png || "");
  if (!png.startsWith("data:image/png;base64,")) throw new HttpError(400, "Please sign your pledge.");
  if (png.length > 400_000) throw new HttpError(400, "Signature image is too large — please clear and sign again.");
  if (body.ack !== true) throw new HttpError(400, "Please read and check the pledge statement.");
  const kind = body.signature_kind === "typed" ? "typed" : "drawn";
  return { signature_png: png, signature_kind: kind, signed_name };
}

export const COMMITMENT_FIELDS = ["amount_total", "term_years", "frequency"] as const;

export function safePledge(p: Record<string, unknown>) {
  const { manage_token_hash: _h, signed_ip: _i, signed_user_agent: _u, admin_note: _a, created_by: _c, email_lower: _e, ...rest } = p;
  return rest;
}

export async function logRevision(sb: SupabaseClient, pledge_id: string, actor: string, action: string, before: unknown, after: unknown) {
  const strip = (x: any) => { if (!x) return x; const { signature_png: _s, manage_token_hash: _h, ...r } = x; return r; };
  await sb.from("pledge_revisions").insert({ pledge_id, actor, action, before: strip(before), after: strip(after) });
}

let assetCache: { tpl: ArrayBuffer; fonts: Record<string, ArrayBuffer | null> } | null = null;
async function loadAssets() {
  if (assetCache) return assetCache;
  const get = async (p: string) => { const r = await fetch(`${ASSET_URL}${p}`); if (!r.ok) throw new Error(`asset ${p} ${r.status}`); return r.arrayBuffer(); };
  const opt = (p: string) => get(p).catch(() => null);
  const [tpl, montserrat, lato, latoBold, latoItalic] = await Promise.all([
    get("/assets/pledge-card-template.pdf"),
    opt("/assets/fonts/Montserrat-ExtraBold.ttf"), opt("/assets/fonts/Lato-Regular.ttf"), opt("/assets/fonts/Lato-Bold.ttf"), opt("/assets/fonts/Lato-Italic.ttf"),
  ]);
  assetCache = { tpl, fonts: { montserrat, lato, latoBold, latoItalic } };
  return assetCache;
}
export async function buildCardPdf(p: Record<string, any>): Promise<Uint8Array> {
  const { tpl, fonts } = await loadAssets();
  const sig = p.signature_png ? decodeBase64(String(p.signature_png).split(",")[1] || "") : null;
  return fillPledgeCard({ PDFLib: { PDFDocument, rgb, StandardFonts }, fontkit, templateBytes: tpl, fonts, pledge: p, signaturePng: sig });
}

export type EmailKind = "confirm" | "updated" | "link" | "withdrawn" | "admin_added";

function esc(s: unknown) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

function summaryHtml(p: Record<string, any>) {
  const f = (FREQUENCIES as any)[p.frequency] || FREQUENCIES.monthly;
  const inst = installmentFor(p.amount_total, p.term_years, p.frequency);
  const rows: [string, string][] = [
    ["Reference", p.ref_code],
    ["Total pledge", money(p.amount_total)],
  ];
  if (p.frequency === "one_time") rows.push(["Schedule", "One-time gift"]);
  else rows.push(["Schedule", `${f.label} · about ${money(inst)} per ${f.per}`], ["Term", `${p.term_years} year${p.term_years > 1 ? "s" : ""}`]);
  if (p.start_date) rows.push(["Start", longDate(p.start_date + "T12:00:00")]);
  if (p.recurring_setup) rows.push(["Recurring giving", p.recurring_method === "ach" ? "Yes — bank draft (ACH)" : p.recurring_method === "card" ? "Yes — card" : "Yes"]);
  if (Number(p.first_gift_amount) > 0) rows.push(["First gift", money(p.first_gift_amount)]);
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:2px solid #1B2027;margin:18px 0 22px">${
    rows.map(([k, v]) => `<tr><td style="padding:11px 0;border-bottom:1px solid #DCE2EA;font-family:Montserrat,Arial,sans-serif;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#626F86;width:38%">${esc(k)}</td><td style="padding:11px 0;border-bottom:1px solid #DCE2EA;font-family:Lato,Arial,sans-serif;font-size:16px;color:#1B2027;font-weight:700">${esc(v)}</td></tr>`).join("")
  }</table>`;
}

function shell(kicker: string, title: string, body: string, cta: { label: string; url: string } | null, secondary: { label: string; url: string } | null, contact: string | null) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#F6F6FF;font-family:Lato,Arial,sans-serif;color:#1B2027;-webkit-font-smoothing:antialiased">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F6F6FF;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff">
  <tr><td style="background:#1B2027;padding:22px 28px;border-top:4px solid #FF4018">
    <p style="margin:0;font-family:Montserrat,Arial,sans-serif;font-weight:700;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#FF4018">${esc(kicker)}</p>
    <p style="margin:6px 0 0;font-family:Montserrat,Arial,sans-serif;font-weight:800;font-size:22px;letter-spacing:-.01em;text-transform:uppercase;color:#fff">Making Room</p>
  </td></tr>
  <tr><td style="padding:30px 28px 8px">
    <h1 style="margin:0 0 14px;font-family:Montserrat,Arial,sans-serif;font-weight:800;font-size:26px;line-height:1.1;color:#1B2027">${esc(title)}</h1>
    ${body}
    ${cta ? `<p style="margin:22px 0 10px"><a href="${esc(cta.url)}" style="display:inline-block;background:#FF4018;color:#fff;text-decoration:none;padding:14px 24px;font-family:Montserrat,Arial,sans-serif;font-weight:600;font-size:14px">${esc(cta.label)}</a></p>` : ""}
    ${secondary ? `<p style="margin:0 0 18px"><a href="${esc(secondary.url)}" style="display:inline-block;border:2px solid #1B2027;color:#1B2027;text-decoration:none;padding:12px 22px;font-family:Montserrat,Arial,sans-serif;font-weight:600;font-size:14px">${esc(secondary.label)}</a></p>` : ""}
  </td></tr>
  <tr><td style="padding:10px 28px 30px;font-size:13px;line-height:1.6;color:#626F86">
    ${contact ? `<p style="margin:0 0 10px">Questions? Reply to this email or write to <a href="mailto:${esc(contact)}" style="color:#1B2027">${esc(contact)}</a>.</p>` : `<p style="margin:0 0 10px">Questions? Just reply to this email.</p>`}
    <p style="margin:0">A pledge is a commitment made prayerfully and in faith, not a legally enforceable obligation. ${esc(ENTITY)} is a 501(c)(3) nonprofit; gifts are tax-deductible to the extent allowed by law.</p>
  </td></tr>
  <tr><td style="background:#1B2027;padding:18px 28px;color:#CBD5E0;font-size:12px">${esc(ENTITY)} · Hobart, Indiana · <a href="https://shepherdchurch.co" style="color:#fff">shepherdchurch.co</a></td></tr>
</table></td></tr></table></body></html>`;
}

export function renderEmail(kind: EmailKind, p: Record<string, any>, manageUrl: string | null, contact: string | null): { subject: string; html: string; text: string } {
  const first = String(p.donor_name || "").split(/[,&]| and /)[0].trim();
  const manage = manageUrl ? { label: "Review or change my pledge", url: manageUrl } : null;
  const give = { label: "Give now", url: GIVING_URL };
  const sum = summaryHtml(p);
  const f = (FREQUENCIES as any)[p.frequency] || FREQUENCIES.monthly;
  const inst = installmentFor(p.amount_total, p.term_years, p.frequency);
  const line = p.frequency === "one_time" ? `a one-time gift of ${money(p.amount_total)}` : `${money(p.amount_total)} over ${p.term_years} year${p.term_years > 1 ? "s" : ""} (about ${money(inst)} per ${f.per})`;
  const textTail = `\n\nReference: ${p.ref_code}\n${manageUrl ? `Review or change your pledge: ${manageUrl}\n` : ""}Give: ${GIVING_URL}\n\n${ENTITY} · Hobart, Indiana`;

  switch (kind) {
    case "confirm":
      return {
        subject: `Thank you — your Making Room pledge (${p.ref_code})`,
        html: shell("Pledge received", `Thank you, ${first}.`,
          `<p style="margin:0 0 12px;font-size:16px;line-height:1.6">Your pledge is recorded. Together we're putting down roots — purchasing a permanent home for Shepherd Church and the generations who'll gather here.</p>${sum}<p style="margin:0;font-size:15px;line-height:1.6;color:#626F86">Your signed pledge card is attached. Keep the link below — it's private to you and lets you review or change your pledge at any time.</p>`,
          give, manage, contact),
        text: `Thank you, ${first}.\n\nYour Making Room pledge is recorded: ${line}.${textTail}`,
      };
    case "updated":
      return {
        subject: `Your Making Room pledge was updated (${p.ref_code})`,
        html: shell("Pledge updated", `Updated, ${first}.`,
          `<p style="margin:0 0 12px;font-size:16px;line-height:1.6">Here's your pledge as it stands now. An updated pledge card is attached.</p>${sum}`,
          manage, give, contact),
        text: `Your Making Room pledge was updated: ${line}.${textTail}`,
      };
    case "withdrawn":
      return {
        subject: `Your Making Room pledge was withdrawn (${p.ref_code})`,
        html: shell("Pledge withdrawn", `We've withdrawn your pledge, ${first}.`,
          `<p style="margin:0 0 12px;font-size:16px;line-height:1.6">No hard feelings — seasons change. If this was a mistake, or you'd like to pledge again later, the link below restores it.</p>`,
          manage, null, contact),
        text: `Your Making Room pledge (${p.ref_code}) has been withdrawn. Restore it: ${manageUrl || ""}${textTail}`,
      };
    case "link":
      return {
        subject: `Your private Making Room pledge link (${p.ref_code})`,
        html: shell("Your pledge", `Here's your link, ${first}.`,
          `<p style="margin:0 0 12px;font-size:16px;line-height:1.6">Use the button below to review or change your pledge. This link is private to you; any older links no longer work.</p>${sum}`,
          manage, give, contact),
        text: `Review or change your Making Room pledge: ${manageUrl}${textTail}`,
      };
    case "admin_added":
      return {
        subject: `Your Making Room pledge is recorded (${p.ref_code})`,
        html: shell("Pledge recorded", `Thank you, ${first}.`,
          `<p style="margin:0 0 12px;font-size:16px;line-height:1.6">Shepherd Church has recorded your Making Room pledge. Here's a summary, with your pledge card attached.</p>${sum}<p style="margin:0;font-size:15px;line-height:1.6;color:#626F86">If anything needs correcting, use the link below — it's private to you.</p>`,
          manage, give, contact),
        text: `Shepherd Church recorded your Making Room pledge: ${line}.${textTail}`,
      };
  }
}

export async function sendPledgeEmail(sb: SupabaseClient, kind: EmailKind, p: Record<string, any>, token: string | null, opts: { attachCard?: boolean } = {}) {
  if (!p.email) return { ok: false, error: "no email" };
  if (!RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY not set" };
  const { data: settings } = await sb.from("pledge_settings").select("contact_email").eq("id", 1).maybeSingle();
  const contact = settings?.contact_email || null;
  const manageUrl = token ? `${SITE_URL}/manage?t=${encodeURIComponent(token)}` : null;
  const { subject, html, text } = renderEmail(kind, p, manageUrl, contact);
  const payload: Record<string, unknown> = { from: FROM, to: [p.email], subject, html, text };
  if (contact) payload.reply_to = contact;
  if (opts.attachCard) {
    try {
      const pdf = await buildCardPdf(p);
      payload.attachments = [{ filename: `Making Room Pledge - ${p.ref_code}.pdf`, content: encodeBase64(pdf) }];
    } catch (e) { console.error("card pdf failed", e); }
  }
  let status = "sent", resend_id: string | null = null, error: string | null = null;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { status = "failed"; error = `${r.status} ${JSON.stringify(j).slice(0, 400)}`; }
    else resend_id = j.id || null;
  } catch (e) { status = "failed"; error = String(e).slice(0, 400); }
  await sb.from("pledge_email_log").insert({ pledge_id: p.id, to_email: p.email, kind, status, resend_id, error });
  return { ok: status === "sent", error };
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try { return (await req.json()) || {}; } catch { throw new HttpError(400, "Invalid JSON"); }
}
