// devotional-unsubscribe
// One-click HMAC-verified unsubscribe link. Email footers point here.
// Verifies the token, flips profiles.devotional_email_opt_in to false,
// and renders a friendly confirmation page.
//
// URL shape: GET /functions/v1/devotional-unsubscribe?u=<user_id>&t=<token>
// POST is also supported for RFC 8058 one-click email-client unsubscribe.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encodeBase64Url } from "https://deno.land/std@0.224.0/encoding/base64url.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_URL = Deno.env.get("DEVOTIONAL_APP_URL") || "https://shepherd-identity-tool.netlify.app";

async function expectedToken(userId: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(SERVICE_KEY),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(userId));
  return encodeBase64Url(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function page(title: string, message: string, status = 200): Response {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#f6f4ee;color:#2a2a2a;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;}
  .card{background:#fff;border-radius:14px;padding:48px 36px;max-width:480px;width:100%;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.06);}
  .brand{font-size:11px;text-transform:uppercase;letter-spacing:0.14em;color:#8a8a8a;font-weight:600;margin-bottom:24px;}
  h1{font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:400;color:#1c1f26;line-height:1.25;margin-bottom:14px;}
  p{font-size:15px;color:#5a5a5a;line-height:1.7;margin-bottom:22px;}
  a.btn{display:inline-block;background:#718e82;color:#fff;text-decoration:none;padding:11px 26px;border-radius:22px;font-size:14px;font-weight:500;}
  a.btn:hover{opacity:0.92;}
</style></head>
<body>
  <div class="card">
    <div class="brand">Shepherd Formation</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <a class="btn" href="${APP_URL}">Open the app</a>
  </div>
</body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url);
    const userId = url.searchParams.get("u") || "";
    const token = url.searchParams.get("t") || "";

    if (!userId || !token) {
      return page("Invalid link", "This unsubscribe link is missing required parameters.", 400);
    }

    // UUID sanity check
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      return page("Invalid link", "This unsubscribe link is malformed.", 400);
    }

    const expected = await expectedToken(userId);
    if (!timingSafeEqual(expected, token)) {
      return page("Invalid link", "This unsubscribe link is invalid or has expired.", 403);
    }

    const supa = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const { error } = await supa.from("profiles")
      .update({ devotional_email_opt_in: false })
      .eq("id", userId);
    if (error) throw error;

    // One-click email-client unsubscribe (RFC 8058) expects 200 + minimal body
    if (req.method === "POST") {
      return new Response("unsubscribed", { status: 200, headers: { "content-type": "text/plain" } });
    }

    return page(
      "You're unsubscribed",
      "You won't receive any more daily devotional emails from Shepherd Formation. You can opt back in anytime from your profile in the app."
    );
  } catch (e) {
    console.error("devotional-unsubscribe:", e);
    return page("Something went wrong", "We couldn't process your unsubscribe right now. Please try again, or reply to the email and we'll handle it manually.", 500);
  }
});
