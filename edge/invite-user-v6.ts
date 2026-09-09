// =============================================================================
// invite-user v6 — R86 · V1 (second factor)
// Copied VERBATIM from invite-user v5; the ONLY change is the session_ok() gate right after the
// caller's user is resolved: an owner/admin session that has not verified its
// authenticator (db/r86/01 session_ok() = false) is refused with
// { error: "second factor required" } 403 before anything else runs. Cron / service-role
// paths (no user JWT) are untouched. session_ok() is EXECUTE-granted to authenticated,
// so it is called through the caller's own JWT (the anon-key client + Authorization).
// =============================================================================
// =============================================================================
// invite-user v5 — R84 (S4 · P3)
// Deployed version at time of writing: 4 (no earlier source in edge/), so this is v5.
//
// CHANGES (each tagged // R84):
//   1. introducer_id VALIDATED. For role 'introducer' it must be a UUID that exists in
//      public.introducers (checked with the service-role client BEFORE the auth user is created,
//      so a typo no longer leaves a half-made login) → 400 otherwise. For admin/adviser it is
//      forced to null — a staff login must never carry a tenant pointer.
// Everything else byte-identical to v4.
//
// OWNER-FACING: inviting an introducer with an unknown introducer id now fails cleanly with
// "introducer_id does not match an introducer" instead of creating a login pointing nowhere.
// =============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Roles this endpoint is allowed to create. 'owner' is deliberately absent:
// granting owner-level access is done by an existing Owner in the back
// office, never by creating a fresh login, so there is no path that mints
// a new top-level account in one unattended call.
const INVITABLE = ["admin", "adviser", "introducer"] as const;

// R84: shape check before the DB is asked — a non-UUID would otherwise surface as a 500 from the profile upsert.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;   // R84

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return "Nx-" + btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "").slice(0, 14) + "!";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // The caller must be a signed-in Owner. User management is Owner-only:
  // this is the check, not the hidden button in the UI.
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: { user: caller }, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !caller) return json({ error: "Not signed in" }, 401);
  // R86 · V1 — the caller's session must have verified its second factor (session_ok() runs as
  // the caller, through their own JWT). An aal1 owner must not be able to mint a fresh login.
  const uc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization")! } } });   // R86 · V1
  const { data: ok, error: okErr } = await uc.rpc("session_ok");   // R86 · V1
  if (okErr || ok !== true) return json({ error: "second factor required" }, 403);   // R86 · V1

  const { data: callerProfile } = await admin.from("profiles").select("role").eq("id", caller.id).single();
  if (callerProfile?.role !== "owner") {
    return json({ error: "Only an Owner can create logins" }, 403);
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }

  const email = String(body.email ?? "").trim().toLowerCase();
  const fullName = String(body.full_name ?? "").trim();

  // Role MUST be stated explicitly and MUST be one of the invitable
  // values — never silently default to a privileged account.
  if (!INVITABLE.includes(body.role)) {
    return json({ error: `role must be one of: ${INVITABLE.join(", ")}` }, 400);
  }
  const role = body.role as string;
  // R84: only an introducer login carries a tenant pointer; staff roles never do.
  const introducerId: string | null = role === "introducer" && body.introducer_id != null ? String(body.introducer_id).trim() : null;   // R84

  if (!email || !email.includes("@")) return json({ error: "Valid email required" }, 400);
  if (role === "introducer" && !introducerId) {
    return json({ error: "introducer_id required for introducer logins" }, 400);
  }
  // R84: the pointer must name a real introducer — checked before the auth user exists so a bad
  // id cannot leave a login with no working profile behind.
  if (role === "introducer") {   // R84
    if (!UUID_RE.test(introducerId!)) return json({ error: "introducer_id must be a UUID" }, 400);
    const { data: intro, error: introErr } = await admin.from("introducers").select("id").eq("id", introducerId!).maybeSingle();
    if (introErr) return json({ error: "Could not check introducer: " + introErr.message }, 500);
    if (!intro) return json({ error: "introducer_id does not match an introducer" }, 400);
  }

  const password = randomPassword();
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });
  if (error) return json({ error: error.message }, 400);

  const { error: profErr } = await admin.from("profiles")
    .upsert({ id: created.user.id, email, full_name: fullName, role, introducer_id: introducerId });
  if (profErr) return json({ error: "User created but profile update failed: " + profErr.message }, 500);

  // Leave a trace of who was given access, by whom. The profiles trigger
  // records the row itself; this records the act of inviting.
  await admin.from("audit_log").insert({
    actor: caller.id,
    actor_label: caller.email ?? "Owner",
    action: "insert",
    table_name: "profiles",
    row_id: created.user.id,
    summary: `${caller.email ?? "An Owner"} created a ${role} login for ${email}`,
    changes: { email, full_name: fullName, role },
  });

  return json({ ok: true, email, temp_password: password, role });
});
