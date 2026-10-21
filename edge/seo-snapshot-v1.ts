// =============================================================================
// seo-snapshot v1 — R93 · A (Website › SEO tab)
// Nightly by pg_cron 02:30 UTC (x-cron-key = settings.cron_key, process-emails' pattern; see
// db/r93/02_cron.sql), or by an owner/admin JWT (owner-digest v7's gate: session_ok() → 403,
// profiles.role owner/admin) with { force: true } from "Run audit now".
// Steps: (1) sitemap → per-page audit fetch (8 concurrent);
//        (2) PageSpeed Insights mobile, ≤8 pages, sequential with 1 s gap, each call ≤12 s, stop
//            when <10 s of budget remain, skip on 429 (+ &key= when the PSI_API_KEY secret exists);
//        (3) internal link check with whatever budget remains (≤150 links, 8 concurrent; the
//            number left unchecked is noted);
//        GSC (when the GSC_SERVICE_ACCOUNT secret exists) runs alongside all three: RS256 JWT via
//            WebCrypto → token → searchAnalytics.query, 28 days ending today−2;
//        (4) upsert rows on (day, kind, page); (5) the summary row.
// Row `data` shapes are frozen in R93-CONTRACT.md (the SEO tab renders them). R93 · fixer: the
// summary also carries run_errors: string[] (≤20, ≤200 chars, redacted) — `errors` there is the
// issue COUNT the tiles read, so the step failures cannot share that name.
// BUDGET: everything must finish inside ~50 s. PSI goes before the link check so a slow link
// sweep can never starve it. Every error string passes redact() — the PSI key rides in a URL and
// Deno's fetch errors quote the URL. The handler never throws: it returns { ok, summary, errors:[…] }.
// =============================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MANUAL_ROLES = ["owner", "admin"];

const SITE = "https://www.nexmoney.co.uk";
const SITE_HOSTS = new Set(["www.nexmoney.co.uk", "nexmoney.co.uk"]);
const UA = "NexMoney-SEO-Audit/1.0 (+https://www.nexmoney.co.uk)";
const BUDGET_MS = 48_000;          // hard ceiling for all network work; the DB writes follow
const MAX_PAGES = 40;
const MAX_LINKS = 150;
const CONCURRENCY = 8;
const PSI_MAX_PAGES = 8;
const PSI_CALL_MS = 12_000;
const PSI_MIN_LEFT_MS = 10_000;    // don't start a PSI call with less than this left
const RUN_ERRORS_MAX = 20;
const GSC_QUERY_ROWS = 50;

type Issue = { code: string; level: "error" | "warn"; msg: string };
type Audit = {
  status: number; title: string | null; title_len: number; meta: string | null; meta_len: number;
  h1: string | null; h1_count: number; canonical: string | null; canonical_ok: boolean; words: number;
  internal_links: number; broken_links: Array<{ href: string; status: number }>; images_no_alt: number;
  has_jsonld: boolean; issues: Issue[];
};
type Row = { day: string; kind: string; page: string; data: unknown };

// ---------------------------------------------------------------- auth (cron key OR owner/admin JWT)
async function authorize(req: Request): Promise<"cron" | "user" | "mfa" | null> {
  const cronKey = req.headers.get("x-cron-key");
  if (cronKey) {
    const { data } = await admin.from("settings").select("value").eq("key", "cron_key").maybeSingle();
    if (data?.value && cronKey === data.value) return "cron";
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  if (token) {
    const uc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: u } = await uc.auth.getUser();
    if (u?.user) {
      const { data: ok, error: okErr } = await uc.rpc("session_ok");   // R86 · V1
      if (okErr || ok !== true) return "mfa";
      const { data: p } = await admin.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
      if (p?.role && MANUAL_ROLES.includes(p.role)) return "user";
    }
  }
  return null;
}

// ---------------------------------------------------------------- helpers
function redact(s: string): string {
  return String(s).replace(/([?&]key=)[^&\s"']+/g, "$1<redacted>");
}
function msg(e: unknown): string {
  const s = e instanceof Error ? (e.name === "AbortError" ? "timed out" : e.message) : String(e);
  return redact(s).replace(/\s+/g, " ").slice(0, 200);
}
function utcDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}
function makeDeadline(start: number) {
  const end = start + BUDGET_MS;
  return { left: () => end - Date.now() };
}
type Deadline = ReturnType<typeof makeDeadline>;

// Every external call goes through here: a timeout capped by what is left of the budget.
async function fetchT(url: string, init: RequestInit, ms: number, dl: Deadline): Promise<Response> {
  const budget = Math.min(ms, dl.left() - 500);
  if (budget < 800) throw new Error("budget exhausted");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), budget);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, headers: { "User-Agent": UA, ...(init.headers || {}) } });
  } finally {
    clearTimeout(timer);
  }
}
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  });
  await Promise.all(workers);
  return out;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decode(s: string): string {
  return s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&mdash;/gi, "—").replace(/&ndash;/gi, "–")
    .replace(/&pound;/gi, "£").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n) || 32));
}
function stripTags(s: string): string {
  return decode(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const inner = tag.replace(/^<\s*[a-zA-Z0-9]+/, "").replace(/\/?>$/, "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}
function tags(html: string, name: string): Record<string, string>[] {
  return (html.match(new RegExp(`<${name}\\b[^>]*>`, "gi")) || []).map(attrs);
}
function pathOf(u: string): string {
  try { const x = new URL(u); return x.pathname || "/"; } catch { return u; }
}
function normUrl(u: string): string {
  try { const x = new URL(u); x.hash = ""; const p = x.pathname.replace(/\/+$/, "") || "/"; return `${x.protocol}//${x.host}${p}${x.search}`; } catch { return u; }
}

// ---------------------------------------------------------------- (1) audit
function auditHtml(pageUrl: string, status: number, html: string): { audit: Audit; links: string[] } {
  const issues: Issue[] = [];
  const titleM = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? stripTags(titleM[1]) || null : null;
  const metaTag = tags(html, "meta").find((a) => (a.name || "").toLowerCase() === "description");
  const meta = metaTag && metaTag.content ? metaTag.content.trim() || null : null;
  const h1s = html.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi) || [];
  const h1 = h1s.length ? stripTags(h1s[0]) || null : null;
  const canonTag = tags(html, "link").find((a) => (a.rel || "").toLowerCase().split(/\s+/).includes("canonical"));
  const canonical = canonTag?.href ? canonTag.href : null;
  const canonical_ok = !!canonical && normUrl(new URL(canonical, pageUrl).toString()) === normUrl(pageUrl);
  const bodyM = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  const bodyText = stripTags((bodyM ? bodyM[1] : html).replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " "));
  const words = bodyText ? bodyText.split(/\s+/).filter((w) => /[A-Za-z0-9£]/.test(w)).length : 0;
  const links = new Set<string>();
  for (const a of tags(html, "a")) {
    const href = (a.href || "").trim();
    if (!href || /^(mailto:|tel:|javascript:|#|data:)/i.test(href)) continue;
    try {
      const u = new URL(href, pageUrl);
      if (!SITE_HOSTS.has(u.host) || !/^https?:$/.test(u.protocol)) continue;
      u.hash = "";
      links.add(u.toString());
    } catch { /* malformed href — not a link we can check */ }
  }
  const images_no_alt = tags(html, "img").filter((a) => !("alt" in a)).length;
  const has_jsonld = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["']/i.test(html);

  if (status !== 200) issues.push({ code: "http_error", level: "error", msg: `HTTP ${status}` });
  if (!title) issues.push({ code: "missing_title", level: "error", msg: "No <title>" });
  else if (title.length > 60) issues.push({ code: "title_long", level: "warn", msg: `Title is ${title.length} characters (over 60)` });
  else if (title.length < 30) issues.push({ code: "title_short", level: "warn", msg: `Title is ${title.length} characters (under 30)` });
  if (!meta) issues.push({ code: "missing_meta", level: "error", msg: "No meta description" });
  else if (meta.length > 160) issues.push({ code: "meta_long", level: "warn", msg: `Description is ${meta.length} characters (over 160)` });
  else if (meta.length < 70) issues.push({ code: "meta_short", level: "warn", msg: `Description is ${meta.length} characters (under 70)` });
  if (h1s.length === 0) issues.push({ code: "no_h1", level: "error", msg: "No <h1>" });
  else if (h1s.length > 1) issues.push({ code: "multi_h1", level: "warn", msg: `${h1s.length} <h1> elements` });
  if (!canonical_ok) issues.push({ code: "canonical_mismatch", level: "warn", msg: canonical ? `Canonical points to ${canonical}` : "No canonical link" });
  if (images_no_alt > 0) issues.push({ code: "img_no_alt", level: "warn", msg: `${images_no_alt} image${images_no_alt === 1 ? "" : "s"} without alt` });
  if (status === 200 && words < 250) issues.push({ code: "thin_content", level: "warn", msg: `${words} words (under 250)` });

  return {
    audit: {
      status, title, title_len: title ? title.length : 0, meta, meta_len: meta ? meta.length : 0,
      h1, h1_count: h1s.length, canonical, canonical_ok, words, internal_links: links.size,
      broken_links: [], images_no_alt, has_jsonld, issues,
    },
    links: [...links],
  };
}

async function linkStatus(url: string, dl: Deadline): Promise<number> {
  try {
    let r = await fetchT(url, { method: "HEAD", redirect: "follow" }, 6_000, dl);
    if (r.status === 405 || r.status === 501) {
      r = await fetchT(url, { method: "GET", redirect: "follow" }, 6_000, dl);
      await r.body?.cancel().catch(() => {});
    }
    return r.status;
  } catch {
    return 0;   // unreachable/timed out: not reported as broken (a network blip is not a 404)
  }
}

type AuditRun = { pages: string[]; audits: Map<string, Audit>; pageLinks: Map<string, string[]>; known: Map<string, number> };
async function runAudit(dl: Deadline, errors: string[]): Promise<AuditRun> {
  const audits = new Map<string, Audit>();
  const pageLinks = new Map<string, string[]>();
  const known = new Map<string, number>();    // normUrl → status, from the page fetches themselves
  let locs: string[] = [];
  try {
    const r = await fetchT(`${SITE}/sitemap.xml`, {}, 8_000, dl);
    if (!r.ok) throw new Error(`sitemap HTTP ${r.status}`);
    const xml = await r.text();
    locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1])).slice(0, MAX_PAGES);
  } catch (e) {
    errors.push(`sitemap: ${msg(e)}`);
    return { pages: [], audits, pageLinks, known };
  }

  await pool(locs, CONCURRENCY, async (loc) => {
    const page = pathOf(loc);
    try {
      const r = await fetchT(loc, { redirect: "follow" }, 10_000, dl);
      const html = r.status === 200 ? await r.text() : "";
      known.set(normUrl(loc), r.status);
      const { audit, links } = auditHtml(loc, r.status, html);
      audits.set(page, audit);
      pageLinks.set(page, links);
    } catch (e) {
      errors.push(`audit ${page}: ${msg(e)}`);
    }
  });

  // Site-wide duplicates.
  const dup = (key: "title" | "meta", code: string, label: string) => {
    const by = new Map<string, string[]>();
    for (const [page, a] of audits) { const v = a[key]; if (v) by.set(v, [...(by.get(v) || []), page]); }
    for (const pages of by.values()) {
      if (pages.length < 2) continue;
      for (const p of pages) audits.get(p)!.issues.push({ code, level: "warn", msg: `Same ${label} as ${pages.filter((x) => x !== p).join(", ")}` });
    }
  };
  dup("title", "dup_title", "title");
  dup("meta", "dup_meta", "description");
  return { pages: locs, audits, pageLinks, known };
}

// ---------------------------------------------------------------- (3) internal link check (after PSI)
async function runLinks(run: AuditRun, dl: Deadline, errors: string[]): Promise<void> {
  const { audits, pageLinks, known } = run;
  // Unique targets across the site; the sitemap pages answered already.
  const targets = [...new Set([...pageLinks.values()].flat().map(normUrl))].filter((u) => !known.has(u));
  const toCheck = targets.slice(0, MAX_LINKS);
  if (targets.length > MAX_LINKS) errors.push(`links: ${targets.length - MAX_LINKS} beyond the ${MAX_LINKS} cap not checked`);
  let skipped = 0;
  const statuses = await pool(toCheck, CONCURRENCY, async (u) => {
    if (dl.left() < 1_300) { skipped++; return -1; }   // fetchT's own floor: past it, say so rather than guess
    return linkStatus(u, dl);
  });
  if (skipped) errors.push(`links: budget reached, ${skipped} of ${toCheck.length} not checked`);
  toCheck.forEach((u, i) => { if (statuses[i] >= 0) known.set(u, statuses[i]); });

  for (const [page, links] of pageLinks) {
    const a = audits.get(page);
    if (!a) continue;
    const seen = new Set<string>();
    for (const l of links) {
      const n = normUrl(l);
      const st = known.get(n);
      if (st != null && st >= 400 && !seen.has(n)) { seen.add(n); a.broken_links.push({ href: pathOf(l) + (new URL(l).search || ""), status: st }); }
    }
    if (a.broken_links.length) a.issues.push({ code: "broken_link", level: "error", msg: `${a.broken_links.length} broken internal link${a.broken_links.length === 1 ? "" : "s"}` });
  }
}

// ---------------------------------------------------------------- (2) PageSpeed Insights
async function runPsi(locs: string[], dl: Deadline, errors: string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const key = Deno.env.get("PSI_API_KEY");
  const list = locs.slice(0, PSI_MAX_PAGES);
  for (let i = 0; i < list.length; i++) {
    if (dl.left() < PSI_MIN_LEFT_MS) { errors.push(`psi: budget reached after ${i} of ${list.length} pages`); break; }
    if (i > 0) await sleep(1_000);
    const loc = list[i];
    const url = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(loc)}&strategy=mobile&category=performance${key ? `&key=${encodeURIComponent(key)}` : ""}`;
    try {
      const r = await fetchT(url, {}, PSI_CALL_MS, dl);
      if (r.status === 429) { await r.body?.cancel().catch(() => {}); errors.push(`psi ${pathOf(loc)}: 429 rate limited`); continue; }
      if (!r.ok) { await r.body?.cancel().catch(() => {}); errors.push(`psi ${pathOf(loc)}: HTTP ${r.status}`); continue; }
      const j = await r.json();
      const lh = j?.lighthouseResult;
      const au = lh?.audits || {};
      const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
      const score = num(lh?.categories?.performance?.score);
      out.set(pathOf(loc), {
        strategy: "mobile",
        performance: score == null ? null : Math.round(score * 100),
        lcp_ms: num(au["largest-contentful-paint"]?.numericValue) == null ? null : Math.round(au["largest-contentful-paint"].numericValue),
        cls: num(au["cumulative-layout-shift"]?.numericValue) == null ? null : Math.round(au["cumulative-layout-shift"].numericValue * 1000) / 1000,
        inp_ms: num(j?.loadingExperience?.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile),
        fcp_ms: num(au["first-contentful-paint"]?.numericValue) == null ? null : Math.round(au["first-contentful-paint"].numericValue),
        fetched_at: new Date().toISOString(),
      });
    } catch (e) {
      errors.push(`psi ${pathOf(loc)}: ${msg(e)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- (3) Search Console
function b64url(bytes: Uint8Array | string): string {
  const bin = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(typeof bytes === "string" ? unescape(encodeURIComponent(bin)) : bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function googleToken(sa: { client_email: string; private_key: string }, dl: Deadline): Promise<string> {
  const pem = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\\n|\s/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${claims}`)));
  const assertion = `${head}.${claims}.${b64url(sig)}`;
  const r = await fetchT("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  }, 8_000, dl);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`token HTTP ${r.status}${j?.error ? " " + j.error : ""}`);
  return j.access_token as string;
}
type GscRow = { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number };
function gscData(r: GscRow) {
  return { clicks: r.clicks ?? 0, impressions: r.impressions ?? 0, ctr: Math.round((r.ctr ?? 0) * 10_000) / 10_000, position: Math.round((r.position ?? 0) * 10) / 10 };
}
async function runGsc(property: string, dl: Deadline, errors: string[]): Promise<{ connected: boolean; total: ReturnType<typeof gscData> | null; pages: Map<string, unknown>; queries: Map<string, unknown> }> {
  const res = { connected: false, total: null as ReturnType<typeof gscData> | null, pages: new Map<string, unknown>(), queries: new Map<string, unknown>() };
  const raw = Deno.env.get("GSC_SERVICE_ACCOUNT");
  if (!raw) return res;
  try {
    const sa = JSON.parse(raw);
    if (!sa?.client_email || !sa?.private_key) throw new Error("GSC_SERVICE_ACCOUNT lacks client_email/private_key");
    const token = await googleToken(sa, dl);
    const endDate = utcDay(-2), startDate = utcDay(-29);   // 28 days inclusive, ending today−2
    const q = async (dimensions: string[], rowLimit: number): Promise<GscRow[]> => {
      const r = await fetchT(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(property)}/searchAnalytics/query`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate, dimensions, rowLimit }),
      }, 10_000, dl);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`query[${dimensions.join(",") || "total"}] HTTP ${r.status}${j?.error?.message ? " " + String(j.error.message).slice(0, 120) : ""}`);
      return (j.rows || []) as GscRow[];
    };
    const [totalRows, pageRows, queryRows] = await Promise.all([q([], 1), q(["page"], 500), q(["query"], GSC_QUERY_ROWS)]);
    res.connected = true;
    res.total = totalRows[0] ? gscData(totalRows[0]) : { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    for (const r of pageRows) if (r.keys?.[0]) res.pages.set(pathOf(r.keys[0]), gscData(r));
    for (const r of queryRows) if (r.keys?.[0]) res.queries.set(r.keys[0], gscData(r));
  } catch (e) {
    errors.push(`gsc: ${msg(e)}`);
  }
  return res;
}

// ---------------------------------------------------------------- handler
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: CORS });
  const started = Date.now();
  const errors: string[] = [];
  try {
    const who = await authorize(req);
    if (who === "mfa") return json({ ok: false, error: "second factor required" }, 403);
    if (!who) return json({ ok: false, error: "unauthorized" }, 401);

    let body: { force?: boolean } | null = null;
    try { body = await req.json(); } catch { /* empty body = cron */ }
    const force = body?.force === true;

    const { data: settingsRows } = await admin.from("settings").select("key, value").in("key", ["seo_audit_enabled", "gsc_property"]);
    const settings = new Map((settingsRows || []).map((r: { key: string; value: string | null }) => [r.key, (r.value ?? "").trim()]));
    if (settings.get("seo_audit_enabled") === "off" && !force) return json({ ok: true, skipped: "disabled", summary: null, errors });

    const dl = makeDeadline(started);
    const day = utcDay(0);

    // Audit fetch → PSI → link check with what remains — GSC runs alongside all three.
    const gscP = runGsc(settings.get("gsc_property") || "sc-domain:nexmoney.co.uk", dl, errors);
    const run = await runAudit(dl, errors);
    const { audits } = run;
    const psi = await runPsi(run.pages, dl, errors);
    await runLinks(run, dl, errors);
    const gsc = await gscP;

    const rows: Row[] = [];
    for (const [page, a] of audits) rows.push({ day, kind: "audit", page, data: a });
    for (const [page, d] of psi) rows.push({ day, kind: "psi", page, data: d });
    for (const [page, d] of gsc.pages) rows.push({ day, kind: "gsc", page, data: d });
    for (const [query, d] of gsc.queries) rows.push({ day, kind: "gsc_query", page: query, data: d });

    let errCount = 0, warnCount = 0;
    for (const a of audits.values()) for (const i of a.issues) { if (i.level === "error") errCount++; else warnCount++; }
    const perf = [...psi.values()].map((d) => (d as { performance: number | null }).performance).filter((v): v is number => typeof v === "number");
    const summary = {
      pages: audits.size, errors: errCount, warnings: warnCount,
      psi_avg: perf.length ? Math.round(perf.reduce((s, v) => s + v, 0) / perf.length) : null,
      gsc: gsc.connected ? gsc.total : null, gsc_connected: gsc.connected, psi_connected: psi.size > 0,
      duration_ms: Date.now() - started, ran_at: new Date().toISOString(),
      run_errors: errors.slice(0, RUN_ERRORS_MAX).map((e) => redact(e).slice(0, 200)),
    };
    rows.push({ day, kind: "summary", page: "", data: summary });

    let written = 0;
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = await admin.from("seo_snapshots").upsert(chunk, { onConflict: "day,kind,page" });
      if (error) errors.push(`upsert: ${msg(error.message)}`); else written += chunk.length;
    }
    summary.duration_ms = Date.now() - started;
    return json({ ok: written > 0 && written === rows.length, summary, rows: written, errors: errors.map(redact) });
  } catch (err) {
    errors.push(msg(err));
    return json({ ok: false, summary: null, errors: errors.map(redact) });
  }
});
