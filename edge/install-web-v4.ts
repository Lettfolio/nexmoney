// install-web v4 (R84) — RETIRED. Its only job was copying the legacy admin SPA into the public
// `web` bucket; db/r84/20_retire_web_bucket.sql removes that copy and makes the bucket private.
// Deploy this stub, then delete the function outright (`supabase functions delete install-web`).
Deno.serve(() =>
  new Response(JSON.stringify({ error: "retired" }), {
    status: 410,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  }));
