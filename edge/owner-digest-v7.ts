// =============================================================================
// owner-digest v7 — R86 · V1 (second factor)
// Copied VERBATIM from owner-digest v6; the ONLY change is the session_ok() gate right after the
// caller's user is resolved: an owner/admin session that has not verified its
// authenticator (db/r86/01 session_ok() = false) is refused with
// { error: "second factor required" } 403 before anything else runs. Cron / service-role
// paths (no user JWT) are untouched. session_ok() is EXECUTE-granted to authenticated,
// so it is called through the caller's own JWT (the anon-key client + Authorization).
// =============================================================================
// =============================================================================
// owner-digest v6 — R84 (S4 · P3)
// Deployed version at time of writing: 5 (no earlier source in edge/), so this is v6.
//
// CHANGES (each tagged // R84):
//   1. MANUAL RUNS ARE OWNER/ADMIN. A staff JWT now needs profiles.role in owner/admin (was any
//      staff role). {force:true} bypasses the daily toggle and the already-sent guard, runs
//      run_watchtower(), an Anthropic call and a Resend send to the owner — not an adviser action.
//      The x-cron-key path is unchanged.
// Everything else byte-identical to v5.
//
// OWNER-FACING: the "Send digest now" button works for owner/admin only; advisers get 401.
// =============================================================================
// owner-digest — daily digest email for the owner of NexMoney.
// Triggered by pg_cron (with the shared cron key) or manually by staff (JWT), body {force:true}.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-cron-key",
  "Content-Type": "application/json",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// BE-7: production has no 'staff' rows; match the role set process-emails uses.
const STAFF_ROLES = ["owner", "admin", "adviser", "staff"];
// R84: who may force a digest by hand. STAFF_ROLES is still the adviser table's row set.
const MANUAL_ROLES = ["owner", "admin"];   // R84

// Staff JWT OR shared cron key. The public anon key alone is not sufficient.
async function authorize(req: Request): Promise<boolean | "mfa"> {   // R86 · V1: "mfa" = signed in, second factor not verified
  const cronKey = req.headers.get("x-cron-key");
  if (cronKey) {
    const { data } = await admin.from("settings").select("value").eq("key", "cron_key").maybeSingle();
    if (data?.value && cronKey === data.value) return true;
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  if (token) {
    const uc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: u } = await uc.auth.getUser();
    if (u?.user) {
      const { data: ok, error: okErr } = await uc.rpc("session_ok");   // R86 · V1
      if (okErr || ok !== true) return "mfa";   // R86 · V1 (the cron-key path above never reaches here)
      const { data: p } = await admin.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
      if (p?.role && MANUAL_ROLES.includes(p.role)) return true;   // R84: was STAFF_ROLES
    }
  }
  return false;
}

function esc(s: unknown): string {
  return String(s ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
const gbp = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
function londonDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d);
}
function shiftDateString(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}
// UTC instant of 00:00 Europe/London on the given calendar day (DST-correct).
function londonMidnightISO(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const utcGuess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/London", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcGuess)).reduce((a: any, p) => { a[p.type] = p.value; return a; }, {});
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return new Date(utcGuess - (asUTC - utcGuess)).toISOString();
}
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number); const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}
function longDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}
function shortDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}
function must<T>(res: { data: T | null; error: { message: string } | null }, label: string): T {
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
  return (res.data ?? []) as T;
}
function tally(rows: Array<Record<string, unknown>>, key: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) { const k = r[key] as string | null; if (!k) continue; m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: CORS });
  const authz = await authorize(req);   // R86 · V1
  if (authz === "mfa") return json({ error: "second factor required" }, 403);   // R86 · V1
  if (!authz) return json({ error: "unauthorized" }, 401);

  try {
    let body: { force?: boolean } | null = null;
    try { body = await req.json(); } catch { /* empty */ }
    const force = body?.force === true;

    const settingsRows = must(await admin.from("settings").select("key, value"), "settings") as Array<{ key: string; value: string | null }>;
    const settings = new Map(settingsRows.map((r) => [r.key, r.value ?? ""]));
    if (settings.get("owner_digest") !== "on" && !force) return json({ skipped: "disabled" });

    const today = londonDateString();
    const lastSent = must(await admin.from("sync_state").select("value").eq("key", "owner_digest_last").maybeSingle(), "sync_state") as { value: string | null } | null;
    if (lastSent?.value === today && !force) return json({ skipped: "already_sent" });

    let watchtower: { open?: number; new?: number; resolved?: number } | null = null;
    try { const { data, error } = await admin.rpc("run_watchtower"); if (!error) watchtower = data as typeof watchtower; } catch { /* tolerated */ }

    const yesterday = shiftDateString(today, -1);
    const rangeStart = londonMidnightISO(yesterday);   // London-day boundaries (DST-correct)
    const rangeEnd = londonMidnightISO(today);
    const horizonEnd = shiftDateString(today, 90);

    const [staffRes, submissionsRes, completionsRes, notesRes, tasksRes, newCasesRes, newLeadsRes, openLeadsRes, feesPaidRes, feesOutstandingRes, protectionRes, ratesRes, alertsRes] = await Promise.all([
      admin.from("profiles").select("id, full_name, email").in("role", STAFF_ROLES),
      admin.from("cases").select("assigned_to").eq("submitted_at", yesterday),
      admin.from("cases").select("assigned_to").gte("completed_at", rangeStart).lt("completed_at", rangeEnd),
      admin.from("case_notes").select("created_by").gte("created_at", rangeStart).lt("created_at", rangeEnd),
      admin.from("case_tasks").select("assigned_to").gte("done_at", rangeStart).lt("done_at", rangeEnd),
      admin.from("cases").select("id", { count: "exact", head: true }).gte("created_at", rangeStart).lt("created_at", rangeEnd),
      admin.from("leads").select("id", { count: "exact", head: true }).gte("created_at", rangeStart).lt("created_at", rangeEnd),
      admin.from("leads").select("id", { count: "exact", head: true }).eq("status", "new"),
      admin.from("cases").select("broker_fee").gte("fee_paid_at", rangeStart).lt("fee_paid_at", rangeEnd),
      admin.from("cases").select("broker_fee").eq("fee_status", "requested"),
      admin.from("cases").select("protection_status").not("stage", "in", "(completed,not_proceeding)").in("protection_status", ["not_discussed", "discussed", "quoted", "policy_taken"]),
      admin.from("cases").select("rate_end_date").gte("rate_end_date", today).lte("rate_end_date", horizonEnd).is("retention_source_case_id", null).neq("stage", "not_proceeding"),
      admin.from("watch_alerts").select("title, detail, severity, created_at").is("resolved_at", null),
    ]);

    const staff = must(staffRes, "profiles") as Array<{ id: string; full_name: string | null; email: string | null }>;
    const subByAdviser = tally(must(submissionsRes, "submissions") as Array<Record<string, unknown>>, "assigned_to");
    const compByAdviser = tally(must(completionsRes, "completions") as Array<Record<string, unknown>>, "assigned_to");
    const notesByAuthor = tally(must(notesRes, "case_notes") as Array<Record<string, unknown>>, "created_by");
    const tasksByAdviser = tally(must(tasksRes, "case_tasks") as Array<Record<string, unknown>>, "assigned_to");

    if (newCasesRes.error) throw new Error(`new cases: ${newCasesRes.error.message}`);
    if (newLeadsRes.error) throw new Error(`new leads: ${newLeadsRes.error.message}`);
    if (openLeadsRes.error) throw new Error(`open leads: ${openLeadsRes.error.message}`);
    const newCases = newCasesRes.count ?? 0;
    const newLeads = newLeadsRes.count ?? 0;
    const leadsStillNew = openLeadsRes.count ?? 0;

    const adviserRows = staff.map((p) => ({
      name: p.full_name || p.email || "Unknown",
      submitted: subByAdviser.get(p.id) ?? 0, completed: compByAdviser.get(p.id) ?? 0,
      notes: notesByAuthor.get(p.id) ?? 0, tasks: tasksByAdviser.get(p.id) ?? 0,
    })).filter((r) => r.submitted + r.completed + r.notes + r.tasks > 0).sort((a, b) => (b.submitted + b.completed) - (a.submitted + a.completed));

    const feesPaidRows = must(feesPaidRes, "fees paid") as Array<{ broker_fee: number | null }>;
    const feesBanked = feesPaidRows.reduce((s, r) => s + (Number(r.broker_fee) || 0), 0);
    const outstandingRows = must(feesOutstandingRes, "fees outstanding") as Array<{ broker_fee: number | null }>;
    const outstandingCount = outstandingRows.length;
    const outstandingSum = outstandingRows.reduce((s, r) => s + (Number(r.broker_fee) || 0), 0);

    const protectionRows = must(protectionRes, "protection") as Array<{ protection_status: string | null }>;
    const protection = { not_discussed: 0, discussed: 0, quoted: 0, policy_taken: 0 } as Record<string, number>;
    for (const r of protectionRows) { if (r.protection_status && r.protection_status in protection) protection[r.protection_status]++; }

    const rateRows = must(ratesRes, "rates") as Array<{ rate_end_date: string | null }>;
    const horizon = { d30: 0, d60: 0, d90: 0 };
    for (const r of rateRows) { if (!r.rate_end_date) continue; const d = daysBetween(today, r.rate_end_date); if (d <= 30) horizon.d30++; else if (d <= 60) horizon.d60++; else if (d <= 90) horizon.d90++; }

    const severityRank: Record<string, number> = { crit: 0, warn: 1, info: 2 };
    const allAlerts = (must(alertsRes, "watch_alerts") as Array<{ title: string | null; detail: string | null; severity: string | null; created_at: string }>).sort((a, b) => { const r = (severityRank[a.severity ?? "info"] ?? 3) - (severityRank[b.severity ?? "info"] ?? 3); return r !== 0 ? r : b.created_at.localeCompare(a.created_at); });
    const alertCounts = { crit: allAlerts.filter((a) => a.severity === "crit").length, warn: allAlerts.filter((a) => a.severity === "warn").length, info: allAlerts.filter((a) => a.severity === "info").length };
    const topAlerts = allAlerts.slice(0, 12);

    let narrative: string | null = null;
    const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (anthropicKey) {
      try {
        const stats = { date: yesterday, advisers: adviserRows, new_cases: newCases, new_leads: newLeads, leads_awaiting_first_contact: leadsStillNew, fees_banked_gbp: feesBanked, fees_outstanding: { count: outstandingCount, total_gbp: outstandingSum }, protection_pipeline: protection, rate_end_horizon: { within_30d: horizon.d30, within_31_60d: horizon.d60, within_61_90d: horizon.d90 }, open_alerts: { counts: alertCounts, top: topAlerts.map((a) => ({ severity: a.severity, title: a.title, detail: a.detail })) }, watchtower_run: watchtower };
        const aiRes = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 500, system: "You are the operations brain of NexMoney, a UK mortgage brokerage. Given today's digest data, write 2–3 short punchy paragraphs for the owner: what moved yesterday, what looks stuck or risky, and the one thing you'd act on first today. UK English, plain text, no headings, no bullet lists, no flattery.", messages: [{ role: "user", content: JSON.stringify(stats) }] }) });
        if (aiRes.ok) { const aiJson = await aiRes.json(); const text = aiJson?.content?.[0]?.text; if (typeof text === "string" && text.trim()) narrative = text.trim(); }
      } catch { /* optional */ }
    }

    const heading = (t: string) => `<div style="font-size:13px;font-weight:bold;color:#0f2a4a;text-transform:uppercase;letter-spacing:.5px;margin:22px 0 10px;">${esc(t)}</div>`;
    const sections: string[] = [];
    {
      let inner: string;
      if (adviserRows.length > 0) {
        const th = `style="text-align:left;padding:6px 10px;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;"`;
        const thNum = `style="text-align:right;padding:6px 10px;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;"`;
        const td = `style="padding:7px 10px;font-size:13px;color:#111827;border-bottom:1px solid #f3f4f6;"`;
        const tdNum = `style="padding:7px 10px;font-size:13px;color:#111827;border-bottom:1px solid #f3f4f6;text-align:right;"`;
        inner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr><th ${th}>Adviser</th><th ${thNum}>Submitted</th><th ${thNum}>Completed</th><th ${thNum}>Notes</th><th ${thNum}>Tasks done</th></tr>` + adviserRows.map((r) => `<tr><td ${td}>${esc(r.name)}</td><td ${tdNum}>${r.submitted}</td><td ${tdNum}>${r.completed}</td><td ${tdNum}>${r.notes}</td><td ${tdNum}>${r.tasks}</td></tr>`).join("") + `</table>`;
      } else { inner = `<div style="font-size:13px;color:#6b7280;">A quiet day — no submissions or completions logged.</div>`; }
      inner += `<div style="font-size:12px;color:#6b7280;margin-top:10px;">New cases: ${newCases} &middot; New leads: ${newLeads} &middot; Leads awaiting first contact: ${leadsStillNew}</div>`;
      sections.push(heading("Yesterday") + inner);
    }
    if (feesBanked > 0 || outstandingCount > 0) sections.push(heading("Money") + `<div style="font-size:13px;color:#111827;line-height:1.7;">Fees banked yesterday: <strong>${esc(gbp.format(feesBanked))}</strong><br>Fees outstanding: <strong>${outstandingCount}</strong> requested, <strong>${esc(gbp.format(outstandingSum))}</strong> awaiting payment</div>`);
    if (allAlerts.length > 0) {
      const dot: Record<string, string> = { crit: "#c0392b", warn: "#b07d12", info: "#2563eb" };
      const label: Record<string, string> = { crit: "CRIT", warn: "WARN", info: "INFO" };
      const countsLine = [alertCounts.crit ? `${alertCounts.crit} critical` : null, alertCounts.warn ? `${alertCounts.warn} warning${alertCounts.warn === 1 ? "" : "s"}` : null, alertCounts.info ? `${alertCounts.info} info` : null].filter(Boolean).join(" &middot; ");
      const rows = topAlerts.map((a) => { const c = dot[a.severity ?? "info"] ?? "#2563eb"; const l = label[a.severity ?? "info"] ?? "INFO"; return `<div style="padding:7px 0;border-bottom:1px solid #f3f4f6;font-size:13px;color:#111827;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:8px;"></span><span style="color:${c};font-size:11px;font-weight:bold;margin-right:8px;">${l}</span><strong>${esc(a.title)}</strong>${a.detail ? `<span style="color:#6b7280;"> — ${esc(a.detail)}</span>` : ""}</div>`; }).join("");
      sections.push(heading("Needs attention") + `<div style="font-size:13px;color:#374151;margin-bottom:8px;">${countsLine}</div>` + rows);
    }
    const protectionTotal = Object.values(protection).reduce((a, b) => a + b, 0);
    if (protectionTotal > 0) sections.push(heading("Protection pipeline") + `<div style="font-size:13px;color:#111827;line-height:1.7;">Not discussed: <strong>${protection.not_discussed}</strong> &middot; Discussed: <strong>${protection.discussed}</strong> &middot; Quoted: <strong>${protection.quoted}</strong> &middot; Taken: <strong>${protection.policy_taken}</strong></div>`);
    if (horizon.d30 + horizon.d60 + horizon.d90 > 0) sections.push(heading("Rate-end horizon") + `<div style="font-size:13px;color:#111827;line-height:1.7;">Within 30 days: <strong>${horizon.d30}</strong> &middot; 31&ndash;60 days: <strong>${horizon.d60}</strong> &middot; 61&ndash;90 days: <strong>${horizon.d90}</strong></div>`);
    if (narrative) { const paras = narrative.split(/\n\n+/).map((p) => `<p style="font-size:13px;color:#374151;font-style:italic;line-height:1.6;margin:0 0 10px;">${esc(p)}</p>`).join(""); sections.push(heading("Your assistant's read") + paras); }

    const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;"><tr><td align="center" style="padding:24px 12px;"><table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:640px;background:#ffffff;border-radius:8px;overflow:hidden;"><tr><td style="background:#0f2a4a;padding:20px 28px;"><div style="color:#ffffff;font-size:20px;font-weight:bold;">NexMoney</div><div style="color:#b8c4d4;font-size:13px;margin-top:4px;">Owner digest &mdash; ${esc(longDate(yesterday))}</div></td></tr><tr><td style="padding:8px 28px 26px;">${sections.join("")}</td></tr><tr><td style="background:#f9fafb;color:#6b7280;font-size:12px;padding:14px 28px;">This is an automated internal digest from the NexMoney back office. Figures cover the previous working day and current pipeline.</td></tr></table></td></tr></table></body></html>`;
    const subject = `NexMoney owner digest — ${shortDate(yesterday)}`;

    const resendKey = Deno.env.get("RESEND_API_KEY");
    if (!resendKey) return json({ skipped: "no_resend_key", preview_subject: subject });
    const from = settings.get("from_email") || "onboarding@resend.dev";
    const to = [settings.get("owner_digest_email") || "daniel@nexmoney.co.uk"];
    const sendRes = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ from, to, subject, html }) });
    if (!sendRes.ok) { const errText = await sendRes.text(); return json({ error: `Resend failed (${sendRes.status}): ${errText}` }, 500); }
    const { error: upsertErr } = await admin.from("sync_state").upsert({ key: "owner_digest_last", value: today, updated_at: new Date().toISOString() }, { onConflict: "key" });
    if (upsertErr) throw new Error(`sync_state upsert: ${upsertErr.message}`);
    return json({ sent: true, to, alerts: alertCounts, narrative: !!narrative });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
