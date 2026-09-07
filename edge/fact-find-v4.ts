// fact-find — public JSON API for the client-facing digital fact-find form.
// Auth is the per-record token (verify_jwt disabled). GET loads/resumes, POST saves/submits.
// The form itself is served from the website (/factfind) because Supabase rewrites edge HTML
// to plain text; this endpoint only exchanges JSON.
//
// v4 (R84) CHANGES (deployed v3 → v4):
//   1. GET on a SUBMITTED fact-find returns status only — no `data`, no `prefill`. The link is
//      a bearer token that gets forwarded; after submission it has no further use to the client
//      and must not keep serving income, DOB and address for 30 days.
//   2. GET no longer flips 'sent' → 'started'. A link scanner or preview fetch marked the form
//      "started" in the app, and — under the v3 expiry rule — granted that row indefinite
//      post-expiry write access. The transition now happens on the first real POST.
//      OWNER-FACING: the "started" status appears when the client first saves, not when they
//      first open the link. The v3 expiry rule for POST ("a fill already started may keep
//      saving") is unchanged; a 'sent' row past expiry still cannot begin.
//   3. POST throttling: a non-submit save within 5 s of the last write is refused (429), and a
//      save whose data is identical to what is stored is acknowledged without writing. Each
//      write costs an audit_log row carrying the old and new data (up to ~400 KB), and v3 had
//      no cap at all on an unauthenticated endpoint.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const uuidRe = /^[0-9a-fA-F-]{36}$/;
const MIN_SAVE_GAP_MS = 5000;   // R84

// v3 (R79): 30-day link expiry, enforced AT THE DOOR. A link past its
// fact_finds.expires_at cannot start or resume a session (GET), and cannot
// save from a session that never legitimately began (POST while still
// 'sent'/'created'). A fill already 'started' before expiry may keep saving
// and submit — a client mid-form must never lose their answers to a clock.
// Rows with expires_at null (pre-R79 legacy) never expire.
const expired = (row: any) => !!(row && row.expires_at && Date.parse(row.expires_at) < Date.now());
const EXPIRED_MSG = { error: "link_expired", message: "This link has expired — just reply to the email that brought you here (or give us a ring) and we'll send a fresh one." };

async function companyName(): Promise<string> {
  const { data } = await admin.from("settings").select("value").eq("key", "company_name").maybeSingle();
  return data?.value || "NexMoney";
}

// R84: stable JSON for the identical-save check (key order must not matter).
function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canon(o[k])).join(",") + "}";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);

  // ---- Load / resume -------------------------------------------------------
  if (req.method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    if (!uuidRe.test(token)) return json({ error: "invalid link" }, 400);
    const { data: ff } = await admin.from("fact_finds").select("id, status, data, case_id, client_id, expires_at").eq("token", token).maybeSingle();
    if (!ff) return json({ error: "not_found" }, 404);
    if (expired(ff)) return json(EXPIRED_MSG, 410);   // v3: expiry enforced at the door

    // R84: a submitted fact-find is closed. Status only — nothing personal leaves on this link again.
    if (ff.status === "submitted") return json({ ok: true, status: "submitted", data: {}, prefill: {}, company: await companyName() });

    let prefill: Record<string, unknown> = {};
    if (ff.client_id) {
      const { data: cl } = await admin.from("clients").select("first_name, last_name, email, phone, date_of_birth, address").eq("id", ff.client_id).maybeSingle();
      if (cl) prefill = cl;
    }
    // R84: no 'sent' → 'started' write here (scanners and previews fetch this URL); see POST.
    return json({ ok: true, status: ff.status, data: ff.data ?? {}, prefill, company: await companyName() });
  }

  // ---- Save / submit -------------------------------------------------------
  if (req.method === "POST") {
    let b: any;
    try { b = await req.json(); } catch { return json({ error: "bad body" }, 400); }
    const token = String(b.token ?? "");
    if (!uuidRe.test(token)) return json({ error: "invalid link" }, 400);
    if (typeof b.data !== "object" || b.data === null || Array.isArray(b.data)) return json({ error: "data must be an object" }, 400);
    if (JSON.stringify(b.data).length > 200000) return json({ error: "too large" }, 413);

    const { data: ff } = await admin.from("fact_finds").select("id, status, expires_at, data, updated_at").eq("token", token).maybeSingle();   // R84: + data, updated_at
    if (!ff) return json({ error: "not_found" }, 404);
    if (ff.status === "submitted") return json({ ok: true, status: "submitted", note: "already submitted" });
    // v3: an expired link that never began a fill cannot start writing now; a fill
    // already 'started' keeps its right to save and submit (see header comment).
    if (expired(ff) && ff.status !== "started") return json(EXPIRED_MSG, 410);

    const submit = b.submit === true;

    // R84: throttle. A non-submit save within MIN_SAVE_GAP_MS of the last write is refused; the
    // form's autosave never fires that fast, a loop does. Submits are never throttled.
    if (!submit && ff.updated_at && Date.now() - Date.parse(ff.updated_at) < MIN_SAVE_GAP_MS) {
      return json({ error: "too_fast", message: "Saved a moment ago — try again in a few seconds." }, 429);
    }
    // R84: identical data on an already-started row is a no-op (no audit row, no updated_at churn).
    if (!submit && ff.status === "started" && canon(ff.data ?? {}) === canon(b.data)) {
      return json({ ok: true, status: "started", note: "unchanged" });
    }

    const patch: Record<string, unknown> = { data: b.data, updated_at: new Date().toISOString(), status: submit ? "submitted" : "started" };
    if (submit) patch.submitted_at = new Date().toISOString();
    const { error } = await admin.from("fact_finds").update(patch).eq("id", ff.id);
    if (error) return json({ error: "could not save" }, 500);
    return json({ ok: true, status: submit ? "submitted" : "started" });
  }

  return json({ error: "method not allowed" }, 405);
});
