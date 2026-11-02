// R94 · D: v6 = v5 + CORS allow-list (echo a NexMoney origin, else www) + 10 MB+64 KB body cap before req.formData(). Nothing else.
// doc-upload — public JSON/multipart API behind the client document upload link.
// Auth is the per-case cases.doc_token (verify_jwt disabled), exactly as fact-find
// authenticates on fact_finds.token. GET returns the outstanding checklist for the
// one-page form; POST accepts a single file against a single checklist item.
//
// The page itself is served from the website (/docs?token=…) because Supabase
// rewrites edge HTML to plain text — same split as the digital fact-find.
//
// Data minimisation: the GET payload carries the client's FIRST NAME and nothing
// else personal. No surname, email, phone, address, lender, or amounts — the link
// is a bearer token that may end up forwarded, so it must not leak a client file.
import { createClient } from "jsr:@supabase/supabase-js@2";

// R94 · D: browsers may call this only from the site (R95: vercel.app origin dropped a week after cutover).
const ORIGINS = ["https://www.nexmoney.co.uk", "https://nexmoney.co.uk"];
const withCors = (req: Request, res: Response): Response => {
  const o = req.headers.get("origin") ?? "";
  res.headers.set("Access-Control-Allow-Origin", ORIGINS.includes(o) ? o : ORIGINS[0]);
  res.headers.set("Vary", "Origin");
  return res;
};
// R94 · D: refuse an oversized body from its Content-Length before buffering it (10 MB file + multipart overhead; MAX_BYTES is declared later).
const MAX_BODY = 10 * 1024 * 1024 + 64 * 1024;
const tooBig = (req: Request) => Number(req.headers.get("content-length") ?? 0) > MAX_BODY;

const CORS = {
  "Access-Control-Allow-Origin": ORIGINS[0],   // R94 · D: withCors() sets the per-request value
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const uuidRe = /^[0-9a-fA-F-]{36}$/;

const BUCKET = "client-docs";
const MAX_BYTES = 10 * 1024 * 1024;          // 10MB
const MAX_UPLOADS_PER_TOKEN_PER_HOUR = 20;

// v3 (R79): 30-day link expiry, enforced on both verbs. A doc link past
// cases.doc_token_expires_at can neither list the checklist nor receive files —
// the client is told to ask for a fresh one (regenerate lives on the case screen).
// Null expiry (pre-R79 legacy) never expires.
const linkExpired = (row: any) => !!(row && row.doc_token_expires_at && Date.parse(row.doc_token_expires_at) < Date.now());
const EXPIRED_MSG = { error: "link_expired", message: "This link has expired — just reply to the email that brought you here (or give us a ring) and we'll send a fresh one." };

// Extension is authoritative for what we store; the browser-declared type only
// has to agree with it (or be the generic octet-stream that some phones send
// for HEIC). Both then have to agree with the actual bytes.
const ALLOWED: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  heif: "image/heif",
};
const ALLOWED_TYPES = new Set(Object.values(ALLOWED).concat(["image/jpg"]));

async function companyName(): Promise<string> {
  const { data } = await admin.from("settings").select("value").eq("key", "company_name").maybeSingle();
  return data?.value || "NexMoney";
}

// Case lookup by token. Selects the bare minimum: the id we key writes on, the
// client id needed to fetch a first name, and the expiry the door check reads.
async function caseForToken(token: string) {
  const { data } = await admin.from("cases").select("id, client_id, doc_token_expires_at").eq("doc_token", token).maybeSingle();
  return data ?? null;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document";

// Content sniffing: a file called invoice.pdf that is really an HTML document is
// the classic way to turn a private bucket into a stored-XSS vector for whoever
// opens it later. Check the magic bytes actually match the claimed kind.
function bytesLookLike(ext: string, b: Uint8Array): boolean {
  if (b.length < 12) return false;
  const ascii = (o: number, n: number) => Array.from(b.slice(o, o + n)).map((c) => String.fromCharCode(c)).join("");
  if (ext === "pdf") return ascii(0, 5) === "%PDF-";
  if (ext === "jpg" || ext === "jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === "png") return b[0] === 0x89 && ascii(1, 3) === "PNG";
  if (ext === "heic" || ext === "heif") return ascii(4, 4) === "ftyp";
  return false;
}

const handle = async (req: Request): Promise<Response> => {   // R94 · D: served via withCors() below
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (tooBig(req)) return json({ error: "file too large (10MB max)" }, 413);   // R94 · D

  const url = new URL(req.url);

  // ---- Load the checklist ---------------------------------------------------
  if (req.method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    if (!uuidRe.test(token)) return json({ error: "invalid link" }, 400);
    const kase = await caseForToken(token);
    if (!kase) return json({ error: "not_found" }, 404);
    if (linkExpired(kase)) return json(EXPIRED_MSG, 410);   // v3: expiry at the door

    let firstName = "";
    if (kase.client_id) {
      const { data: cl } = await admin.from("clients").select("first_name").eq("id", kase.client_id).maybeSingle();
      firstName = (cl?.first_name ?? "").trim();
    }

    // Item name and status only. Waived items are not the client's business.
    const { data: docs } = await admin.from("case_documents")
      .select("id, item, status")
      .eq("case_id", kase.id)
      .in("status", ["requested", "received"])
      .order("created_at", { ascending: true });

    const items = (docs ?? []).map((d: any) => ({ id: d.id, item: d.item, status: d.status }));
    return json({
      ok: true,
      first_name: firstName,
      company: await companyName(),
      items,
      outstanding: items.filter((i) => i.status === "requested").length,
    });
  }

  // ---- Receive a file -------------------------------------------------------
  if (req.method === "POST") {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: "expected multipart/form-data" }, 400);
    }

    // Honeypot: a hidden field no real client ever fills in. Answer as though it
    // worked so a bot learns nothing.
    if (String(form.get("website") ?? "").trim()) return json({ ok: true });

    const token = String(form.get("token") ?? "");
    const itemId = String(form.get("item_id") ?? "");
    if (!uuidRe.test(token)) return json({ error: "invalid link" }, 400);
    if (!uuidRe.test(itemId)) return json({ error: "invalid item" }, 400);

    const kase = await caseForToken(token);
    if (!kase) return json({ error: "not_found" }, 404);
    if (linkExpired(kase)) return json(EXPIRED_MSG, 410);   // v3: expiry at the door

    // The item must belong to THIS case — the token authorises one case only.
    const { data: doc } = await admin.from("case_documents")
      .select("id, item, status")
      .eq("id", itemId).eq("case_id", kase.id).maybeSingle();
    if (!doc) return json({ error: "unknown item" }, 404);
    if (doc.status !== "requested") return json({ error: "already received", status: doc.status }, 409);

    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "no file" }, 400);
    if (file.size === 0) return json({ error: "empty file" }, 400);
    if (file.size > MAX_BYTES) return json({ error: "file too large (10MB max)" }, 413);

    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    const mapped = ALLOWED[ext];
    if (!mapped) return json({ error: "unsupported file type — PDF, JPG, PNG or HEIC only" }, 415);
    const declared = (file.type || "").toLowerCase();
    if (declared && declared !== "application/octet-stream" && !ALLOWED_TYPES.has(declared)) {
      return json({ error: "unsupported file type — PDF, JPG, PNG or HEIC only" }, 415);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > MAX_BYTES) return json({ error: "file too large (10MB max)" }, 413);
    if (!bytesLookLike(ext, bytes)) return json({ error: "that file does not look like a " + ext.toUpperCase() }, 415);

    // Rate cap per token per hour, measured on what actually landed in the bucket
    // for this case. No new table: the objects themselves are the counter.
    const { data: existing } = await admin.storage.from(BUCKET).list(kase.id, { limit: 100 });
    const hourAgo = Date.now() - 3600_000;
    const recent = (existing ?? []).filter((o: any) => o?.created_at && Date.parse(o.created_at) > hourAgo).length;
    if (recent >= MAX_UPLOADS_PER_TOKEN_PER_HOUR) {
      return json({ error: "too many uploads — please try again later" }, 429);
    }

    const path = `${kase.id}/${slug(doc.item)}-${Date.now()}.${ext}`;
    const { error: upErr } = await admin.storage.from(BUCKET)
      .upload(path, bytes, { contentType: mapped, upsert: false });
    if (upErr) return json({ error: "could not store file" }, 500);

    // Claim the row. The status guard makes two simultaneous uploads for the same
    // item resolve to one winner rather than two half-applied writes.
    const { data: updated, error: updErr } = await admin.from("case_documents")
      .update({ status: "received", storage_path: `${BUCKET}/${path}`, received_at: new Date().toISOString() })
      .eq("id", doc.id).eq("status", "requested").select("id").maybeSingle();
    if (updErr || !updated) {
      await admin.storage.from(BUCKET).remove([path]);   // no orphan objects
      return json({ error: "could not record upload" }, 409);
    }

    // Item names are staff-authored, not client input, but the note is rendered in
    // the app so keep the angle brackets out of it regardless.
    const safeItem = String(doc.item).replace(/[<>]/g, "");
    await admin.from("case_notes").insert({
      case_id: kase.id,
      body: `Document received via upload link: ${safeItem}`,
    });

    const { count } = await admin.from("case_documents")
      .select("id", { count: "exact", head: true })
      .eq("case_id", kase.id).eq("status", "requested");

    return json({ ok: true, item: doc.item, outstanding: count ?? 0 });
  }

  return json({ error: "method not allowed" }, 405);
};
Deno.serve(async (req: Request) => withCors(req, await handle(req)));   // R94 · D
