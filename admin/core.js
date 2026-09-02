/* ==========================================================================
   NexMoney Back Office — admin/core.js  (R78 · A7)

   THE FIRST CARVE OF app.js: strictly PURE, DEPENDENCY-FREE LEAF UTILITIES,
   loaded via a classic <script> tag BEFORE /admin/app.js (see index.html).
   Classic scripts share one global scope, so everything declared here is
   visible to app.js exactly as it was when these lived there — moved, not
   rewritten. THE RULE (HARNESS.md "R78 · A"): a declaration may live here ONLY
   if it references nothing that stays in app.js at its own DEFINITION time
   (call-time references to late globals such as ME / MY_ROLE / db /
   OWNER_ROW_CAP are fine — by the time anything here runs, app.js has long
   evaluated). Nothing page-specific, no overlays/modals, no prop engine.

   What lives here, in order:
     · the R21/R30 error-capture block (ERROR_LOG, logClientError, the two
       global handlers) — moved ABOVE everything so the handlers are installed
       before any other script line can throw, plus R78's dbFail()
     · $, esc, debounce
     · fmtD (+ FMT_MONTHS), localDateStr / localMonthStr singletons
     · fmtM / fmtM2
     · the toast machinery (TOAST_MS / TOAST_ACTION_MS / toast)
     · inChunks (R64-HF1) and readAll (R69-HF1)
   ========================================================================== */

/* ==========================================================================
   R21 Part A — global client-side error capture (the safety net BELOW
   showFail()/renderLoadError()). Installed here, the earliest safe point after
   `db` exists, so the two window listeners are registered before init() runs and
   catch anything the per-view handlers and the bootstrap catch don't.

   ERROR_LOG is an in-memory ring buffer (capped, session-only, NEVER persisted,
   NEVER sent over the network). Each entry:
     { t:<ISO>, kind:"error"|"promise"|"caught", msg, where, count, [stack],
       [recordId], user:ME?.email, role:MY_ROLE, view:<hash/path> }
   De-dupe: a repeat of the LAST entry's msg inside ERROR_DEDUPE_MS bumps its
   `count` instead of pushing a new row (stops a render loop flooding the buffer)
   and shows NO extra toast. Only a genuinely-new error raises ONE non-blocking
   toast. logClientError() is itself fully try/caught — logging can never throw.
   Privacy: we record message/stack/where only, never the Supabase key or vault
   data, and the buffer is visible solely to owner/admin via the Diagnostics panel. */
const ERROR_LOG = [];
const ERROR_LOG_CAP = 100;
const ERROR_DEDUPE_MS = 5000;
let errorEventsOff = false;   // R30 — once error_events is proven absent/denied this session, stop trying to persist (no console-error storms)
function logClientError(kind, message, detail) {
  try {
    detail = detail || {};
    let msg = String((message && message.message) || message || "").trim();
    if (!msg) msg = "(no message)";
    if (msg.length > 500) msg = msg.slice(0, 500);
    const now = Date.now();
    const last = ERROR_LOG[ERROR_LOG.length - 1];
    if (last && last.msg === msg && (now - (last._ms || 0)) <= ERROR_DEDUPE_MS) {
      last.count = (last.count || 1) + 1;   // de-dupe: bump count, no new row, no new toast
      last._ms = now;
      return;
    }
    const entry = { t: new Date().toISOString(), _ms: now, kind: kind || "error", msg, where: detail.where || "", count: 1 };
    if (detail.recordId != null) entry.recordId = String(detail.recordId);
    if (detail.stack) entry.stack = String(detail.stack).slice(0, 2000);
    try { entry.user = ME ? ME.email : undefined; } catch (_) {}
    try { entry.role = MY_ROLE; } catch (_) {}
    try { entry.view = (location.hash || location.pathname || ""); } catch (_) {}
    ERROR_LOG.push(entry);
    while (ERROR_LOG.length > ERROR_LOG_CAP) ERROR_LOG.shift();
    /* R78 · A6 — detail.quiet suppresses ONLY this generic toast (dbFail brings its own,
       specific one); the entry, the de-dupe and the fingerprint below are untouched by it. */
    if (!detail.quiet) { try { toast("Something went wrong — a diagnostic was logged."); } catch (_) {} }
    /* R30 — best-effort, SANITISED cross-session fingerprint. Only on the NEW-entry
       path (the de-dupe branch above early-returns, so a flood inserts at most one
       row per genuinely-new error). The payload has EXACTLY four coarse fields and
       is built ONLY from local vars — no way for message/stack/recordId/name/email
       to reach it. error_type = the JS error CLASS name from the stack (never the
       message after the colon) or the kind; location = code file:line/fn only;
       page = the base route (ids stripped); role = the staff role already captured.
       Fire-and-forget with BOTH .then handlers so it can never throw or raise an
       unhandledrejection (which would re-enter logClientError → infinite loop). */
    const m = String(detail.stack || "").match(/^\s*([A-Z][A-Za-z]*(?:Error|Exception))\b/);
    const etype = m ? m[1] : (kind || "error");
    const location_ = String(entry.where || "").slice(0, 120);
    let page = "";
    try { page = String(location.hash || "").replace(/^#/, "").split(/[/?]/)[0].slice(0, 40); } catch (_) {}
    try {
      if (!errorEventsOff && window.db && db.from) {
        db.from("error_events").insert([{ error_type: etype, location: location_, page: page, role: entry.role || null }])
          .then((res) => { const c = res && res.error && res.error.code;
                           if (c === "42P01" || c === "42501" || c === "PGRST205" || c === "PGRST106") errorEventsOff = true; },
                () => {});   // BOTH handlers present → no unhandledrejection → no recursion
      }
    } catch (_) {}
  } catch (_) { /* logging must NEVER throw */ }
}
window.logClientError = logClientError;      // so caught-but-notable errors + tests can record one
window.__errorLog = ERROR_LOG;               // stable reference; tests read .length (mutated in place)
try {
  window.addEventListener("error", (e) => {
    logClientError("error", (e && (e.message || (e.error && e.error.message))) || "Uncaught error",
      { where: e && e.filename ? (e.filename + ":" + (e.lineno || 0)) : "", stack: e && e.error && e.error.stack });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e && e.reason;
    logClientError("promise", (r && (r.message || r)) || "Unhandled promise rejection",
      { where: "unhandledrejection", stack: r && r.stack });
  });
} catch (_) { /* addEventListener unavailable — nothing else we can safely do */ }

/* ==========================================================================
   R78 · A6 — dbFail(where, error[, msg]): ONE DOOR FOR A DATABASE FAILURE.

   Seventy-eight call sites used to do `toast("Error: " + error.message)` and
   tell the diagnostics log nothing, so the Diagnostics panel (R30) heard only
   about UNCAUGHT errors while every refused write was swallowed with a toast.
   dbFail keeps each site's user-visible wording BYTE-IDENTICAL (the default
   message is exactly the old concatenation, including "Error: undefined" for
   a message-less object — honesty over polish) and ADDS the logging:
   a "caught"-kind ERROR_LOG entry + the best-effort error_events fingerprint,
   with logClientError's own generic toast suppressed (detail.quiet) so the
   user still sees ONE toast, the specific one.

   RULE (HARNESS.md "R78 · A"): every NEW db-failure toast goes through dbFail.
   Returns undefined, like toast, so `return dbFail(...)` keeps call-site shape.
   ========================================================================== */
function dbFail(where, error, msg) {
  const m = error && typeof error === "object" ? error.message : error;
  try { logClientError("caught", m == null ? "(no message)" : String(m), { where: where || "", stack: error && error.stack, quiet: true }); } catch (_) { /* logging must never block the toast */ }
  return toast(msg != null ? msg : "Error: " + m);
}
window.dbFail = dbFail;

const $ = (s) => document.querySelector(s);
const esc = (s) => (s == null ? "" : String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])));
// R18-P2 — trailing-edge debounce for high-frequency search/filter inputs. The wrapped fn reads the
// live input value at fire time, so the delayed call always sees the latest keystroke.
function debounce(fn, wait) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}
/* T1-21 — fmtD no longer hands a non-ISO string to new Date(). `new Date("01/02/2026")` is parsed
   by the engine as US month-first and silently renders "2 Jan 2026" for a UK 1 February, which is
   exactly how a mis-read import date survived review. Date objects, timestamps and ISO strings
   (the only thing the database ever stores) format as before; anything else is shown verbatim
   (esc'd, since the only source of non-ISO values is un-normalised imported text). */
/* R73 · B4 — the month names are a FIXED TABLE, not toLocaleDateString's.
   `{ month: "short" }` under current ICU renders September as "Sept" (four
   letters) while the other eleven are three, so a column of dates went ragged
   exactly where the rate-end book is busiest, and the same date rendered
   differently on two machines with different ICU versions. Eleven strings is a
   cheaper guarantee than a locale negotiation. */
const FMT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtD = (d) => {
  if (!d) return "—";
  if (typeof d === "string" && !/^\d{4}-\d{2}-\d{2}/.test(d)) return esc(d);
  const t = new Date(d);
  if (isNaN(t.getTime())) return esc(String(d));
  /* Date-only strings are read as the calendar day they name (getUTC*), exactly as
     toLocaleDateString did for them; a full timestamp keeps local-time reading. */
  const dateOnly = typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const day = dateOnly ? t.getUTCDate() : t.getDate();
  const mon = dateOnly ? t.getUTCMonth() : t.getMonth();
  const yr = dateOnly ? t.getUTCFullYear() : t.getFullYear();
  return `${day} ${FMT_MONTHS[mon]} ${yr}`;
};
// UK-local (Europe/London) date-only string YYYY-MM-DD. en-CA gives ISO-style ordering.
// Used for "today"/overdue/horizon comparisons so they don't drift to the UTC calendar date after midnight BST.
// R18-P1: ONE module-level Intl.DateTimeFormat singleton — building a new formatter per call cost
// ~100k allocations on a Reports render (12.9s). Same locale/options, so output is byte-identical.
const _localDateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" });
const localDateStr = (d) => _localDateFmt.format(d ? new Date(d) : new Date());
// UK-local YYYY-MM month bucket for report grouping.
const localMonthStr = (d) => localDateStr(d).slice(0, 7);
const fmtM = (n) => (n == null || n === "" || isNaN(Number(n)) ? "—" : Number(n).toLocaleString("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 }));
// Exact-pence money — for fee figures on the case detail / evidence pack only. Dashboards keep fmtM (whole pounds).
const fmtM2 = (n) => (n == null || n === "" || isNaN(Number(n)) ? "—" : Number(n).toLocaleString("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/* R12a·D12 — THE TOAST CAN NOW CARRY ONE ACTION.
   It was text-only, which is why "Task done" was a one-way door: the row vanished from every list
   and the only route back was the database. `action` is deliberately generic — {label, onClick,
   ms} — and deliberately singular: a toast is a passing sentence, not a menu, and a second button
   on it would be a dialog wearing the wrong clothes. Other flows (delete, waive, dismiss) can use
   the same hook without touching this function again.

   The toast element itself stays pointer-events:none (M7 — it must never intercept a tap on a
   field beneath it); only the action button turns pointer events back on, so an undo link cannot
   swallow clicks on whatever it happens to be floating over. An action toast lives longer than a
   plain one — 10s — because it has to be readable AND reachable, not just readable. */
const TOAST_ACTION_MS = 10000;
const TOAST_MS = 4500;   // R73 · B1 — non-action toasts
/* R76 · A4 — `action2`, a SECOND optional action on the same toast. The R12a·D12 "one action"
   rule stands for everything that existed before this round: nothing old passes it, and the one
   new caller (an appointment recorded as ATTENDED offering "Log what was discussed" beside its
   Undo) exists precisely because the two verbs belong to the same ten seconds. `#toast-action`
   stays the FIRST button in the DOM and stays the primary action (Undo, where there is one), so
   every suite that presses `#toast-action` keeps pressing what it always pressed; the second
   button is `#toast-action-2` and is ignored when no `action` came with it. */
function toast(msg, action, action2) {
  const t = $("#toast");
  clearTimeout(t._h);
  const live = action && action.label && typeof action.onClick === "function";
  const live2 = live && action2 && action2.label && typeof action2.onClick === "function";
  if (live) {
    t.innerHTML = '<span class="toast-msg"></span><button type="button" class="toast-action" id="toast-action"></button>'
      + (live2 ? '<button type="button" class="toast-action toast-action-2" id="toast-action-2"></button>' : "");
    t.querySelector(".toast-msg").textContent = msg;
    const wireA = (sel, act) => {
      const b = t.querySelector(sel);
      b.textContent = act.label;
      b.onclick = () => {
        clearTimeout(t._h);
        t.classList.add("hidden");
        t.classList.remove("has-action");
        act.onClick();
      };
    };
    wireA("#toast-action", action);
    if (live2) wireA("#toast-action-2", action2);
    t.classList.add("has-action");
  } else {
    t.classList.remove("has-action");
    t.textContent = msg;   // replaces any previous action markup outright
  }
  t.classList.remove("hidden");
  /* R73 · B1 — 3.2s was under the ~4s a screen reader needs to finish announcing a
     long confirmation, and under what a reader needs to find a bar that has just
     moved to the corner of the screen. Action toasts keep their own (longer)
     timing: the reader has to DECIDE, not just read. */
  t._h = setTimeout(() => { t.classList.add("hidden"); t.classList.remove("has-action"); }, live ? (action.ms || TOAST_ACTION_MS) : TOAST_MS);
}

/* R64-HF1 — CHUNKED .in() READS. PostgREST puts an .in() list in the URL; above roughly 500 UUIDs
   the request is a 400 Bad Request and the WHOLE read silently returns nothing. The 69-case mock
   never gets near that; production does (the Retention feed is 725+ cases, v_alerts is 1,000 rows,
   a select-all on the completed book is 1,871 ids) — which is how the property chips and R64's
   tel: links on the Retention rows rendered as "nothing" without a single console error. Every
   batch read that can be feed-sized goes through this: slices of IN_CHUNK ids run in parallel, the
   rows are concatenated, and the first error (if any) is returned in the usual {data, error} shape.
   `build(slice)` returns the query for one slice. Nothing here calls .catch on a builder. */
const IN_CHUNK = 150;
async function inChunks(ids, build) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return { data: [], error: null };
  const slices = [];
  for (let i = 0; i < list.length; i += IN_CHUNK) slices.push(list.slice(i, i + IN_CHUNK));
  const results = await Promise.all(slices.map((sl) => Promise.resolve(build(sl))));
  const bad = results.find((r) => r && r.error);
  return { data: results.flatMap((r) => (r && r.data) || []), error: bad ? bad.error : null };
}
/* R69-HF1 — PAGED FULL-TABLE READS. THE 1,000-ROW CEILING IS REAL AND `.limit()` CANNOT LIFT IT.

   R18/R23 raised REPORTS_ROW_CAP/OWNER_ROW_CAP to 20,000 and hung `.limit(OWNER_ROW_CAP)` on every
   owner-facing whole-table read, believing that lifted PostgREST's default `max-rows`. It does not.
   `max-rows` is a HARD SERVER ceiling: `.limit(n)` can only ever ask for FEWER rows than the server
   is willing to send, never more. Proven in Daniel's browser on 27 Aug, against the live database:

     db.from('clients').select('id',{count:'exact'}).order('last_name').limit(20000)
       → data.length 1000, count 1161          ← 161 clients simply absent, no error, no warning
     db.from('cases').select('id',{count:'exact'}).limit(20000)
       → data.length 1000, count 2015
     db.from('clients').select('id').order('last_name').range(1000, 1999)
       → 161 rows                              ← paging PAST the ceiling is the only way through

   So since the back-book import (1,161 clients / 2,015 cases) every one of those reads has silently
   returned the first 1,000 rows in its order: the case modal's client picker is ordered by surname,
   so "Whitcombe" onwards vanished — and a case whose client is not in the picker cannot be saved at
   all. The 69-case mock never reaches 1,000 rows, which is exactly why no suite ever noticed (the
   mock now enforces the same ceiling — see MOCK_MAX_ROWS in mock-supabase.js).

   readAll() takes an ALREADY-BUILT query (filters and ORDER applied, NO .limit()/.range() of its
   own) and walks it in PAGE-sized windows via `.range(from, from + PAGE - 1)` until a short page
   (the end of the table) or `cap` rows. It returns the SAME `{data, error}` shape every caller
   already handles, so a call site converts by wrapping the builder and deleting its `.limit(...)`.

   Notes that matter:
   · ORDER IS NOT OPTIONAL. Paging an unordered read can repeat or skip rows between requests, so
     every converted site keeps its ORDER clause, and where that order is not unique it gained a
     secondary `.order("id")` (e.g. `.order("last_name")` → `.order("last_name").order("id")`).
   · RE-AWAITING THE SAME BUILDER IS CORRECT in supabase-js v2 (verified against postgrest-js
     2.110.7, the version index.html pins). `.range(from, to)` does
     `url.searchParams.set('offset', from)` and `url.searchParams.set('limit', to - from + 1)` —
     `set`, not append, so calling `.range()` again overwrites the previous window (and would
     overwrite an earlier `.limit()` too). PostgrestBuilder is a thenable, not a promise: its
     `then()` builds and fires a FRESH fetch every time it is awaited and caches nothing. So one
     builder, re-ranged and re-awaited per page, is a correct pager and no builder FUNCTION is
     needed. (The mock's Builder behaves the same way: `_run()` per `then()`, `_range` overwritten.)
   · `Promise.resolve(...)` around every await, per the house rule — a PostgrestBuilder has no
     `.catch`, so it must never be treated as a real promise.
   · `count:'exact'` is preserved from the FIRST page (PostgREST reports the true total in
     content-range on every page regardless of the window, so the first one is enough).
   · An error on any page returns `{data: rowsSoFar, error}` — the rows already in hand, plus the
     error, so a tolerant caller (softRows) degrades exactly as it did before.
   · The cap still BITES at `cap` rows, so `ownerCapHit(rows)` / `noteRowCap(label, rows)`
     (`rows.length === CAP`) keep working unchanged — readAll stops AT the cap, never past it.
   · NEVER pass a `.single()`, `.maybeSingle()` or `head:true` builder to readAll: those are not
     row-window reads and `.range()` on them is meaningless. */
const READ_PAGE = 1000;   // PostgREST's default max-rows — asking for more per page just gets this
async function readAll(q, opts) {
  const o = opts || {};
  const cap = Number(o.cap) > 0 ? Number(o.cap) : OWNER_ROW_CAP;
  const pageSize = Number(o.page) > 0 ? Number(o.page) : READ_PAGE;
  const rows = [];
  let count = null, from = 0;
  for (;;) {
    const want = Math.min(pageSize, cap - rows.length);
    if (want <= 0) break;                                  // reached the cap — stop AT it, not past it
    let res;
    try {
      res = await Promise.resolve(q.range(from, from + want - 1));
    } catch (e) {
      return { data: rows, error: { message: String((e && e.message) || e), code: "READALL" }, count };
    }
    if (!res || res.error) return { data: rows, error: (res && res.error) || { message: "read failed" }, count };
    if (count == null && res.count != null) count = res.count;
    const got = Array.isArray(res.data) ? res.data : [];
    for (let i = 0; i < got.length; i++) rows.push(got[i]);
    if (got.length < want) break;                          // short page = end of the table
    from += got.length;
  }
  return { data: rows, error: null, count };
}
