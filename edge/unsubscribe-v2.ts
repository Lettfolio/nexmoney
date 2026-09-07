/* =============================================================================
   unsubscribe v2 (R83 · fixH) — the public opt-out endpoint the v19+ marketing
   footer links to, and the target of the v21 List-Unsubscribe headers.

   WHAT CHANGED FROM v1: v1 performed the opt-out on GET. Every URL in a delivered
   email is fetched by link scanners (Outlook Safe Links, Defender, Proofpoint…)
   before the person ever sees it, so v1 silently unsubscribed whole domains the
   moment a birthday note landed. v2:
     · GET  /unsubscribe?c=<client_id>&t=<comms_token>  is SIDE-EFFECT-FREE. It
       validates the pair and renders a one-button confirmation page whose
       <form method="POST"> carries the same two values in hidden fields.
     · POST /unsubscribe  (form body c=&t=, or the same query string, or the RFC 8058
       one-click body "List-Unsubscribe=One-Click") performs the opt-out and shows
       the v1 "you're unsubscribed" page.
     · The opt-out sets BOTH clients.comms_optout AND clients.marketing_opt_out —
       the second is the flag staff see on the client record, so an unsubscribe is
       visible in the back office instead of invisible (review finding 1).

   Everything v1 promised still holds:
     · PUBLIC — no auth. The only credential is the per-client comms_token.
     · The token is compared constant-time-ish, never used in the query filter.
     · No name or email is echoed back — the page may be opened from a forwarded
       email and must not become a "does this id exist and who is it" oracle.
     · A wrong or missing token gets the generic "link not recognised" page, same
       status code, no detail. ALWAYS 200 HTML (except CORS preflight), even on an
       unexpected failure. A person clicking a link must never see a bare error.
   ========================================================================== */
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

const escapeHtml = (t: string) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:48px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:#0f2a4a;padding:20px 28px;"><span style="color:#ffffff;font-size:20px;font-weight:bold;">NexMoney</span></div>
    <div style="padding:28px;color:#1f2937;font-size:15px;line-height:1.6;">${body}</div>
    <div style="padding:16px 28px;background:#f9fafb;color:#6b7280;font-size:12px;">NexMoney &middot; If anything looks wrong, just reply to the email that brought you here and let us know.</div>
  </div></body></html>`;
}

const html = (markup: string) =>
  new Response(markup, { status: 200, headers: { ...CORS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

const NOT_RECOGNISED = page(
  "Link not recognised",
  `<p><strong>Sorry — this link isn't one we recognise.</strong></p>
   <p>It may have been trimmed by your email app, or it may simply be an old one. Nothing has been changed.</p>
   <p>If you'd rather not receive emails like the one that brought you here, just reply to it and tell us — we'll sort it straight away.</p>`,
);

const UNSUBSCRIBED = page(
  "You're unsubscribed",
  `<p><strong>Done — you're unsubscribed.</strong></p>
   <p>You won't get relationship emails from us again. Emails about your own mortgage are unaffected.</p>
   <p>If this was a mistake, just reply to the email that brought you here and we'll switch them back on.</p>`,
);

// The GET page: no change has happened yet; one button makes it happen.
function confirmPage(clientId: string, token: string): string {
  return page(
    "Unsubscribe",
    `<p><strong>Prefer not to get emails like this?</strong></p>
     <p>Press the button and we'll stop sending relationship emails — birthday and anniversary notes, review and referral requests. Emails about your own mortgage are unaffected.</p>
     <form method="POST" action="" style="margin:24px 0 8px;">
       <input type="hidden" name="c" value="${escapeHtml(clientId)}">
       <input type="hidden" name="t" value="${escapeHtml(token)}">
       <button type="submit" style="background:#0f2a4a;color:#ffffff;border:0;padding:12px 28px;border-radius:6px;font-weight:bold;font-size:15px;cursor:pointer;">Unsubscribe me</button>
     </form>
     <p style="color:#6b7280;font-size:13px;">Nothing has been changed yet. If you got here by mistake, just close this page.</p>`,
  );
}

/* Read c / t from wherever this request carries them: the query string (GET, and the
   RFC 8058 one-click POST, whose body is only "List-Unsubscribe=One-Click"), or a
   form-encoded / JSON POST body. Query values win only when the body has none. */
async function readParams(req: Request, url: URL): Promise<{ clientId: string; token: string }> {
  let c = (url.searchParams.get("c") || "").trim();
  let t = (url.searchParams.get("t") || "").trim();
  if (req.method === "POST") {
    const ct = (req.headers.get("content-type") || "").toLowerCase();
    try {
      if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
        const fd = await req.formData();
        c = String(fd.get("c") ?? c).trim();
        t = String(fd.get("t") ?? t).trim();
      } else if (ct.includes("application/json")) {
        const j = await req.json();
        if (j && typeof j === "object") {
          c = String(j.c ?? c).trim();
          t = String(j.t ?? t).trim();
        }
      }
    } catch (_e) { /* unreadable body: fall back to the query string values */ }
  }
  return { clientId: c, token: t };
}

async function lookup(clientId: string, token: string): Promise<{ id: string } | null> {
  if (!clientId || !token) return null;
  const { data: cl } = await supabase.from("clients").select("id, comms_token").eq("id", clientId).maybeSingle();
  if (!cl || !cl.comms_token || !tokenMatches(token, String(cl.comms_token))) return null;
  return { id: cl.id };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    const { clientId, token } = await readParams(req, url);
    const cl = await lookup(clientId, token);
    if (!cl) return html(NOT_RECOGNISED);

    if (req.method !== "POST") {
      // GET (or HEAD): look, don't touch. Scanners and previews land here and change nothing.
      return html(confirmPage(clientId, token));
    }

    // POST: the opt-out. Both flags, so the staff-facing record agrees with the send-time gate.
    await supabase.from("clients").update({ comms_optout: true, marketing_opt_out: true }).eq("id", cl.id);
    return html(UNSUBSCRIBED);
  } catch (_err) {
    // Even an unexpected failure answers with the generic page — never a stack, never a 500.
    return html(NOT_RECOGNISED);
  }
});
