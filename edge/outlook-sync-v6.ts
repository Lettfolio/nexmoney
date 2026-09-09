// =============================================================================
// outlook-sync v6 — R86 · V1 (second factor)
// Copied VERBATIM from outlook-sync v5; the ONLY change is the session_ok() gate right after the
// caller's user is resolved: an owner/admin session that has not verified its
// authenticator (db/r86/01 session_ok() = false) is refused with
// { error: "second factor required" } 403 before anything else runs. Cron / service-role
// paths (no user JWT) are untouched. session_ok() is EXECUTE-granted to authenticated,
// so it is called through the caller's own JWT (the anon-key client + Authorization).
// =============================================================================
// =============================================================================
// outlook-sync v5 — R84 (S4 · P2 + P3)
// Deployed version at time of writing: 4 (no earlier source in edge/), so this is v5.
//
// CHANGES (each tagged // R84):
//   1. CURSOR ONLY ADVANCES PAST WHAT LANDED. v4 moved the per-mailbox cursor to the newest
//      receivedDateTime it FETCHED, so a message whose case_emails upsert failed was never seen
//      again. v5 tracks the newest timestamp among messages that were either unmatched (nothing to
//      store) or successfully upserted, and STOPS advancing at the first failed upsert — the
//      messages after it (in receivedDateTime order) are re-fetched next run; graph_id dedupes.
//   2. MANUAL RUNS ARE OWNER/ADMIN (this function has no cron path; every call is manual). It
//      reads every staff mailbox with an app-only Graph token and writes with the service role,
//      so it is an admin action. Advisers get 401.
// Everything else byte-identical to v4.
//
// OWNER-FACING: the "Sync Outlook" button works for owner/admin only. A sync that hits a DB error
// on one message now reports it in `errors` AND retries it next time instead of skipping it.
// =============================================================================
// outlook-sync — Supabase Edge Function
// Inbound email sync from Microsoft 365 (Graph API) for the NexMoney back office.
//
// POST body:  {} (an optional {force:true} is accepted and ignored)
// Response:   { mailboxes: n, fetched: n, matched: n, inserted: n, errors: [...] }
//
// - Caller must be an authenticated staff member (checked with an RLS client).
// - All DB reads/writes then use the SERVICE-ROLE client (bypasses RLS) so the
//   sync sees every client/case and can write cursors regardless of policies.
// - Uses an app-only (client credentials) Graph token: the app registration
//   needs Mail.Read application permission with admin consent.
// - Emails from senders that match a client's email are stored in case_emails
//   (deduped on graph_id); unmatched senders are skipped entirely.
// =============================================================================

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Content-Type": "application/json",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

// BE-7: production has no 'staff' rows; match the role set process-emails uses.
const STAFF_ROLES = ["owner", "admin", "adviser", "staff"];
// R84: who may press the button. STAFF_ROLES is still used for the mailbox fallback list.
const MANUAL_ROLES = ["owner", "admin"];   // R84

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const PAGE_SIZE = 50;
const MAX_PAGES_PER_MAILBOX = 4;
const DEFAULT_LOOKBACK_DAYS = 7;
const CLOSED_STAGES = ["completed", "not_proceeding"];

type GraphMessage = {
  id: string;
  subject: string | null;
  bodyPreview: string | null;
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime: string;
  webLink: string | null;
};

async function getGraphToken(tenant: string, clientId: string, clientSecret: string): Promise<string> {
  const resp = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error(`Graph token request failed: ${data.error_description ?? data.error ?? resp.status}`);
  }
  return data.access_token as string;
}

async function fetchMailboxMessages(
  token: string,
  mailbox: string,
  cursor: string,
): Promise<GraphMessage[]> {
  const select = "id,subject,bodyPreview,from,receivedDateTime,webLink";
  let url =
    `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/messages` +
    `?$filter=${encodeURIComponent(`receivedDateTime gt ${cursor}`)}` +
    `&$orderby=${encodeURIComponent("receivedDateTime asc")}` +
    `&$top=${PAGE_SIZE}` +
    `&$select=${select}`;

  const messages: GraphMessage[] = [];
  for (let page = 0; page < MAX_PAGES_PER_MAILBOX && url; page++) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Graph ${resp.status} for ${mailbox}: ${body.slice(0, 300)}`);
    }
    const data = await resp.json();
    messages.push(...((data.value ?? []) as GraphMessage[]));
    url = data["@odata.nextLink"] ?? "";
  }
  return messages;
}

async function getMailboxes(admin: SupabaseClient): Promise<string[]> {
  const { data: setting } = await admin
    .from("settings")
    .select("value")
    .eq("key", "outlook_mailboxes")
    .maybeSingle();

  const configured = (setting?.value ?? "")
    .split(",")
    .map((s: string) => s.trim().toLowerCase())
    .filter(Boolean);
  if (configured.length > 0) return configured;

  const { data: staff, error } = await admin
    .from("profiles")
    .select("email")
    .in("role", STAFF_ROLES)
    .not("email", "is", null);
  if (error) throw new Error(error.message);
  return (staff ?? []).map((p: { email: string }) => p.email.trim().toLowerCase()).filter(Boolean);
}

async function getClientEmailMap(admin: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await admin.from("clients").select("id, email").not("email", "is", null);
  if (error) throw new Error(error.message);
  const map = new Map<string, string>();
  for (const c of data ?? []) {
    if (c.email) map.set(String(c.email).toLowerCase(), c.id);
  }
  return map;
}

async function findCaseForClient(
  admin: SupabaseClient,
  clientId: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (cache.has(clientId)) return cache.get(clientId)!;

  const { data: live } = await admin
    .from("cases")
    .select("id")
    .eq("client_id", clientId)
    .not("stage", "in", `(${CLOSED_STAGES.join(",")})`)
    .order("created_at", { ascending: false })
    .limit(1);

  let caseId: string | null = live?.[0]?.id ?? null;
  if (!caseId) {
    const { data: anyStage } = await admin
      .from("cases")
      .select("id")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(1);
    caseId = anyStage?.[0]?.id ?? null;
  }

  cache.set(clientId, caseId);
  return caseId;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: CORS_HEADERS });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "unauthorized" }, 401);

    const userDb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const { data: userData, error: userErr } = await userDb.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const uc = userDb;   // R86 · V1 — the caller's own JWT client, already built above
    const { data: ok, error: okErr } = await uc.rpc("session_ok");   // R86 · V1
    if (okErr || ok !== true) return json({ error: "second factor required" }, 403);   // R86 · V1

    const { data: profile } = await userDb
      .from("profiles")
      .select("id, full_name, email, role")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (!profile || !MANUAL_ROLES.includes(profile.role)) return json({ error: "unauthorized" }, 401);   // R84: was STAFF_ROLES

    const tenant = Deno.env.get("MS_TENANT_ID");
    const clientId = Deno.env.get("MS_CLIENT_ID");
    const clientSecret = Deno.env.get("MS_CLIENT_SECRET");
    if (!tenant || !clientId || !clientSecret) {
      return json({ error: "not_configured" });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = await getGraphToken(tenant, clientId, clientSecret);
    const mailboxes = await getMailboxes(admin);
    const clientMap = await getClientEmailMap(admin);
    const caseCache = new Map<string, string | null>();

    let fetched = 0;
    let matched = 0;
    let inserted = 0;
    const errors: string[] = [];

    for (const mailbox of mailboxes) {
      const cursorKey = `outlook_cursor_${mailbox}`;

      const { data: state } = await admin
        .from("sync_state")
        .select("value")
        .eq("key", cursorKey)
        .maybeSingle();
      const cursor =
        state?.value ||
        new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

      let messages: GraphMessage[];
      try {
        messages = await fetchMailboxMessages(token, mailbox, cursor);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
        continue;
      }

      fetched += messages.length;
      let latestReceived = "";
      // R84: once an upsert fails, the cursor must not move past it (or past anything after it),
      // otherwise that message is silently lost. Messages arrive in receivedDateTime order.
      let cursorFrozen = false;   // R84

      for (const msg of messages) {
        const sender = msg.from?.emailAddress?.address?.toLowerCase() ?? "";
        const clientId2 = sender ? clientMap.get(sender) : undefined;
        if (!clientId2) {
          // R84: nothing to store — safe to advance past it (unless already frozen).
          if (!cursorFrozen && msg.receivedDateTime && msg.receivedDateTime > latestReceived) latestReceived = msg.receivedDateTime;   // R84
          continue;
        }
        matched++;

        const caseId = await findCaseForClient(admin, clientId2, caseCache);

        const { data: upserted, error: upErr } = await admin
          .from("case_emails")
          .upsert(
            {
              graph_id: msg.id,
              mailbox,
              client_id: clientId2,
              case_id: caseId,
              direction: "inbound",
              from_email: sender,
              from_name: msg.from?.emailAddress?.name ?? null,
              subject: msg.subject,
              snippet: msg.bodyPreview,
              received_at: msg.receivedDateTime,
              web_link: msg.webLink,
            },
            { onConflict: "graph_id", ignoreDuplicates: true },
          )
          .select("id");
        if (upErr) {
          errors.push(`insert failed for ${msg.id} (${mailbox}): ${upErr.message}`);
          cursorFrozen = true;   // R84: this and everything after it must be re-fetched next run
          continue;
        }
        inserted += upserted?.length ?? 0;
        // R84: stored (or already present) — safe to advance past it.
        if (!cursorFrozen && msg.receivedDateTime && msg.receivedDateTime > latestReceived) latestReceived = msg.receivedDateTime;   // R84
      }

      if (latestReceived) {
        const { error: curErr } = await admin
          .from("sync_state")
          .upsert(
            { key: cursorKey, value: latestReceived, updated_at: new Date().toISOString() },
            { onConflict: "key" },
          );
        if (curErr) errors.push(`cursor update failed for ${mailbox}: ${curErr.message}`);
      }
    }

    return json({ mailboxes: mailboxes.length, fetched, matched, inserted, errors });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("outlook-sync error:", message);
    return json({ error: message }, 500);
  }
});
