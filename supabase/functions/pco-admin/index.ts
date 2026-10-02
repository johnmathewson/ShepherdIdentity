import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Retired 2026-09-15. The temporary Planning Center admin bridge has been removed;
// see ShepherdIdentity/supabase/functions/pco-admin in git history if it is ever needed again.
Deno.serve(() => new Response(JSON.stringify({ error: "retired" }), { status: 410, headers: { "Content-Type": "application/json" } }));
