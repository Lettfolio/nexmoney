/* =============================================================================
   unsubscribe v1 (R79 · A1) — the public opt-out endpoint the v19 marketing
   footer links to: GET /unsubscribe?c=<client_id>&t=<comms_token>.

   Deliberately tiny and deliberately quiet:
     · PUBLIC — no auth. The only credential is the per-client comms_token
       (uuid, default gen_random_uuid()) carried in the link itself.
     · The token is compared constant-time-ish against clients.comms_token —
       never used in the query filter, so a wrong token costs the same lookup
       as a right one and the response never says which half was wrong.
     · A good token sets clients.comms_optout = true (idempotent — clicking
       twice is fine) and shows a small friendly page. It does NOT echo the
       client's name or email back: the page may be opened from a forwarded
       email, and this endpoint must not become a "does this id exist and who
       is it" oracle.
     · A wrong or missing token gets a generic "link not recognised" page —
       the SAME status code, no detail, NO information leak.
     · ALWAYS 200 HTML (except CORS preflight). A person clicking a link in
       an email must never see a bare JSON error or a 4xx browser page.
   ========================================================================== */
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Constant-time-ish string compare: length-independent early exit avoided by
// always walking the longer string; every character contributes to the result.
function tokenMatches(a: string, b: string): boolean {
  const x = String(a || "");
  const y = String(b || "");
  const n = Math.max(x.length, y.length);
  let diff = x.length === y.length ? 0 : 1;
  for (let i = 0; i < n; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:48px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:#0f2a4a;padding:20px 28px;"><span style="color:#ffffff;font-size:20px;font-weight:bold;">NexMoney</span></div>
    <div style="padding:28px;color:#1f2937;font-size:15px;line-height:1.6;">${body}</div>
    <div style="padding:16px 28px;background:#f9fafb;color:#6b7280;font-size:12px;">NexMoney &middot; If anything looks wrong, just reply to the email that brought you here and let us know.</div>
  </div></body></html>`;
}

const html = (markup: string) =>
  new Response(markup, { status: 200, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8" } });

const NOT_RECOGNISED = page(
  "Link not recognised",
  `<p><strong>Sorry — this link isn't one we recognise.</strong></p>
   <p>It may have been trimmed by your email app, or it may simply be an old one. Nothing has been changed.</p>
   <p>If you'd rather not receive emails like the one that brought you here, just reply to it and tell us — we'll sort it straight away.</p>`,
);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    const clientId = (url.searchParams.get("c") || "").trim();
    const token = (url.searchParams.get("t") || "").trim();
    if (!clientId || !token) return html(NOT_RECOGNISED);
    const { data: cl } = await supabase.from("clients").select("id, comms_token").eq("id", clientId).maybeSingle();
    if (!cl || !cl.comms_token || !tokenMatches(token, String(cl.comms_token))) return html(NOT_RECOGNISED);
    await supabase.from("clients").update({ comms_optout: true }).eq("id", cl.id);
    return html(page(
      "You're unsubscribed",
      `<p><strong>Done — you're unsubscribed.</strong></p>
       <p>You won't get relationship emails from us again. Emails about your own mortgage are unaffected.</p>
       <p>If this was a mistake, just reply to the email that brought you here and we'll switch them back on.</p>`,
    ));
  } catch (_err) {
    // Even an unexpected failure answers with the generic page — never a stack, never a 500.
    return html(NOT_RECOGNISED);
  }
});
