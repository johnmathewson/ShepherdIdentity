// send-devotional-email (v6)
// Pulls today's devotional, emails opted-in members via Resend.
//
// Auth: accepts EITHER
//  - a service_role JWT (validated by decoding payload + verifying it
//    actually works against Supabase, NOT by string-comparing to env
//    — robust across key rotations)
//  - a logged-in admin user JWT (for in-app manual test sends).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encodeBase64Url } from "https://deno.land/std@0.224.0/encoding/base64url.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM = Deno.env.get("DEVOTIONAL_FROM") || "Shepherd Daily Devotional <prayer@nwiprays.com>";
const SUBJECT_PREFIX = Deno.env.get("DEVOTIONAL_SUBJECT_PREFIX") || "Shepherd Daily Devotional";
const APP_URL = Deno.env.get("DEVOTIONAL_APP_URL") || "https://shepherd-identity-tool.netlify.app";
const UNSUBSCRIBE_BASE = `${SUPABASE_URL}/functions/v1/devotional-unsubscribe`;

function corsHeaders(req: Request): Record<string, string> {
  const reqHdrs = req.headers.get("access-control-request-headers")
    || "authorization,content-type,apikey,x-client-info,x-supabase-api-version";
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": reqHdrs,
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
}
function jsonResp(body: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(req) },
  });
}

function todayInEastern(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Indiana/Indianapolis",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function esc(s: unknown): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

async function unsubToken(userId: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(SERVICE_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(userId));
  return encodeBase64Url(new Uint8Array(sig));
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
    return JSON.parse(atob(padded));
  } catch (_e) { return null; }
}

function renderMarkdownLite(text: string): string {
  if (!text) return "";
  const escaped = esc(text);
  const inline = (s: string) => s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return escaped.split(/\n\s*\n/).map((block: string) => {
    const lines = block.split("\n");
    const allBullets = lines.every((l: string) => /^\s*-\s+/.test(l));
    if (allBullets && lines.length > 0) {
      const items = lines.map((l: string) =>
        `<li style="margin-bottom:6px;line-height:1.65;color:#3a3a3a;">${inline(l.replace(/^\s*-\s+/, ""))}</li>`
      ).join("");
      return `<ul style="margin:14px 0;padding-left:22px;">${items}</ul>`;
    }
    return `<p style="margin:0 0 14px;line-height:1.7;color:#3a3a3a;font-size:15px;">${lines.map(inline).join("<br>")}</p>`;
  }).join("");
}

type Dev = {
  id: string; publish_date: string; title: string; teaser: string | null;
  scripture_ref: string | null; scripture_text: string | null;
  body: string | null; worship_video_url: string | null;
  sermon_video_url: string | null; author: string | null;
};

function renderEmailHtml(d: Dev, unsubscribeUrl: string): string {
  const [y, m, day] = d.publish_date.split("-").map(Number);
  const dateLabel = new Date(y, m - 1, day).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });

  let scripture = "";
  if (d.scripture_text || d.scripture_ref) {
    scripture = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">` +
      `<tr><td style="background:#f4f1ec;border-left:3px solid #b9a36a;border-radius:6px;padding:16px 18px;">` +
      (d.scripture_text ? `<p style="margin:0 0 6px;font-size:16px;line-height:1.7;color:#3a3a3a;font-style:italic;">${esc(d.scripture_text)}</p>` : "") +
      (d.scripture_ref ? `<p style="margin:0;font-size:13px;color:#7a6a4f;font-weight:500;letter-spacing:0.03em;">${esc(d.scripture_ref)}</p>` : "") +
      `</td></tr></table>`;
  }

  const videos: { label: string; url: string }[] = [];
  if (d.worship_video_url) videos.push({ label: "Worship video", url: d.worship_video_url });
  if (d.sermon_video_url) videos.push({ label: "Sermon clip", url: d.sermon_video_url });
  const videoLinks = videos.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 0;">` +
        videos.map(v =>
          `<tr><td style="padding:6px 0;"><a href="${esc(v.url)}" style="display:inline-block;color:#5e7c70;text-decoration:none;font-size:14px;font-weight:500;border:1px solid #d4d8d1;border-radius:6px;padding:10px 18px;">▶ ${esc(v.label)}</a></td></tr>`
        ).join("") +
      `</table>`
    : "";

  const teaser = d.teaser ? `<p style="margin:0 0 22px;font-size:15px;color:#5a5a5a;line-height:1.65;font-style:italic;">${esc(d.teaser)}</p>` : "";
  const body = renderMarkdownLite(d.body || "");
  const author = d.author ? `<p style="margin:24px 0 0;text-align:right;color:#8a8a8a;font-size:13px;font-style:italic;">— ${esc(d.author)}</p>` : "";

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(d.title)}</title></head>
<body style="margin:0;padding:0;background:#f6f4ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#2a2a2a;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ee;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
        <tr><td style="background:#1c1f26;padding:22px 28px;">
          <p style="margin:0;color:#cfd2cd;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.14em;">Shepherd Daily Devotional</p>
          <p style="margin:4px 0 0;color:#9da3a0;font-size:12px;letter-spacing:0.03em;">Shepherd Formation · Know Who You Are</p>
        </td></tr>
        <tr><td style="padding:30px 28px 8px;">
          <p style="margin:0 0 8px;color:#8a8a8a;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;font-weight:500;">${esc(dateLabel)}</p>
          <h1 style="margin:0 0 18px;font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.2;color:#1c1f26;font-weight:400;">${esc(d.title)}</h1>
          ${teaser}
          ${scripture}
          ${body}
          ${videoLinks}
          ${author}
        </td></tr>
        <tr><td style="padding:24px 28px 30px;">
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto;"><tr><td>
            <a href="${esc(APP_URL)}" style="display:inline-block;background:#718e82;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:24px;font-size:14px;font-weight:500;">Open in Shepherd Formation →</a>
          </td></tr></table>
        </td></tr>
        <tr><td style="background:#f4f1ec;padding:20px 28px;text-align:center;border-top:1px solid #e6e0d6;">
          <p style="margin:0 0 8px;color:#7a7a7a;font-size:12px;line-height:1.55;">You're receiving Shepherd Daily Devotional because you signed up for Shepherd Formation at Shepherd Church NWI.</p>
          <p style="margin:0;font-size:12px;"><a href="${esc(unsubscribeUrl)}" style="color:#7a7a7a;text-decoration:underline;">Unsubscribe from daily devotional emails</a></p>
          <p style="margin:10px 0 0;color:#a8a8a8;font-size:11px;">Shepherd Church NWI · Northwest Indiana</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function renderEmailText(d: Dev): string {
  const [y, m, day] = d.publish_date.split("-").map(Number);
  const dateLabel = new Date(y, m - 1, day).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const lines: string[] = [
    "SHEPHERD DAILY DEVOTIONAL", "",
    dateLabel.toUpperCase(), "",
    d.title || "Daily Devotional", "",
  ];
  if (d.teaser) lines.push(d.teaser, "");
  if (d.scripture_text) {
    lines.push(`"${d.scripture_text}"`);
    if (d.scripture_ref) lines.push(`— ${d.scripture_ref}`);
    lines.push("");
  }
  if (d.body) lines.push(d.body, "");
  if (d.worship_video_url) lines.push(`Worship: ${d.worship_video_url}`);
  if (d.sermon_video_url) lines.push(`Sermon Clip: ${d.sermon_video_url}`);
  if (d.author) lines.push("", `— ${d.author}`);
  lines.push("", `Open in the app: ${APP_URL}`);
  return lines.join("\n");
}

async function isAuthorized(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/, "");
  if (!token) return false;

  const payload = decodeJwtPayload(token);

  // Path 1: a Supabase service_role token. Validate by attempting a
  // privileged read; the Supabase gateway rejects forged/expired JWTs.
  if (payload && payload.role === "service_role" && payload.iss === "supabase") {
    try {
      const sb = createClient(SUPABASE_URL, token, { auth: { persistSession: false } });
      const { error } = await sb.from("profiles").select("id", { count: "exact", head: true });
      if (!error) return true;
    } catch (_e) { /* fall through */ }
  }

  // Path 2: admin user JWT (for in-app test sends from the admin section)
  if (!ANON_KEY) return false;
  try {
    const userSupa = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false },
    });
    const { data: { user }, error: userErr } = await userSupa.auth.getUser();
    if (userErr || !user) return false;
    const supaAdmin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { data: profile } = await supaAdmin
      .from("profiles").select("role").eq("id", user.id).single();
    return profile?.role === "admin";
  } catch (_e) {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(req) });
  }

  try {
    if (!await isAuthorized(req)) {
      return jsonResp({ error: "unauthorized" }, 401, req);
    }
    if (!RESEND_API_KEY) {
      return jsonResp({ error: "RESEND_API_KEY not configured. Set it in Supabase secrets." }, 500, req);
    }

    const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    let bodyJson: Record<string, unknown> | null = null;
    try { bodyJson = await req.json(); } catch { /* no body is fine */ }
    const overrideDate = bodyJson?.date as string | undefined;
    const targetDate = overrideDate || todayInEastern();
    const dryRun = Boolean(bodyJson?.dry_run);
    const testEmail = bodyJson?.test_email as string | undefined;

    const { data: dev, error: devErr } = await supa
      .from("devotionals").select("*")
      .eq("publish_date", targetDate)
      .eq("published", true)
      .maybeSingle();
    if (devErr) throw devErr;
    if (!dev) {
      return jsonResp({ ok: true, message: `No devotional for ${targetDate}; nothing to send.` }, 200, req);
    }

    type Recipient = { user_id: string; email: string; display_name: string | null };
    let recipients: Recipient[];
    if (testEmail) {
      recipients = [{ user_id: "00000000-0000-0000-0000-000000000000", email: testEmail, display_name: "Test" }];
    } else {
      const { data: r, error: rErr } = await supa.rpc("devotional_email_recipients", { p_devotional_id: dev.id });
      if (rErr) throw rErr;
      recipients = (r as Recipient[]) || [];
    }

    if (recipients.length === 0) {
      return jsonResp({
        ok: true, message: "No eligible recipients.",
        devotional: { id: dev.id, title: dev.title, publish_date: dev.publish_date },
      }, 200, req);
    }

    const sent: string[] = [];
    const failed: { email: string; error: string }[] = [];
    const chunkSize = 100;
    const subject = `${SUBJECT_PREFIX} — ${dev.title || "Today’s Devotional"}`;

    for (let i = 0; i < recipients.length; i += chunkSize) {
      const chunk = recipients.slice(i, i + chunkSize);
      const batchPayload = await Promise.all(chunk.map(async (rec: Recipient) => {
        const t = await unsubToken(rec.user_id);
        const unsubscribeUrl = `${UNSUBSCRIBE_BASE}?u=${rec.user_id}&t=${t}`;
        return {
          from: FROM,
          to: [rec.email],
          subject,
          html: renderEmailHtml(dev, unsubscribeUrl),
          text: renderEmailText(dev),
          headers: {
            "List-Unsubscribe": `<${unsubscribeUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        };
      }));

      if (dryRun) {
        for (const rec of chunk) sent.push(rec.email);
        continue;
      }

      const resp = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batchPayload),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        for (const rec of chunk) {
          failed.push({ email: rec.email, error: `${resp.status} ${errText.slice(0, 300)}` });
          if (!testEmail) {
            await supa.from("devotional_email_log").insert({
              devotional_id: dev.id, user_id: rec.user_id, email: rec.email,
              status: "failed", error: `${resp.status} ${errText.slice(0, 500)}`,
            });
          }
        }
        continue;
      }

      const result = await resp.json();
      const data = (result.data || []) as { id?: string }[];
      for (let j = 0; j < chunk.length; j++) {
        const rec = chunk[j];
        const r = data[j] || {};
        if (r.id) {
          sent.push(rec.email);
          if (!testEmail) {
            await supa.from("devotional_email_log").insert({
              devotional_id: dev.id, user_id: rec.user_id, email: rec.email,
              status: "sent", resend_id: r.id,
            });
          }
        } else {
          failed.push({ email: rec.email, error: JSON.stringify(r) });
          if (!testEmail) {
            await supa.from("devotional_email_log").insert({
              devotional_id: dev.id, user_id: rec.user_id, email: rec.email,
              status: "failed", error: JSON.stringify(r).slice(0, 500),
            });
          }
        }
      }
    }

    return jsonResp({
      ok: true,
      devotional: { id: dev.id, title: dev.title, publish_date: dev.publish_date },
      sent: sent.length,
      failed: failed.length,
      failures: failed.slice(0, 10),
      dry_run: dryRun,
      test_email: testEmail || null,
    }, 200, req);
  } catch (e) {
    console.error("send-devotional-email:", e);
    return jsonResp({ error: String((e as Error)?.message || e) }, 500, req);
  }
});
