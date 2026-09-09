/* =============================================================================
   send-sms v5 — R86 · V1 (second factor)
   Copied VERBATIM from send-sms v4; the ONLY change is the session_ok() gate right after the
   caller's user is resolved: an owner/admin session that has not verified its
   authenticator (db/r86/01 session_ok() = false) is refused with
   { error: "second factor required" } 403 before anything else runs. Cron / service-role
   paths (no user JWT) are untouched. session_ok() is EXECUTE-granted to authenticated,
   so it is called through the caller's own JWT (the anon-key client + Authorization).
   ============================================================================= */
/* =============================================================================
   send-sms v4 — R84 (S4 · P2 + P3)
   Deployed version at time of writing: 3 (no earlier source in edge/), so this is v4.

   CHANGES (each tagged // R84):
     1. OPT-OUT WIDENED. v3 refused only clients.sms_opt_out. v4 refuses when ANY of sms_opt_out,
        comms_optout (set by the email unsubscribe link), marketing_opt_out (set by staff) or
        suppress_automation (the care flag) is true → row status 'failed', error 'client opted out'.
        Same predicate the email path (process-emails v21) already applies.
     2. MANUAL RUNS ARE OWNER/ADMIN. The x-cron-key path is unchanged. A staff JWT now needs
        profiles.role in owner/admin (was any staff role) — flushing the SMS queue costs money.
   Everything else byte-identical to v3.

   OWNER-FACING: "Send SMS now" is an owner/admin action; an adviser pressing it gets 401.
   Clients who unsubscribed from email, are marked marketing opt-out, or are on the care list no
   longer receive automated texts.
   ============================================================================= */
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// R84: a manual run spends money — owner/admin only. The cron key path below is unchanged.
const MANUAL_ROLES = ["owner", "admin"];   // R84

async function authorize(req: Request): Promise<boolean | "mfa"> {   // R86 · V1: "mfa" = signed in, second factor not verified
  const cronKey = req.headers.get("x-cron-key");
  if (cronKey) {
    const { data } = await supabase.from("settings").select("value").eq("key", "cron_key").maybeSingle();
    if (data?.value && cronKey === data.value) return true;
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  if (token) {
    const uc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: u } = await uc.auth.getUser();
    if (u?.user) {
      const { data: ok, error: okErr } = await uc.rpc("session_ok");   // R86 · V1
      if (okErr || ok !== true) return "mfa";   // R86 · V1
      const { data: p } = await supabase.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
      if (p?.role && MANUAL_ROLES.includes(p.role)) return true;   // R84: was STAFF_ROLES
    }
  }
  return false;
}

const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "long" }) : "";

function composeBody(type: string, c: any, cl: any, s: Record<string, string>): string {
  const company = s.company_name || "NexMoney";
  const first = (cl?.first_name || "").trim() || "there";
  const phone = s.adviser_phone ? ` Call ${s.adviser_phone} or reply.` : " Just reply.";
  if (type === "rate_end") {
    return `Hi ${first}, it's ${company}. Your mortgage rate${c?.lender ? ` with ${c.lender}` : ""} ends ${fmtDate(c?.rate_end_date)} — we can usually secure a new deal now and save you moving to the lender's SVR.${phone} Txt STOP to opt out.`;
  }
  // appointment bodies are pre-composed at queue time; fall back to the stored body
  return "";
}

async function sendTwilio(sid: string, tok: string, from: string, to: string, body: string) {
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${tok}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  const j = await resp.json();
  if (!resp.ok) throw new Error(j?.message || `Twilio ${resp.status}`);
  return j.sid as string;
}

async function sendClickSend(user: string, key: string, from: string, to: string, body: string) {
  const resp = await fetch("https://rest.clicksend.com/v3/sms/send", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${user}:${key}`), "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ source: "nexmoney", from: from || undefined, to, body }] }),
  });
  const j = await resp.json();
  if (!resp.ok || j?.response_code !== "SUCCESS") throw new Error(j?.response_msg || `ClickSend ${resp.status}`);
  return String(j?.data?.messages?.[0]?.message_id ?? "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const authz = await authorize(req);   // R86 · V1
  if (authz === "mfa") return json({ error: "second factor required" }, 403);   // R86 · V1
  if (!authz) return json({ error: "unauthorized" }, 401);

  const results: any = { appointment_queued: null, sent: 0, failed: 0 };

  const { data: apptQ } = await supabase.rpc("queue_appointment_sms");
  results.appointment_queued = apptQ;

  const { data: settingsRows } = await supabase.from("settings").select("key,value");
  const s: Record<string, string> = {};
  (settingsRows ?? []).forEach((r: any) => (s[r.key] = r.value));

  if (s.sms_enabled !== "on") {
    return json({ ...results, warning: "sms_enabled is off — nothing sent" });
  }

  const provider = s.sms_provider || "twilio";
  const from = s.sms_from || "";
  const twSid = Deno.env.get("TWILIO_ACCOUNT_SID"), twTok = Deno.env.get("TWILIO_AUTH_TOKEN");
  const csUser = Deno.env.get("CLICKSEND_USERNAME"), csKey = Deno.env.get("CLICKSEND_API_KEY");
  const configured = provider === "twilio" ? !!(twSid && twTok) : !!(csUser && csKey);
  if (!configured) {
    const { count } = await supabase.from("sms_queue").select("id", { count: "exact", head: true }).eq("status", "queued").lte("scheduled_for", new Date().toISOString());
    return json({ ...results, warning: `${provider} credentials not set — SMS remain queued`, pending: count ?? 0 });
  }

  // recover stale claims
  await supabase.from("sms_queue").update({ status: "queued", claimed_at: null })
    .eq("status", "sending").lt("claimed_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

  const { data: cand } = await supabase.from("sms_queue").select("id")
    .eq("status", "queued").lte("scheduled_for", new Date().toISOString()).limit(50);
  const ids = (cand ?? []).map((r: any) => r.id);
  if (ids.length === 0) return json(results);

  const { data: rows, error } = await supabase.from("sms_queue")
    .update({ status: "sending", claimed_at: new Date().toISOString() })
    .in("id", ids).eq("status", "queued")
    .select("*, cases(*), clients(*)");
  if (error) return json({ ...results, error: error.message }, 500);

  for (const m of rows ?? []) {
    const cl = m.clients, c = m.cases;
    const to = m.to_phone || cl?.phone;
    // R84: any "no" counts — the SMS STOP flag, the email unsubscribe flag, the staff marketing
    // opt-out, or the care-list suppression. Same rule the email sender applies.
    const optedOut = !!(cl?.sms_opt_out || cl?.comms_optout || cl?.marketing_opt_out || cl?.suppress_automation);   // R84
    if (!to || optedOut) {   // R84
      await supabase.from("sms_queue").update({ status: "failed", error: !to ? "no phone" : "client opted out" }).eq("id", m.id);
      results.failed++; continue;
    }
    try {
      const body = m.body && m.body.trim() ? m.body : composeBody(m.sms_type, c ?? {}, cl, s);
      if (!body) throw new Error(`no body for sms_type ${m.sms_type}`);
      const pid = provider === "twilio"
        ? await sendTwilio(twSid!, twTok!, from, to, body)
        : await sendClickSend(csUser!, csKey!, from, to, body);
      await supabase.from("sms_queue").update({ status: "sent", sent_at: new Date().toISOString(), to_phone: to, body, provider_id: pid }).eq("id", m.id);
      results.sent++;
    } catch (err) {
      await supabase.from("sms_queue").update({ status: "failed", error: String(err) }).eq("id", m.id);
      results.failed++;
    }
  }
  return json(results);
});
