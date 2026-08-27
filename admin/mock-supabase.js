/* ============================================================================
   mock-supabase.js — SANDBOX-ONLY mock of the supabase-js v2 surface that
   admin/app.js actually uses. Loaded by admin/mock.html IN PLACE OF the
   supabase CDN bundle. Never shipped, never imported by index.html.

   Scope is derived strictly from app.js (the sole source of truth):
     tables : clients, cases, case_tasks, case_notes, case_events, appointments,
              email_queue, sms_queue, case_emails, fact_finds, leads,
              introducers, profiles, settings, watch_alerts, audit_log,
              duplicate_dismissals (M4), case_documents (M10), staff_absences,
              case_files (R13), vault_entries (R14), error_events (R30),
              saved_views (R43), proc_rates / commission_statements /
              commission_lines (R44)
     view   : v_alerts
     rpcs   : my_role, get_briefing, get_reports, get_data_quality,
              get_protection_pipeline, run_watchtower, find_duplicate_clients,
              has_bank_details

   ROUND 5 (PLAN-R5.md § Harness fixes + § Migrations):
     · M1-M4 schema mirrored (profiles.phone/email_signoff + self-edit policy;
       cases lost_reason/lost_detail + per-fee-type paid dates; watch_alerts
       snooze columns; duplicate_dismissals table with RLS + audit trigger),
       M5 mirrored in get_reports (fees_banked_ytd on the coalesced cash date).
     · window.__mock.setMigrations({m2:false}) turns any migration OFF again so
       the app's feature-detect fallbacks are testable (unknown-column 42703 /
       missing-relation 42P01 / missing-function 42883).

   ROUND 6 (harness repair + multi-property fixtures):
     · rpc reassign_holdings(p_from, p_to) — the SECURITY DEFINER, Owner-only,
       single-transaction handover openDeactivate() calls RPC-first. Migration
       toggle m6; setMigrations({m6:false}) makes it 42883 so the compensating
       client-side path is still testable.
     · M7 = cases.property_address (text, nullable). Toggle m7.
     · Multi-property fixtures: four clients hold several cases across DISTINCT
       UK property addresses, one property carries two cases of the SAME client
       at different times, and one address is shared by TWO clients (sold
       between them). Most cases keep property_address NULL on purpose — that
       is the legacy reality the app has to cope with.
     · process-emails is v8: accepts {queue_ids:[…]} to send ONLY those rows,
       otherwise runs queue_automated_emails + queue_comms_extras and sends all
       due; per-adviser sign-off is read from profiles.
     · fact_finds carry the log_fact_find_submit() trigger (event + note + task).

   ROUND 8 (migration r8_m1 parity + the client-touch fixtures):
     · queue_comms_extras() gains the ANNUAL REVIEW TOUCH — a completed case
       whose completion anniversary is TODAY and which completed at least 12
       months ago gets ONE call task ("Annual review call — <client> (completed
       DD/MM/YYYY[, on <first address line>])"), due today, on the case's
       adviser. No email: the anniversary of a completion is a phone call, not a
       mailshot. Idempotent on an 11-month look-back over that case's own tasks,
       so a re-run (or the app's queue-before-you-ask on the Emails page) can
       never write the same call twice. Gated on the new setting
       `annual_review_enabled`, seeded OFF exactly as production ships it. The
       returned tally gains `annual_review_tasks`.
     · The review-request block is now a DRIP: at most 5 per run, oldest
       completed_at first, and only those 5 are stamped — the rest roll to the
       next run. PARITY NOTE: the round-8 brief describes this change as landing
       in queue_automated_emails(); in this mock (and in the production function
       this mock was built from) the review-request block lives in
       queue_comms_extras(), so that is where the cap is implemented. The
       behaviour an operator or a test can observe — 5 queued and stamped per
       run, oldest first, remainder waiting — is identical either way, because
       process-emails runs both functions back to back on every unscoped run.
     · Fixtures for the round-8 client-touch UI: DOBs on ~60% of the book (one
       birthday today, one tomorrow, the rest of the book deliberately blank so
       the "Missing DOB" segment has members), annual-review fodder at exactly
       12 / 24 months ago today plus an 11-month control, a review-request
       backlog of 8 (bigger than one run's cap of 5, so the rollover is
       observable in two runs), and members for every client segment including
       clients last contacted 8 and 14 months ago. See FIXTURES-R7.md § R8.
   ROUND 9 (migrations r9_m10 / r9_m11 parity + the document-chase fixtures):
     · M10 = the document checklist. New table `case_documents` (id, case_id,
       item, status requested|received|waived, requested_at, received_at, note,
       storage_path, created_at) plus three columns on `cases`: `waiting_on`,
       `solicitor_firm` and `doc_token`. One toggle covers the lot (m10), because
       they shipped as one migration: setMigrations({m10:false}) takes the table
       to 42P01 and the three columns to 42703 at once.
     · M11 = cases.referrer_client_id (nullable, self-referencing clients). Its
       own toggle m11, because it is its own migration — app.js feature-detects
       it separately (referrerSupported()) and hides the "Referred by" field
       outright when it is not there.
     · doc-upload edge function — the client-facing half of the checklist, and
       the only thing here a client without a login ever touches. Mirrors the
       DEPLOYED v1 contract, not a convenient version of it:
         GET  ?token=…  → {ok, company, first_name, greeting, items[{id,item,
                          status}], outstanding:<int>, complete}. Waived items
                          are filtered out server-side; a first name is the only
                          personal thing that comes back.
         POST multipart/form-data ONLY — parts `token` (in the BODY; query
              params are ignored on POST), `item_id` (the ID from the GET, never
              the name), `file` (a real file part with a filename; the EXTENSION
              is authoritative, not Content-Type) and an optional `website`
              honeypot. A JSON body is a 400 before any logic runs, which is the
              whole reason this stub refuses it too — a page that works against
              a lenient stub and 400s for every real client is exactly the
              failure this mirror exists to catch.
         Success is 200 {ok:true, item, outstanding:<int>}; a bare {ok:true} is
         the HONEYPOT answer and means nothing was written. Errors are matched
         on STATUS: 400 malformed · 404 dead link or unknown item · 409 already
         received (carries `status`) or a claim race · 413 over 10MB · 415 bad
         extension or magic bytes · 429 rate cap (per link, per minute) · 500
         storage. The 429 cap and the 500 are reachable from __mock hooks.
     · nps-capture v2 — a detractor (≤6) submission carrying a reason writes the
       verbatim feedback to the case as a note and puts a call task on the case's
       adviser, due tomorrow.
     · Comms: the docs_request template is CHECKLIST-AWARE (it lists only what is
       still missing, plus the upload link, whenever the case has a checklist,
       and keeps its old firm-wide wording where it has none); a nightly DOC
       CHASE queues at most three chases per case and then writes an adviser task
       instead; and a REVIEW REMINDER goes out a week after an unanswered review
       request, inside the same 5-a-run drip the requests themselves respect.
     · Fixtures: four document checklists (one per state — part-received, chase
       due, chases exhausted, all in), solicitor firms and waiting-on values
       across the book, referrer attribution, and a review-score spread. See
       FIXTURES-R7.md § R9.
     tables : … + case_documents (M10)
     edge   : process-emails, send-sms, outlook-sync, owner-digest, invite-user,
              ai-import, parse-offer, assistant, doc-upload, nps-capture
     auth   : getSession, getUser, onAuthStateChange, signInWithPassword,
              signOut, resetPasswordForEmail, updateUser
     storage: offers bucket (upload, createSignedUrl); client-docs bucket
              (createSignedUrl — R12a·D8, the admin "open" link on a checklist
              row a client uploaded through doc-upload; R13 — the bucket is
              named `client-docs` in production, NOT `case-documents` as R12a
              shipped it here; see "R13 · BUCKET CORRECTION" below)

   ROUND 12a (D8 — signed-URL open link on a received checklist document):
     · No new mock surface was needed: `storage.from(bucket)` was already
       bucket-name-agnostic (built once for `offers`, never validated the
       bucket string), so `storage.from("case-documents").createSignedUrl(...)`
       already behaves exactly like the `offers` case. What the fixtures
       lacked was any row with real content behind its `storage_path` to open,
       and any row proving the app must NOT offer the link at all — a document
       marked received over email/phone has no file, and `storage_path` is how
       the app tells the two apart (see case_documents fixtures, search
       "R12a·D8").

   ROUND 13 · BUCKET CORRECTION (a real production defect R12a's mock hid):
     · Production has NO "case-documents" bucket. The real buckets are
       web / offers / client-docs. The deployed doc-upload edge function (a)
       uses bucket "client-docs", (b) stores paths as
       `<caseId>/<slug>-<ts>.<ext>` INSIDE the bucket, and (c) writes
       `case_documents.storage_path` WITH the bucket prefix on it:
       `client-docs/<caseId>/<file>`. Every fixture storage_path below is
       re-prefixed the same way, `DOC_STORAGE_BUCKET` is now "client-docs",
       and the doc-upload stub writes the prefixed form on a real upload
       (search "R13 · BUCKET CORRECTION" below for both). `storage.from(bucket)`
       needed no change — it was already bucket-name-agnostic — but every
       piece of fixture content keyed into `storageFiles` moved with the
       bucket rename. `tests/r12a.js` D8 still asserts the OLD
       "case-documents/<path>" signed-URL shape and is not this file's to
       edit; that one check is now expected to fail — see HARNESS.md / the
       handoff notes for the exact line.
     · `clients` gains `is_vulnerable` (bool), `vulnerability_note` (text) and
       `suppress_automation` (bool), mirroring app.js's CARE_COLS. Suppression
       is enforced in every automated queueing path that actually exists in
       this mock (see "R13 · SUPPRESSION" below for the exact list and the
       honest gaps — some settings-gated sends production has were never
       built here and still are not).
     · `cases` gains four nullable, writable columns with no backfill:
       `policy_start_date`, `exchange_date`, `offer_issued_date`,
       `repayment_method`.
     · Two new tables: `staff_absences` (id, profile_id, starts_on, ends_on,
       note, created_by, created_at — staff read; write is own-row or
       admin/owner, mirroring the `profiles` self-edit policy) and
       `case_files` (id, case_id, client_id, name, kind, storage_path,
       uploaded_by, created_at — staff all).
     · `settings` gains `last_full_export_at` and `last_cron_run_at` (M-42/
       M-43). `process-emails` UPSERTs `last_cron_run_at` on every FULL
       (unscoped) run, never on a scoped one.
     · `run_watchtower` is replaced wholesale with production's ten rules —
       see "R13 · WATCHTOWER" below. The old seven-rule set this file used to
       run (rate_ended, erc_conflict, no_adviser, protection_gap, stalled,
       completed_no_date, no_contact) is GONE; two existing tests
       (tests/r5_batch4.js) hard-assert two of those old rule names on
       fixture rows and are not this file's to edit — see the handoff notes.

   ROUND 12b (retention call-pack, first-run tour, appointment outcomes,
   doc-chase widening — mirrors production migrations deployed just before
   this round):
     · `cases` gains four nullable numerics for the retention call-pack (W-15):
       `current_balance`, `reversion_rate`, `monthly_payment`, `erc_amount`.
       No backfill, so NULL everywhere except the handful of fixture rows
       seeded below (search "r12b" in the fixture pass after roundNineFixtures)
       — Kwame Boateng and Louise Garnham (the two cases the Recover — rates
       that already ended panel shows uncovered) and Sarah Ellingham's live
       fact_find case (the retention-relevant one). Andrew Pemberton's
       rate-ended case is left with all four null on purpose, and Louise's
       carries a balance only — the app must render absence, not zero, and
       partial data, not a crash.
     · `profiles` gains nullable `tour_seen_at timestamptz` plus RPC
       `mark_tour_seen()` — SECURITY DEFINER, sets tour_seen_at = now() on
       exactly the CALLER's own profile row and only if it is currently null;
       a second call is a no-op. Every staff fixture has a past timestamp
       except Luke (p3), who is null so the first-run tour has exactly one
       persona to fire for.
     · `appointments` gains nullable text `outcome` (null = not recorded; the
       app writes attended / no_show / rearranged). Null on every fixture row.
     · `queue_comms_extras()`'s document chase (r9) widens from
       fact_find/application to every live stage — enquiry through exchange —
       in both the chase-email branch and the overdue-task branch (they share
       one filter, `DOC_CHASE_STAGES`, exactly as production's two CTEs moved
       together in one migration). Ruby Sinclair's decision_in_principle case
       carries a checklist with outstanding items so the widening is
       observable — `doc_chase_enabled` still seeds OFF, so nothing chases it
       until a test turns the setting on.

   ROUND 14 (the company password safe — `vault_entries`):
     · New table `vault_entries` (id, category text default 'other' — lender|
       protection|gi|admin|contact|other, name, owner_label — Daniel|Luke|
       Wayne|Shared|null, fields jsonb array of {label,value,secret}, note,
       visible_to text[] — null/empty = every staff role, else only the roles
       listed, sort_order int default 0, updated_by, created_at, updated_at).
       RLS mirrors profiles/settings exactly: SELECT is any staff AND
       (visible_to empty OR the caller's role is in it — see readFilter());
       INSERT/UPDATE is any staff; DELETE is Owner/Administrator ONLY, same
       shape as the clients/cases delete rule from R4 (see writePolicy()).
       Every insert/update/delete writes an audit_log row exactly like every
       other AUDITED table, except `maskChanges()` reaches INTO the `fields`
       array and rewrites the `value` of every entry with `secret:true` to
       "(hidden)" — a non-secret field's value is left in the clear, mirroring
       production's audit_vault_row() trigger. Fixtures: 12 entries, all
       plainly-fake test data (no real password ever), covering every
       category, three individually-owned "Test Bank A" rows (Daniel/Luke/
       Wayne) plus a Shared one, one gated admin row (visible_to=['owner'])
       so the RLS gate is exercised, one entry with a note, one with a blank
       secret value (nothing filled in yet), and several mixing secret/
       non-secret fields on the same row.

   ROUND 14b (`cases.mortgage_account_number`):
     · Nullable text, no migration toggle (plain column, always present —
       app.js feature-detects it by `hasOwnProperty`, same as
       `protection_quoted_at`, not by the M-flag system). Defaulted null in
       `mkCase()` and `applyInsertDefaults()`, alongside the R13
       forward-capture columns. Two fixture values, both plainly fake:
       James Whitfield's case → "MTG-TEST-4471", Owen Cadwallader's
       completed case → "ACC-0099-TEST".

   ROUND 16 (BTL rental + ICR affordability, submit-to-lender tracker):
     · `cases` gains six more plain nullable columns, same no-migration-toggle
       rule as R14b: `monthly_rent`, `icr_stress_rate`, `icr_required_pct`
       (the BTL trio — app.js probes presence via `monthly_rent`) and
       `lender_reference`, `application_status`, `application_status_at` (the
       tracker trio — probed via `application_status`). Defaulted null in
       `mkCase()` and `applyInsertDefaults()`. Canonical ICR/yield formula
       lives ONLY in app.js's `btlIcr()` — this file computes nothing, it
       just stores the numbers. Four fixture rows carry real (fake) values
       (search "R16" in the fixture pass after roundFourteenBFixtures): two
       of Gareth Pollard's BTL cases (application-stage ICR fail, offer-stage
       ICR pass) and two lender-tracker rows (Melanie Underhill's BTL
       application case — status "underwriting" stamped 15 days ago, so the
       chase nudge fires; the Fairweathers' BTL offer case — status
       "offer_issued" stamped 25 days ago, so it does NOT, despite being
       older, since offer_issued is excluded from the chase). `tests/r16.js`
       mints its own fresh cases for every exact-number assertion, exactly
       like `tests/r15.js` does — these fixture rows exist for realism/manual
       verification, not because any suite's count depends on their figures.

   Personas (?as=…):  p1 Kim Martin (admin, DEFAULT) · p2 Wayne Kellow (adviser)
                      p3 Luke Richards (adviser) · p4 Daniel Potts (owner)
                      p5 Rachel Foyle (introducer — fails the staff login gate)
   ========================================================================== */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- helpers */
  var NOW = new Date();
  var DAY = 86400000;
  var pad2 = function (n) { return String(n).padStart(2, "0"); };
  var dateOnly = function (d) { var x = new Date(d); return x.getFullYear() + "-" + pad2(x.getMonth() + 1) + "-" + pad2(x.getDate()); };
  /* R12b flake fix — dateOnly() reads the BROWSER/Node process's own local timezone, which in this
     harness is whatever the host happens to be, not necessarily Europe/London. app.js's own
     "today"/"tomorrow" (localDateStr(), used for every due-date the app itself writes — the
     rate-end chase task, the fee-paid date input's max, etc.) is always Europe/London-pinned. The
     two only disagree for the hour 23:00–00:00 UTC (00:00–01:00 London during BST, already
     "tomorrow" there while a UTC/process-local read still says "today") — exactly the class of
     flake this harness has hit before (see shiftNoon() above). Anywhere the mock computes a due
     date FROM A LIVE REQUEST (not a fixture pinned at load with shiftNoon) that a test will compare
     against a Europe/London expectation, use this instead of dateOnly(). */
  var dateOnlyLondon = function (d) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(d)); };
  var iso = function (d) { return new Date(d).toISOString(); };
  /* DD/MM/YYYY — how a date is written INSIDE a title an adviser reads, which is
     the one place in this file a date is not an ISO string (r8_m1's annual-review
     call task quotes the completion date the same way production does). */
  var ukDate = function (d) {
    var p = String(d == null ? "" : d).slice(0, 10).split("-");
    return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : String(d == null ? "" : d);
  };
  var shift = function (days, base) { return new Date((base ? new Date(base).getTime() : NOW.getTime()) + days * DAY); };
  /* Same as shift(), but pinned to local noon on the resulting calendar day.
     A `date` column (submitted_at) rendered via dateOnly() always lands on
     midnight of the right day, but a `timestamptz` column (completed_at)
     rendered via iso(shift(...)) keeps whatever hh:mm:ss real "now" happened
     to have when the fixtures loaded — so the whole-day gap between the two,
     rounded, could be one day higher or lower purely depending on what time
     of day a test happened to run. Anywhere a completed_at is paired with a
     dateOnly() submitted_at and the gap between them is measured (conveyancer
     speed), build the timestamp with shiftNoon() instead so the gap is a
     fixed number of days regardless of real wall-clock time at load. */
  var shiftNoon = function (days, base) { var d = shift(days, base); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0); };
  var TODAY = dateOnly(NOW);

  var _seed = 20260726;
  function rnd() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }
  function rint(lo, hi) { return lo + Math.floor(rnd() * (hi - lo + 1)); }
  function pick(a) { return a[Math.min(a.length - 1, Math.floor(rnd() * a.length))]; }

  var _ctr = {};
  function nid(prefix) { _ctr[prefix] = (_ctr[prefix] || 0) + 1; return prefix + String(_ctr[prefix]).padStart(3, "0"); }

  function normPhone(p) {
    return p == null ? "" : String(p).replace(/[\s()\-.]/g, "").replace(/^\+44/, "0").replace(/^0044/, "0");
  }
  function clone(v) {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(clone);
    var o = {}; for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) o[k] = clone(v[k]);
    return o;
  }
  /* R14 — generic-diff comparator used by _runInsert (upsert branch) and
     _runUpdate. Plain `String(a) === String(b)` (what both call sites used
     exclusively pre-R14) is correct for scalars and even for a text[] like
     `visible_to` (Array.prototype.join stringifies each element as itself),
     but it is WRONG for an array of OBJECTS: `vault_entries.fields` is a
     jsonb array of {label,value,secret}, and every element's default
     toString() is the literal string "[object Object]" — so two DIFFERENT
     fields arrays of the same length stringify identically and a real edit
     (e.g. changing a password's value) would silently compare "equal",
     never get written to the row, and never reach the audit trail. Anything
     that is an array or object on either side is compared by JSON.stringify
     instead; everything else keeps the original String() behaviour so no
     existing comparison changes shape. */
  function sameValue(a, b) {
    var aIsObj = a !== null && typeof a === "object";
    var bIsObj = b !== null && typeof b === "object";
    if (aIsObj || bIsObj) {
      try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { /* fall through */ }
    }
    return String(a) === String(b);
  }

  /* ------------------------------------------------------------ persona/auth */
  var PERSONAS = {
    p1: { id: "p1", email: "kim.martin@nexmoney.co.uk", full_name: "Kim Martin", role: "admin" },
    p2: { id: "p2", email: "wayne.kellow@nexmoney.co.uk", full_name: "Wayne Kellow", role: "adviser" },
    p3: { id: "p3", email: "luke.richards@nexmoney.co.uk", full_name: "Luke Richards", role: "adviser" },
    p4: { id: "p4", email: "daniel@nexmoney.co.uk", full_name: "Daniel Potts", role: "owner" },
    p5: { id: "p5", email: "rachel@foyleandco.co.uk", full_name: "Rachel Foyle", role: "introducer" }
  };
  function personaKey() {
    var m = /[?&]as=([a-zA-Z0-9_-]+)/.exec(window.location.search || "");
    var k = m ? m[1] : "p1";
    return PERSONAS[k] ? k : "p1";
  }
  var ME_KEY = personaKey();
  var CURRENT_UID = ME_KEY;
  function me() { return DB.profiles.filter(function (p) { return p.id === CURRENT_UID; })[0] || PERSONAS[CURRENT_UID]; }
  function myRole() { var p = me(); return (p && p.role) || "none"; }
  function isOwner() { return myRole() === "owner"; }
  function isAdminOrOwner() { return myRole() === "owner" || myRole() === "admin"; }
  function actorLabel() { var p = me(); return (p && (p.full_name || p.email)) || "Unknown user"; }

  /* --------------------------------------------------------------- the store */
  var DB = {
    clients: [], cases: [], case_tasks: [], case_notes: [], case_events: [],
    appointments: [], email_queue: [], sms_queue: [], case_emails: [],
    fact_finds: [], leads: [], introducers: [], profiles: [], settings: [],
    watch_alerts: [], audit_log: [], duplicate_dismissals: [],
    /* R9-M10 — the document checklist. One row per item we have asked a client
       for, on the case it belongs to. */
    case_documents: [],
    /* R13 — staff out-of-office spans (for lead-routing exclusion) and staff-
       uploaded case files (the checklist above is client-uploaded; this is
       the mirror for what the FIRM attaches — signed illustrations, offer
       letters kept as a record, etc.). */
    staff_absences: [], case_files: [],
    /* R14 — the company password safe. */
    vault_entries: [],
    /* R30 — persisted, SANITISED client-error fingerprints (owner/admin diagnostics).
       Columns: id, created_at, error_type, location, page, role — NO message/stack/PII
       column, by construction, exactly like production. */
    error_events: [],
    /* R56 — outbound referrals (survey / conveyancing) recorded per case. */
    referrals: [],
    /* R43 — the saved filter views R31 kept in localStorage, now a table.
       Columns: user_id (defaults to the caller, PK part 1), scope ('pipeline' |
       'clients' | '_meta'), name, filters jsonb, updated_at. PK is the TRIPLE
       (user_id, scope, name) — the only composite key in this store, which is
       why the upsert branch below grew a conflict-target registry. RLS is
       per-user on all four ops (see readFilter/_matching + writePolicy), so a
       persona only ever sees and writes their own rows. SEEDED EMPTY on
       purpose: the app's first-run behaviour (starter seed on a virgin store,
       one-time migration from an existing localStorage key) is the thing worth
       exercising, and a fixture row would hide both. */
    saved_views: [],
    /* R44 — Stonebridge payment reconciliation (migration r44_reconciliation).
       Three tables, all is_owner() on every operation, which is why they are
       registered here and then never seeded: a non-owner persona must read
       EMPTY (not "hidden but present"), and the owner's first-run state — no
       rate card, no statement, both panels saying so in words — is the state
       most worth exercising. A fixture row would hide both.
         · proc_rates — the network's rate card, REPLACED WHOLESALE on each
           upload (delete-all then chunked insert), rate is a 0-1 fraction.
         · commission_statements — one row per weekly workbook. `ref` carries a
           UNIQUE index WHERE ref <> '', which is the double-import guard; the
           emulation of it lives in writePolicy() below.
         · commission_lines — one row per statement line, statement_id cascades,
           matched_case_id is ON DELETE SET NULL, match_status is CHECKed. */
    proc_rates: [], commission_statements: [], commission_lines: []
  };
  /* R44 — production makes all three `id bigint generated always as identity`.
     Serial-style counters (the same shape R30 gave error_events) rather than
     nid()'s zero-padded strings, so `.order("id")` sorts the way the real
     table does at any row count and the app can never come to depend on an
     id being a string. */
  var procRateSeq = 0, commissionStatementSeq = 0, commissionLineSeq = 0;
  var R44_TABLES = ["proc_rates", "commission_statements", "commission_lines"];
  var R44_MATCH_STATUSES = ["unmatched", "suggested", "confirmed", "dismissed", "na"];
  /* R30 — feature-gate toggle (default true). __setErrorEventsSupported(false) makes any
     op on error_events answer with a PostgREST-shaped 42P01, so tests can exercise the
     app's degrade path (errorEventsOff + the "isn't enabled" note). */
  var errorEventsSupported = true;
  var errorEventSeq = 0;   // serial-style incrementing id, assigned on insert
  /* R43 — same feature-gate shape as errorEventsSupported above:
     __setSavedViewsSupported(false) makes every op on saved_views answer with a PostgREST 42P01,
     which is what an un-migrated deployment does and what the app's localStorage fallback exists
     for. Default true. */
  var savedViewsSupported = true;
  /* R43 — a PK may now be a LIST of columns: saved_views' key is the triple
     (user_id, scope, name). pkOf() keeps returning what is registered (the string call sites —
     audit row_id, the embed resolver, the id default — are all single-key tables and never see
     an array), and pkCols() is the always-an-array form the upsert conflict target uses. */
  var PK = { settings: "key", saved_views: ["user_id", "scope", "name"] };
  function pkOf(t) { return PK[t] || "id"; }
  function pkCols(t) { var p = pkOf(t); return Array.isArray(p) ? p : [p]; }

  /* R12a·D8 — storage object registry, moved up here (ahead of the STORAGE
     section below which merely defines the `storage.from()` surface) so the
     fixture block can seed real entries for the case-documents checklist
     files a client uploaded, the same way a genuine upload would populate it.
     Keyed "<bucket>/<path>", same as the `storage` object writes below. */
  var storageFiles = {};
  /* R13 · BUCKET CORRECTION — module-scope so both the fixture pass (which
     seeds content into `storageFiles`) and the doc-upload handler (which
     writes a real upload into it) agree on the same bucket name. Production's
     real bucket, not R12a's invented "case-documents". */
  var DOC_STORAGE_BUCKET = "client-docs";

  /* ------------------------------------------------- migrations M1-M7 (parity)
     Every migration the app feature-detects is mirrored here and is ON by default,
     so the app's feature-detection takes the "migrated" branch under test. Flip one
     OFF with window.__mock.setMigrations({m2:false}) to exercise the fallback:
     writes to the new columns come back as Postgres 42703 (undefined_column),
     selects stop returning them, an un-migrated TABLE comes back as 42P01 and an
     un-migrated FUNCTION comes back as 42883 (undefined_function). */
  var MIGRATIONS = { m1: true, m2: true, m3: true, m4: true, m5: true, m6: true, m7: true, m10: true, m11: true };
  /* R68 · M15 — is RESEND_API_KEY set on the "server"? A secret, not a table, so it cannot be
     a settings row: it lives here as a harness flag, DEFAULT FALSE because that is production's
     actual state (no key is set, and nothing has ever been able to send). Flip it with
     __mock.setResendKey(true) to exercise the configured states. Read only by the
     process-emails safe probe. */
  var MOCK_RESEND_KEY = false;
  var MIGRATION_COLUMNS = {
    m1: { profiles: ["phone", "email_signoff"] },
    m2: { cases: ["lost_reason", "lost_detail", "broker_fee_paid_at", "proc_fee_paid_at", "sols_fee_paid_at"] },
    m3: { watch_alerts: ["snoozed_until", "snooze_note", "snoozed_by"] },
    /* R6-M7 — today's production migration: `alter table cases add column
       property_address text` (nullable, no backfill). OFF ⇒ a write naming the
       column returns 42703 and a SELECT simply does not return it, which is what
       an app running against a database that has not taken the migration sees. */
    m7: { cases: ["property_address"] },
    /* R9-M10 — `alter table cases add column waiting_on text, add column
       solicitor_firm text, add column doc_token text` shipped in the SAME
       migration as the case_documents table, so one toggle governs both: a
       database that has not taken r9_m10 has neither the table nor the columns,
       and flipping them independently would model a state that cannot exist. */
    m10: { cases: ["waiting_on", "solicitor_firm", "doc_token"] },
    /* R9-M11 — `alter table cases add column referrer_client_id uuid references
       clients(id)`. Its own migration and its own toggle: app.js probes for it
       separately (referrerSupported()) and renders no "Referred by" field at all
       when it is missing. */
    m11: { cases: ["referrer_client_id"] }
  };
  var MIGRATION_TABLES = { m4: ["duplicate_dismissals"], m10: ["case_documents"] };
  /* R5-M6 — reassign_holdings(p_from, p_to) shipped as a migration too, so an older
     database simply does not have the function. OFF ⇒ 42883, which is exactly what
     app.js's isMissingFunctionError() feature-detects on before falling back to the
     compensating client-side path in openDeactivate(). */
  var MIGRATION_FUNCTIONS = { m6: ["reassign_holdings"] };
  function functionIsMissing(name) {
    var missing = false;
    Object.keys(MIGRATION_FUNCTIONS).forEach(function (mk) {
      if (MIGRATIONS[mk]) return;
      if (MIGRATION_FUNCTIONS[mk].indexOf(name) >= 0) missing = true;
    });
    return missing;
  }
  function disabledColumns(table) {
    var out = [];
    Object.keys(MIGRATION_COLUMNS).forEach(function (mk) {
      if (MIGRATIONS[mk]) return;
      (MIGRATION_COLUMNS[mk][table] || []).forEach(function (c) { out.push(c); });
    });
    return out;
  }
  function tableIsMissing(table) {
    var missing = false;
    Object.keys(MIGRATION_TABLES).forEach(function (mk) {
      if (MIGRATIONS[mk]) return;
      if (MIGRATION_TABLES[mk].indexOf(table) >= 0) missing = true;
    });
    return missing;
  }
  /* first payload key that the current migration state says does not exist */
  function undefinedColumn(table, payload) {
    if (!payload) return null;
    var bad = disabledColumns(table);
    if (!bad.length) return null;
    var rows = Array.isArray(payload) ? payload : [payload];
    for (var i = 0; i < rows.length; i++) {
      var keys = Object.keys(rows[i] || {});
      for (var j = 0; j < keys.length; j++) if (bad.indexOf(keys[j]) >= 0) return keys[j];
    }
    return null;
  }

  /* Relationship resolution for PostgREST-style embeds. `<embed>` on table T is
     to-one when T carries the FK column, else to-many from the target back.

     R9 — a table pair can be joined by MORE THAN ONE foreign key. Migration m11
     added `cases.referrer_client_id -> clients(id)` (constraint
     cases_referrer_client_id_fkey) alongside the original `cases.client_id`
     (cases_client_id_fkey), so `cases` and `clients` now have two relationships
     in BOTH directions. Real PostgREST refuses to guess: an unhinted embed
     between them comes back as HTTP 300 / PGRST201 "Could not embed because more
     than one relationship was found". This map therefore lists EVERY FK column
     that reaches a target, not one, and the resolver below is strict about it —
     a permissive resolver is exactly what let the live Pipeline break while the
     harness stayed green. A request disambiguates with the column-name hint
     (`clients!client_id(...)`) or the constraint-name hint
     (`clients!cases_client_id_fkey(...)`).

     Note the migration gate: with m11 OFF, cases.referrer_client_id does not
     exist, only one relationship matches, and an unhinted embed is legal again —
     which is precisely what a database that has not taken m11 does. */
  var FK_COLUMNS = {
    clients: ["client_id", "referrer_client_id"],
    cases: ["case_id"],
    introducers: ["introducer_id"],
    profiles: ["id"]
  };
  /* kept for callers that only ever needed the primary hop */
  var FK_FOR = { clients: "client_id", cases: "case_id", introducers: "introducer_id", profiles: "id" };
  /* Postgres' default constraint name for `<source>.<column> references <target>` */
  function fkConstraint(source, column) { return source + "_" + column + "_fkey"; }
  function hasCol(table, col) {
    if (!DB[table]) return false;
    var sample = DB[table][0];
    if (!sample || !Object.prototype.hasOwnProperty.call(sample, col)) return false;
    return disabledColumns(table).indexOf(col) < 0;
  }
  /* every relationship between `table` and `embed`, in resolution order.
     -> [{ kind, target, fk, column, constraint, source }] */
  function relationCandidates(table, embed) {
    var out = [];
    if (!DB[embed]) return out;
    if (embed !== table) {
      (FK_COLUMNS[embed] || []).forEach(function (col) {
        if (hasCol(table, col)) {
          out.push({ kind: "one", target: embed, fk: col, column: col, source: table, constraint: fkConstraint(table, col) });
        }
      });
    }
    if (out.length) return out;
    (FK_COLUMNS[table] || []).forEach(function (col) {
      if (hasCol(embed, col)) {
        out.push({ kind: "many", target: embed, fk: col, column: col, source: embed, constraint: fkConstraint(embed, col) });
      }
    });
    return out;
  }
  function matchesHint(cand, hint) {
    return hint === cand.column || hint === cand.constraint;
  }
  /* -> { rel } | { ambiguous:[cands] } | { none:true } */
  function resolveRelation(table, embed, hint) {
    var cands = relationCandidates(table, embed);
    if (hint) {
      var picked = cands.filter(function (c) { return matchesHint(c, hint); });
      if (picked.length === 1) return { rel: picked[0] };
      if (picked.length > 1) return { ambiguous: picked };
      return { none: true };
    }
    if (cands.length === 1) return { rel: cands[0] };
    if (cands.length > 1) return { ambiguous: cands };
    return { none: true };
  }
  /* the exact shape PostgREST returns for an ambiguous embed */
  function ambiguousEmbedError(table, embed, cands) {
    var names = cands.map(function (c) { return "'" + embed + "!" + c.constraint + "'"; }).join(", ");
    return {
      code: "PGRST201",
      message: "Could not embed because more than one relationship was found for '" + table + "' and '" + embed + "'",
      details: cands.map(function (c) {
        return {
          cardinality: c.kind === "one" ? "many-to-one" : "one-to-many",
          embedding: table + " with " + embed,
          relationship: c.constraint + " using " + c.source + "(" + c.column + ") and " +
            (c.kind === "one" ? c.target : table) + "(" + pkOf(c.kind === "one" ? c.target : table) + ")"
        };
      }),
      hint: "Try changing '" + embed + "' to one of the following: " + names +
        ". Find the desired relationship in the 'details' key."
    };
  }
  /* Walk a select list before any row is projected and refuse the whole request
     if any embed — at any nesting depth, in either direction — is ambiguous.
     Returns null when the select is resolvable. */
  function embedError(table, sel) {
    var p = parseSelect(sel);
    for (var i = 0; i < p.embeds.length; i++) {
      var e = p.embeds[i];
      var r = resolveRelation(table, e.name, e.hint);
      if (r.ambiguous) return ambiguousEmbedError(table, e.name, r.ambiguous);
      if (r.rel) {
        var nested = embedError(r.rel.target, e.spec);
        if (nested) return nested;
      }
    }
    return null;
  }

  /* ------------------------------------------------------ select-list parser */
  function splitTop(s, sep) {
    var out = [], depth = 0, cur = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === sep && depth === 0) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(function (x) { return x.trim(); }).filter(function (x) { return x.length; });
  }
  /* -> { star:bool, cols:[..], embeds:[{name, hint, inner, spec}] }
     An embed token is `<table>[!<hint>][!inner](<spec>)`. The hint is either the
     FK column name (`clients!client_id`) or the constraint name
     (`clients!cases_client_id_fkey`); `!inner` is a join modifier, not a hint.
     The result key is always the bare table name — a hint disambiguates the
     relationship, it does not rename the field. */
  function parseSelect(sel) {
    var res = { star: false, cols: [], embeds: [] };
    if (sel == null || sel === "") { res.star = true; return res; }
    splitTop(String(sel), ",").forEach(function (tok) {
      var m = /^([A-Za-z0-9_]+)((?:\s*!\s*[A-Za-z0-9_]+)*)\s*\((.*)\)$/.exec(tok);
      if (m) {
        var mods = (m[2] || "").split("!").map(function (x) { return x.trim(); }).filter(function (x) { return x.length; });
        var inner = false, hint = null;
        mods.forEach(function (x) {
          if (x === "inner") inner = true;
          else if (x === "left") { /* default join, no-op */ }
          else if (hint == null) hint = x;
        });
        res.embeds.push({ name: m[1], hint: hint, inner: inner, spec: m[3] });
        return;
      }
      if (tok === "*") { res.star = true; return; }
      res.cols.push(tok);
    });
    return res;
  }
  /* set by project() when an `!inner` embed came back empty for this row */
  function project(table, row, sel) {
    var p = parseSelect(sel);
    var out = {};
    if (p.star || (!p.cols.length && !p.embeds.length)) { out = clone(row); }
    else { p.cols.forEach(function (c) { out[c] = clone(row[c]); }); }
    p.embeds.forEach(function (e) {
      var r = resolveRelation(table, e.name, e.hint);
      var rel = r.rel;
      if (!rel) { out[e.name] = null; if (e.inner) out.__innerDrop = true; return; }
      if (rel.kind === "one") {
        var parent = DB[rel.target].filter(function (r2) { return r2[pkOf(rel.target)] === row[rel.fk]; })[0];
        out[e.name] = parent ? project(rel.target, parent, e.spec) : null;
        if (e.inner && !parent) out.__innerDrop = true;
      } else {
        var kids = DB[rel.target].filter(function (r2) { return r2[rel.fk] === row[pkOf(table)]; });
        out[e.name] = kids.map(function (k) { return project(rel.target, k, e.spec); });
        if (e.inner && !kids.length) out.__innerDrop = true;
      }
    });
    /* an un-migrated column simply isn't in the result set */
    disabledColumns(table).forEach(function (c) { delete out[c]; });
    return out;
  }
  /* project a whole result set, applying `!inner` (a row whose inner-joined
     embed is empty does not come back at all) */
  function projectRows(table, rows, sel) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = project(table, rows[i], sel);
      if (r && r.__innerDrop) continue;
      if (r) delete r.__innerDrop;
      out.push(r);
    }
    return out;
  }

  /* ----------------------------------------------------------- filter engine */
  function likeToRe(pattern, ci) {
    var esc = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    esc = esc.replace(/%/g, "[\\s\\S]*").replace(/_/g, "[\\s\\S]");
    return new RegExp("^" + esc + "$", ci ? "i" : "");
  }
  function cmp(a, b) {
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
    if (a instanceof Date) a = a.toISOString();
    if (b instanceof Date) b = b.toISOString();
    var A = String(a), B = String(b);
    var nA = Number(A), nB = Number(B);
    if (A !== "" && B !== "" && !isNaN(nA) && !isNaN(nB)) return nA < nB ? -1 : nA > nB ? 1 : 0;
    return A < B ? -1 : A > B ? 1 : 0;
  }
  function testOp(val, op, arg) {
    switch (op) {
      case "eq": if (val == null) return false; return String(val) === String(arg);
      case "neq": if (val == null) return true; return String(val) !== String(arg);
      case "gt": return val != null && cmp(val, arg) > 0;
      case "gte": return val != null && cmp(val, arg) >= 0;
      case "lt": return val != null && cmp(val, arg) < 0;
      case "lte": return val != null && cmp(val, arg) <= 0;
      case "like": return val != null && likeToRe(arg, false).test(String(val));
      case "ilike": return val != null && likeToRe(arg, true).test(String(val));
      case "is":
        if (arg === null || arg === "null") return val == null;
        if (arg === true || arg === "true") return val === true;
        if (arg === false || arg === "false") return val === false;
        return val === arg;
      case "in": {
        var list = Array.isArray(arg) ? arg : String(arg).replace(/^\(|\)$/g, "").split(",");
        return list.some(function (x) { return val != null && String(val) === String(x).replace(/^"|"$/g, "").trim(); });
      }
      default: return true;
    }
  }
  /* PostgREST `.or()` string -> predicate. Supports paren-nested and()/or()/not.
     e.g.  stage.in.(application,offer),and(stage.eq.completed,completed_at.gte.X)
           phone.ilike.%0%7%7%0%0%9%0%0%1%2%3%                                     */
  function parseLogicList(str, joiner) {
    var parts = splitTop(str, ",").map(parseLogicNode);
    return function (row) {
      return joiner === "and"
        ? parts.every(function (f) { return f(row); })
        : parts.some(function (f) { return f(row); });
    };
  }
  function parseLogicNode(tok) {
    tok = tok.trim();
    var neg = false;
    if (/^not\./i.test(tok)) { neg = true; tok = tok.slice(4).trim(); }
    var grp = /^(and|or)\s*\((.*)\)$/i.exec(tok);
    if (grp) {
      var inner = parseLogicList(grp[2], grp[1].toLowerCase());
      return neg ? function (r) { return !inner(r); } : inner;
    }
    var i1 = tok.indexOf(".");
    if (i1 < 0) return function () { return true; };
    var col = tok.slice(0, i1);
    var rest = tok.slice(i1 + 1);
    if (/^not\./i.test(rest)) { neg = !neg; rest = rest.slice(4); }
    var i2 = rest.indexOf(".");
    if (i2 < 0) return function () { return true; };
    var op = rest.slice(0, i2);
    var raw = rest.slice(i2 + 1);
    var arg = raw;
    if (op === "is") arg = raw === "null" ? null : raw === "true" ? true : raw === "false" ? false : raw;
    var fn = function (row) { return testOp(row[col], op, arg); };
    return neg ? function (r) { return !fn(r); } : fn;
  }

  /* ------------------------------------------------------ policy (RLS parity) */
  var SENSITIVE_SETTING_KEYS = ["bank_account_name", "bank_sort_code", "bank_account_number", "cron_key", "resend_api_key"];
  var AUDIT_OWNER_ONLY_TABLES = ["settings", "profiles"];
  function pgError(message, code) {
    return { message: message, code: code || "42501", details: null, hint: null };
  }
  /* A Postgres error raised from INSIDE a function body. rpcCall() unwraps it so an
     RPC can refuse with a real SQLSTATE (permission denied, FK violation, raise
     exception) instead of the generic "MOCK" catch-all. */
  function pgErrorThrow(message, code) {
    var e = new Error(message);
    e.__pg = pgError(message, code);
    return e;
  }
  var LOST_REASONS = ["went_direct", "product_transfer_online", "another_broker", "staying_put", "affordability",
    "rate_price", "valuation", "client_changed_mind", "our_service", "other"];
  /* R9-M10 — case_documents_status_chk. "waived" is a first-class outcome, not a
     deletion: a document we decided we did not need after all is a fact about
     the case, and dropping the row would leave the checklist looking as though
     it was never asked for. */
  var DOC_STATUSES = ["requested", "received", "waived"];
  /* R66 · M8 — the `email_type` ENUM, mirrored. Production's column is a real Postgres enum, so an
     unknown value is a 22P02 at insert time, not a row that quietly sits in the queue until
     process-emails has to decide what to do with it. This list is EMAIL_LABEL's sixteen types plus
     the legacy `docs_chase` (rows of that type still exist on the deployed queue — see
     docChaseCount — even though nothing writes new ones) and R66's new `custom`. Adding a type to
     app.js without adding it here is exactly the drift this mirror exists to catch. */
  var EMAIL_TYPES_ENUM = ["welcome", "docs_request", "docs_chase", "submitted_update", "offer_update",
    "completion_congrats", "rate_end_reminder", "rate_end_chase", "review_request", "review_reminder",
    "fee_request", "referral_request", "protection_offer", "gi_exchange", "birthday_greeting",
    "completion_anniversary", "lead_ack", "factfind", "custom"];
  /* R66 · M6a — referrals_kind_chk, widened in production this round from
     ('survey','conveyancing','other') to include the two the firm actually makes money on:
     `protection` (the network's protection team) and `gi` (buildings & contents). Mirrored here
     because the app now writes both, and a mock that accepts anything cannot tell a typo from a
     migration that has not run. */
  var REFERRAL_KINDS = ["survey", "conveyancing", "protection", "gi", "other"];
  function isStaff() { return ["owner", "admin", "adviser", "staff"].indexOf(myRole()) >= 0; }
  function writePolicy(table, op, payload, targets) {
    if (table === "audit_log") {
      return pgError('permission denied for table audit_log — the audit trail is append-only', "42501");
    }
    /* M2 — cases_lost_reason_chk */
    if (table === "cases" && payload && payload.lost_reason != null && LOST_REASONS.indexOf(payload.lost_reason) === -1) {
      return pgError('new row for relation "cases" violates check constraint "cases_lost_reason_chk"', "23514");
    }
    /* R66 · M8 — email_queue.email_type is an enum in production; an unknown value fails the INSERT
       with 22P02 rather than landing in the queue. `custom` is in the list from this round. */
    if (table === "email_queue" && op !== "delete" && payload && payload.email_type != null
        && EMAIL_TYPES_ENUM.indexOf(payload.email_type) === -1) {
      return pgError('invalid input value for enum email_type: "' + payload.email_type + '"', "22P02");
    }
    /* R66 · M6a — referrals_kind_chk, the widened five. */
    if (table === "referrals" && op !== "delete" && payload && payload.kind != null
        && REFERRAL_KINDS.indexOf(payload.kind) === -1) {
      return pgError('new row for relation "referrals" violates check constraint "referrals_kind_chk"', "23514");
    }
    /* M4 — duplicate_dismissals: select/insert staff, delete admin+owner, NO update policy */
    if (table === "duplicate_dismissals") {
      if (op === "delete") {
        if (!isAdminOrOwner()) return pgError('permission denied for table duplicate_dismissals', "42501");
        return null;
      }
      if (op === "update") {
        return pgError('new row violates row-level security policy for table "duplicate_dismissals"', "42501");
      }
      if (!isStaff()) {
        return pgError('new row violates row-level security policy for table "duplicate_dismissals"', "42501");
      }
      var pay = payload || {};
      if (!pay.a_id || !pay.b_id || String(pay.a_id) >= String(pay.b_id)) {
        return pgError('new row for relation "duplicate_dismissals" violates check constraint "dup_pair_sorted"', "23514");
      }
      var kind = pay.kind || "client";
      var clash = DB.duplicate_dismissals.filter(function (r) {
        return r.kind === kind && r.a_id === pay.a_id && r.b_id === pay.b_id && r !== (targets || [])[0];
      });
      if (clash.length) {
        return pgError('duplicate key value violates unique constraint "dup_pair_unique"', "23505");
      }
      return null;
    }
    /* R9-M10 — case_documents. Staff write it from the case; nobody else can,
       and the check constraint on `status` is real, because the one value that
       must never be invented is "received". The public upload link does NOT
       come through here: the edge function runs as the service role, which is
       what makes a link a client can use without a login possible at all. */
    if (table === "case_documents") {
      if (!isStaff()) {
        return pgError('new row violates row-level security policy for table "case_documents"', "42501");
      }
      var dpay = payload || {};
      if (dpay.status != null && DOC_STATUSES.indexOf(dpay.status) === -1) {
        return pgError('new row for relation "case_documents" violates check constraint "case_documents_status_chk"', "23514");
      }
      if (op === "insert" && !dpay.item) {
        return pgError('null value in column "item" of relation "case_documents" violates not-null constraint', "23502");
      }
      return null;
    }
    /* R13 — case_files: staff all. Nobody outside the firm (an introducer never
       reaches /admin at all — see the staff login gate) touches this table. */
    if (table === "case_files") {
      if (!isStaff()) {
        return pgError('new row violates row-level security policy for table "case_files"', "42501");
      }
      return null;
    }
    /* R13 — staff_absences: staff read (see readFilter), but a write is only
       ever your OWN row, or an Owner/Administrator's on anybody's — the same
       shape as the M1 "profiles self edit" policy just above, because
       recording somebody else's absence for them is exactly the kind of edit
       that has to be traceable to whoever actually made it, unless they run
       the firm. */
    if (table === "staff_absences") {
      if (!isStaff()) {
        return pgError('new row violates row-level security policy for table "staff_absences"', "42501");
      }
      if (isAdminOrOwner()) return null;
      if (op === "insert") {
        var apay = payload || {};
        if (apay.profile_id !== CURRENT_UID) {
          return pgError('new row violates row-level security policy for table "staff_absences"', "42501");
        }
        return null;
      }
      /* update / delete — every target must already be the caller's own row */
      var ownAll = (targets || []).length > 0 && (targets || []).every(function (t) { return t.profile_id === CURRENT_UID; });
      if (!ownAll) {
        return pgError('new row violates row-level security policy for table "staff_absences"', "42501");
      }
      return null;
    }
    /* R14 — vault_entries: SELECT is gated in readFilter() by visible_to; write
       (insert/update) is any staff, mirroring the "case_files: staff all" shape
       just above; DELETE is Owner/Administrator ONLY — the same rule the M4
       clients/cases delete check below applies, called out here explicitly
       because vault_entries is not one of the two table names that generic
       check tests for. */
    if (table === "vault_entries") {
      if (op === "delete") {
        if (!isAdminOrOwner()) {
          return pgError('permission denied: deleting a vault entry is Owner / Administrator only', "42501");
        }
        return null;
      }
      if (!isStaff()) {
        return pgError('new row violates row-level security policy for table "vault_entries"', "42501");
      }
      return null;
    }
    /* R43 — saved_views: per-user on all four ops, with is_staff() on the insert/update WITH CHECK.
       The row's user_id has already been defaulted to the caller by the time an insert gets here
       (applyInsertDefaults), so the only way to fail the identity half is to NAME somebody else —
       which production's WITH CHECK refuses, and so does this. The two CHECK constraints are
       mirrored as well: an unknown scope or an empty/over-long name is a 23514, not a silent row,
       because the app's migration path deliberately drops names it knows the table would reject
       and that decision is only worth anything if the table would in fact reject them.
       Read/update/delete scoping is enforced one layer down, in _matching() — see the comment
       there for why it is not in readFilter() with the rest of the SELECT-side redaction. */
    if (table === "saved_views") {
      if (!isStaff()) {
        return pgError('new row violates row-level security policy for table "saved_views"', "42501");
      }
      if (op !== "delete") {
        var vpay = payload || {};
        if (vpay.user_id != null && vpay.user_id !== CURRENT_UID) {
          return pgError('new row violates row-level security policy for table "saved_views"', "42501");
        }
        if (vpay.scope != null && ["pipeline", "clients", "_meta"].indexOf(vpay.scope) === -1) {
          return pgError('new row for relation "saved_views" violates check constraint "saved_views_scope_chk"', "23514");
        }
        if (Object.prototype.hasOwnProperty.call(vpay, "name")) {
          var vnm = vpay.name == null ? "" : String(vpay.name);
          if (vnm.length < 1 || vnm.length > 120) {
            return pgError('new row for relation "saved_views" violates check constraint "saved_views_name_chk"', "23514");
          }
        }
      }
      return null;
    }
    /* R44 — proc_rates / commission_statements / commission_lines: is_owner()
       for EVERY operation, mirroring the migration exactly. There is no adviser
       or administrator half to this feature; a non-owner's writes are blocked
       here and their reads come back empty from readFilter(), which is what
       makes "the UI simply does not render for them" a safe design rather than
       a decoration over readable data. */
    if (R44_TABLES.indexOf(table) >= 0) {
      if (!isOwner()) {
        return pgError('new row violates row-level security policy for table "' + table + '"', "42501");
      }
      var r44pay = payload || {};
      if (table === "proc_rates" && op !== "delete" && r44pay.rate != null) {
        var rateN = Number(r44pay.rate);
        if (!isFinite(rateN) || rateN < 0 || rateN > 1) {
          return pgError('new row for relation "proc_rates" violates check constraint "proc_rates_rate_chk"', "23514");
        }
      }
      if (table === "commission_lines" && op !== "delete") {
        if (r44pay.match_status != null && R44_MATCH_STATUSES.indexOf(r44pay.match_status) === -1) {
          return pgError('new row for relation "commission_lines" violates check constraint "commission_lines_match_status_chk"', "23514");
        }
        /* FK depth: exactly what this mock already does elsewhere — check the
           parent row exists and raise the real SQLSTATE. No new FK engine. */
        if (op === "insert") {
          if (r44pay.statement_id == null) {
            return pgError('null value in column "statement_id" of relation "commission_lines" violates not-null constraint', "23502");
          }
          var parent = DB.commission_statements.filter(function (s) { return String(s.id) === String(r44pay.statement_id); })[0];
          if (!parent) {
            return pgError('insert or update on table "commission_lines" violates foreign key constraint "commission_lines_statement_id_fkey"', "23503");
          }
        }
        if (r44pay.matched_case_id != null && r44pay.matched_case_id !== "") {
          var pcase = DB.cases.filter(function (c) { return String(c.id) === String(r44pay.matched_case_id); })[0];
          if (!pcase) {
            return pgError('insert or update on table "commission_lines" violates foreign key constraint "commission_lines_matched_case_id_fkey"', "23503");
          }
        }
      }
      /* The UNIQUE index on commission_statements(ref) WHERE ref <> ''. This is
         the double-upload guard the app's whole import flow is built around —
         the statement row goes in FIRST precisely so a 23505 here costs nothing
         — so it is emulated rather than left to chance. Blank refs are exempt,
         same as the partial index. */
      if (table === "commission_statements" && op !== "delete") {
        var wantRef = r44pay.ref == null ? "" : String(r44pay.ref).trim();
        if (wantRef !== "") {
          var self = (targets || [])[0];
          var clashes = DB.commission_statements.filter(function (s) {
            return s !== self && String(s.ref || "").trim() === wantRef;
          });
          if (clashes.length) {
            return pgError('duplicate key value violates unique constraint "commission_statements_ref_uniq"', "23505");
          }
        }
      }
      return null;
    }
    if (table === "settings" && !isOwner()) {
      return pgError('new row violates row-level security policy for table "settings"', "42501");
    }
    if (table === "profiles") {
      if (!isOwner()) {
        /* trigger guard_role_change still polices roles under the M1 self-edit policy */
        if (op === "update" && payload && Object.prototype.hasOwnProperty.call(payload, "role")) {
          return pgError("Only an Owner can change a role", "P0001");
        }
        /* M1 — "profiles self edit": update of one's OWN row only. No self-INSERT. */
        var selfOnly = op === "update" && (targets || []).length > 0 &&
          (targets || []).every(function (t) { return t.id === CURRENT_UID; });
        if (!selfOnly) {
          return pgError('new row violates row-level security policy for table "profiles"', "42501");
        }
        return null;
      }
      if (op === "update" && payload && Object.prototype.hasOwnProperty.call(payload, "role") && payload.role !== "owner") {
        var owners = DB.profiles.filter(function (p) { return p.role === "owner"; });
        var losing = (targets || []).filter(function (t) { return t.role === "owner"; });
        if (owners.length - losing.length < 1 && losing.length) {
          return pgError("Cannot remove the last Owner — promote someone else first", "P0001");
        }
      }
    }
    if (op === "delete" && (table === "clients" || table === "cases") && !isAdminOrOwner()) {
      return pgError('permission denied: deleting a ' + (table === "cases" ? "case" : "client") + ' is Owner / Administrator only', "42501");
    }
    return null;
  }
  /* SELECT-side redaction, mirroring the production SELECT policies. */
  function readFilter(table, rows) {
    if (table === "settings" && !isOwner()) {
      return rows.filter(function (r) { return SENSITIVE_SETTING_KEYS.indexOf(r.key) === -1; });
    }
    if (table === "audit_log" && !isOwner()) {
      return rows.filter(function (r) { return AUDIT_OWNER_ONLY_TABLES.indexOf(r.table_name) === -1; });
    }
    /* M4 — "dup dismiss read staff" */
    if (table === "duplicate_dismissals" && !isStaff()) return [];
    /* R9-M10 — "case docs read staff". A client's document checklist says what
       they have and have not been able to produce; an introducer login has no
       business seeing it. The client's own view of it comes from the doc-upload
       function on the service role, not from a policy here. */
    if (table === "case_documents" && !isStaff()) return [];
    /* R13 — "staff read" / "staff all": staff_absences and case_files are
       both firm-internal records with no client- or introducer-facing view
       anywhere in the app. */
    if (table === "staff_absences" && !isStaff()) return [];
    if (table === "case_files" && !isStaff()) return [];
    /* R14 — "vault select": is_staff() AND (visible_to is null/empty OR the
       signed-in user's role = any(visible_to)). An introducer (never staff)
       sees nothing; every other staff role sees every row whose visible_to
       is unset, plus any row that names their own role. */
    /* R44 — "is_owner() for select" on all three reconciliation tables. An
       adviser or administrator gets an EMPTY read, not a filtered one: there is
       no row on these tables that is theirs to see. */
    if (R44_TABLES.indexOf(table) >= 0 && !isOwner()) return [];
    if (table === "vault_entries") {
      if (!isStaff()) return [];
      var myR = myRole();
      return rows.filter(function (r) {
        var vt = r.visible_to;
        return !vt || !vt.length || vt.indexOf(myR) !== -1;
      });
    }
    return rows;
  }

  /* --------------------------------------------------- triggers: audit + events */
  /* M4 rule (round-4): every new table gets the audit_row trigger. */
  /* G1N-5 — watch_alerts joins the audited set with M3. Hiding a compliance alert for a month is a
     supervised act, and it was the one new round-5 mutation path that left no audit row at all: a
     CRITICAL snooze mirrored its reason into a case note (which IS audited), so criticals left an
     indirect trail, but every warn/info snooze left none — and even for criticals the trail showed
     a note, not who suppressed which alert until when. */
  /* R9 — case_documents joins the audited set under the same round-4 rule that
     put duplicate_dismissals there: every new table gets the trigger. Marking a
     document "received" or "waived" is a decision about whether a file is
     complete, and who made it is worth keeping. */
  /* R13 — staff_absences and case_files join the audited set under the same
     round-4 rule that put duplicate_dismissals and case_documents there:
     every new table gets the trigger. */
  var AUDITED = ["clients", "cases", "case_tasks", "case_notes", "appointments", "settings", "profiles",
    "introducers", "duplicate_dismissals", "watch_alerts", "case_documents",
    "staff_absences", "case_files", "vault_entries"];
  var AUDIT_HIDDEN = "(hidden)";
  var AUDIT_TABLE_WORD = {
    clients: "client", cases: "case", case_tasks: "task", case_notes: "note",
    appointments: "appointment", settings: "setting", profiles: "login", introducers: "introducer",
    duplicate_dismissals: "not-a-duplicate mark", watch_alerts: "watchtower alert",
    case_documents: "document", staff_absences: "absence", case_files: "file",
    vault_entries: "vault entry"
  };
  function rowLabel(table, row) {
    if (!row) return "";
    if (table === "clients") return [row.first_name, row.last_name].filter(Boolean).join(" ") || row.email || row.id;
    if (table === "cases") {
      var cl = DB.clients.filter(function (c) { return c.id === row.client_id; })[0];
      var nm = cl ? [cl.first_name, cl.last_name].filter(Boolean).join(" ") : "";
      return (nm ? nm + " — " : "") + (row.case_kind || "case");
    }
    if (table === "case_tasks") return row.title || row.id;
    if (table === "case_notes") return String(row.body || "").slice(0, 60);
    if (table === "appointments") return row.title || row.id;
    if (table === "settings") return row.key;
    if (table === "profiles") return row.full_name || row.email || row.id;
    if (table === "introducers") return row.name || row.id;
    if (table === "case_documents") return row.item || row.id;
    if (table === "staff_absences") {
      var absP = DB.profiles.filter(function (p) { return p.id === row.profile_id; })[0];
      return (absP ? (absP.full_name || absP.email) : row.profile_id) + " — " + row.starts_on + " to " + row.ends_on;
    }
    if (table === "case_files") return row.name || row.id;
    // R14 — "<name> (<owner>)" when an owner is set, else just the name; matches
    // how the vault list itself disambiguates the three "Test Bank A" rows.
    if (table === "vault_entries") return row.name + (row.owner_label ? " (" + row.owner_label + ")" : "");
    // G1N-5 — the alert's own title, so the summary reads "<who> updated watch_alerts
    // "James Whitfield — ERC outlasts the rate"" rather than a row id.
    if (table === "watch_alerts") return row.title || row.dedupe_key || row.id;
    if (table === "duplicate_dismissals") {
      var an = DB.clients.filter(function (c) { return c.id === row.a_id; })[0];
      var bn = DB.clients.filter(function (c) { return c.id === row.b_id; })[0];
      var nm = function (c, id) { return c ? ([c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || id) : id; };
      return nm(an, row.a_id) + " / " + nm(bn, row.b_id);
    }
    return row.id;
  }
  /* R14 — mirrors production's audit_vault_row() trigger: every field entry
     flagged secret:true has its VALUE replaced with "(hidden)"; the label and
     the secret flag itself (and every non-secret field, untouched) stay in
     the clear, because "what fields exist" is not the secret — the values
     behind the secret ones are. */
  function maskVaultFieldsArray(arr) {
    return (Array.isArray(arr) ? arr : []).map(function (f) {
      if (f && f.secret) return { label: f.label, value: AUDIT_HIDDEN, secret: true };
      return f;
    });
  }
  function maskChanges(table, row, changes) {
    if (table === "vault_entries") {
      var vout = {};
      Object.keys(changes || {}).forEach(function (f) {
        var v = changes[f];
        if (f !== "fields") { vout[f] = v; return; }
        var isDiffShape = v && typeof v === "object" && !Array.isArray(v) && ("old" in v || "new" in v);
        vout[f] = isDiffShape
          ? { old: maskVaultFieldsArray(v.old), new: maskVaultFieldsArray(v.new) }
          : maskVaultFieldsArray(v);
      });
      return vout;
    }
    if (table !== "settings") return changes;
    var key = (row && row.key) || "";
    if (SENSITIVE_SETTING_KEYS.indexOf(key) === -1) return changes;
    var out = {};
    Object.keys(changes).forEach(function (f) {
      var v = changes[f];
      if (f === "value") out[f] = (v && typeof v === "object" && "old" in v) ? { old: AUDIT_HIDDEN, new: AUDIT_HIDDEN } : AUDIT_HIDDEN;
      else out[f] = v;
    });
    return out;
  }
  function linkageFor(table, row) {
    var caseId = null, clientId = null;
    if (!row) return { case_id: null, client_id: null };
    if (table === "cases") { caseId = row.id; clientId = row.client_id || null; }
    else if (table === "clients") { clientId = row.id; }
    else {
      caseId = row.case_id || null;
      clientId = row.client_id || null;
      if (caseId && !clientId) {
        var cs = DB.cases.filter(function (c) { return c.id === caseId; })[0];
        if (cs) clientId = cs.client_id;
      }
    }
    return { case_id: caseId, client_id: clientId };
  }
  function auditRow(table, action, row, changes, whenIso, actorId) {
    if (AUDITED.indexOf(table) === -1) return;
    var link = linkageFor(table, row);
    var actor = actorId === undefined ? CURRENT_UID : actorId;
    var label = actor ? ((DB.profiles.filter(function (p) { return p.id === actor; })[0] || {}).full_name || actorLabel()) : null;
    var verb = action === "insert" ? "created" : action === "update" ? "updated" : "deleted";
    DB.audit_log.push({
      id: nid("au"),
      happened_at: whenIso || iso(NOW),
      actor: actor,
      actor_label: label,
      action: action,
      table_name: table,
      row_id: row ? row[pkOf(table)] : null,
      case_id: link.case_id,
      client_id: link.client_id,
      summary: (label || "System") + " " + verb + " " + table + ' "' + rowLabel(table, row) + '"',
      changes: maskChanges(table, row, changes)
    });
  }
  var CASE_EVENT_FIELDS = {
    stage: "stage_changed", fee_status: "fee_status_changed",
    protection_status: "protection_status_changed", rate_end_date: "rate_end_date_changed",
    assigned_to: "case_assigned", offer_doc_path: "offer_uploaded"
  };
  function caseEvent(caseId, event, detail, whenIso, actorId) {
    DB.case_events.push({
      id: nid("ev"), case_id: caseId, event: event, detail: detail,
      actor: actorId === undefined ? CURRENT_UID : actorId, created_at: whenIso || iso(NOW)
    });
  }
  /* ------------------------------------------------------------------------
     TRIGGER PARITY: fact_finds_log_submit → log_fact_find_submit()
     (PLAN-R5 § Backend ground truth (e) / § Harness fixes 5, closing R5-14)

     Production fires on a fact_find becoming `submitted` and creates, in one
     transaction: a case_event, a case_note, and a "Review submitted fact-find"
     task due today, assigned to the case's adviser. The mock owed the app all
     three — their absence is what made R5-14 look like an app gap.
     Idempotent: one task per fact_find row, exactly as the trigger is.
     ---------------------------------------------------------------------- */
  var FF_TASK_TITLE = "Review submitted fact-find";
  function logFactFindSubmit(ff, whenIso, actorId) {
    if (!ff || !ff.case_id) return;
    var when = whenIso || ff.submitted_at || iso(NOW);
    var cs = DB.cases.filter(function (c) { return c.id === ff.case_id; })[0];
    var already = DB.case_tasks.some(function (t) { return t.case_id === ff.case_id && t.title === FF_TASK_TITLE && !t.done_at; });
    caseEvent(ff.case_id, "fact_find_submitted", "Fact-find submitted by the client", when,
      actorId === undefined ? (cs ? cs.assigned_to : null) : actorId);
    DB.case_notes.push({
      id: nid("nt"), case_id: ff.case_id,
      body: "Fact-find submitted by the client — review the answers and apply what's right onto the case.",
      created_by: cs ? (cs.assigned_to || "p4") : "p4",
      created_at: when
    });
    if (already) return;
    DB.case_tasks.push({
      id: nid("tk"), case_id: ff.case_id, title: FF_TASK_TITLE,
      due_date: dateOnly(new Date(when)), done_at: null,
      created_by: cs ? (cs.assigned_to || "p4") : "p4",
      assigned_to: cs ? cs.assigned_to : null,
      created_at: when
    });
  }

  function caseEventsForUpdate(before, after) {
    Object.keys(CASE_EVENT_FIELDS).forEach(function (f) {
      if (!Object.prototype.hasOwnProperty.call(after, f)) return;
      var a = before[f] == null ? "" : String(before[f]);
      var b = after[f] == null ? "" : String(after[f]);
      if (a === b) return;
      var ev = CASE_EVENT_FIELDS[f];
      var detail = ev === "case_assigned"
        ? "Assigned to " + ((DB.profiles.filter(function (p) { return p.id === after[f]; })[0] || {}).full_name || "nobody")
        : (a || "—") + " → " + (b || "—");
      caseEvent(after.id, ev, detail);
    });
  }

  /* --------------------------------------------------------- defaults on insert */
  var PREFIX = {
    clients: "cl", cases: "ca", case_tasks: "tk", case_notes: "nt", case_events: "ev",
    appointments: "ap", email_queue: "eq", sms_queue: "sq", case_emails: "ce",
    fact_finds: "ff", leads: "ld", introducers: "in", profiles: "pr",
    watch_alerts: "wa", audit_log: "au", duplicate_dismissals: "dd",
    case_documents: "cd",
    staff_absences: "sa", case_files: "cf",
    vault_entries: "ve", referrals: "rf"
  };
  function applyInsertDefaults(table, row) {
    var r = clone(row);
    var pk = pkOf(table);
    /* R30 — error_events: a numeric, incrementing id (serial parity) and the four
       nullable fingerprint columns default to null so a select always returns the key. */
    if (table === "error_events") {
      if (r.id == null) r.id = ++errorEventSeq;
      ["error_type", "location", "page", "role"].forEach(function (f) { if (r[f] === undefined) r[f] = null; });
    }
    /* R43 — saved_views: user_id DEFAULTS TO THE CALLER (production's `default auth.uid()`), which
       is why the app never sends it; filters defaults to '{}'::jsonb and updated_at to now().
       No id (the PK is the triple) and no created_at — the real table has neither column. */
    if (table === "saved_views") {
      if (r.user_id == null) r.user_id = CURRENT_UID;
      if (r.filters == null) r.filters = {};
      r.updated_at = iso(new Date());
    }
    /* R44 — the three reconciliation tables. Identity ids, `created_by default
       auth.uid()` on the statement, and — the part that matters for parity —
       every text column defaults to '' rather than null, exactly as the
       migration declares it. The app reads these columns straight into HTML
       through esc(), and esc(null) and esc("") both render nothing, but a test
       asserting "the addressee is empty" should see the empty string production
       would give it, not null. */
    if (table === "proc_rates") {
      if (r.id == null) r.id = ++procRateSeq;
      ["lender", "product", "lg_code", "notes", "effective_label"].forEach(function (f) { if (r[f] == null) r[f] = ""; });
      if (!r.uploaded_at) r.uploaded_at = iso(new Date());
      if (r.rate === undefined) r.rate = null;
    }
    if (table === "commission_statements") {
      if (r.id == null) r.id = ++commissionStatementSeq;
      ["ref", "statement_label", "filename"].forEach(function (f) { if (r[f] == null) r[f] = ""; });
      if (r.created_by === undefined || r.created_by == null) r.created_by = CURRENT_UID;
      if (r.line_count == null) r.line_count = 0;
      ["statement_date", "gross_total", "net_total"].forEach(function (f) { if (r[f] === undefined) r[f] = null; });
    }
    if (table === "commission_lines") {
      if (r.id == null) r.id = ++commissionLineSeq;
      ["tran_type", "addressee", "provider", "account_number", "opp_id", "reason",
        "policy_type", "policy_group", "adviser_name", "match_note"].forEach(function (f) { if (r[f] == null) r[f] = ""; });
      if (r.match_status == null) r.match_status = "unmatched";
      /* R48 — attributed_to (nullable uuid → profiles.id) rides alongside the
         other nullable columns so .select("*") always returns the key and an
         .update({attributed_to}) round-trips. The FK is left as loose as the
         mock's other soft FKs (matched_case_id gets a depth check; this mirrors
         production's `on delete set null` without a strict insert guard). */
      ["line_date", "premium", "banked_gross", "banked_net", "matched_case_id", "confirmed_at", "attributed_to"]
        .forEach(function (f) { if (r[f] === undefined) r[f] = null; });
    }
    /* R56 — referrals: production defaults `status 'made'` and stamps updated_at; the nullable
       columns default so select("*") always returns the key (the standing parity rule). */
    if (table === "referrals") {
      if (r.status == null) r.status = "made";
      if (!r.updated_at) r.updated_at = iso(NOW);
      ["client_id", "referred_to", "notes", "created_by"].forEach(function (f) { if (r[f] === undefined) r[f] = null; });
    }
    if (pk === "id" && !r.id) r.id = nid(PREFIX[table] || "row");
    if (!r.created_at && table !== "settings" && table !== "saved_views") r.created_at = iso(NOW);
    if (table === "cases" || table === "clients" || table === "vault_entries") { if (!r.updated_at) r.updated_at = iso(NOW); }
    if (table === "cases") {
      if (!r.stage) r.stage = "enquiry";
      if (r.protection_status == null) r.protection_status = "not_discussed";
      if (r.fee_status == null) r.fee_status = "not_requested";
      if (r.rate_end_estimated == null) r.rate_end_estimated = false;
      /* M2 / M7 / M10 / M11 columns exist on every row, null until something
         records them. waiting_on, solicitor_firm, doc_token and
         referrer_client_id join the list for round 9 — a case created by the app
         has all four, empty, exactly as the migrations leave them. r12b adds
         the retention call-pack numerics the same way: they exist, empty,
         on a case the app creates — nobody types a reversion rate in on the
         New Case form. */
      /* R13 — policy_start_date / exchange_date / offer_issued_date /
         repayment_method land with no backfill, same as every other M-round
         column above: null on every row until something records it. */
      /* R14b — mortgage_account_number joins the list on the same rule: null
         on every row a write doesn't name, undefined-safe so select("*")
         always returns the key (app.js's hasOwnProperty feature-detect
         depends on that). */
      /* R16 — the BTL rent/ICR trio and the three lender-tracker columns join
         the list on the identical rule: plain nullable columns, no migration
         toggle (same as mortgage_account_number above), null on every row a
         write doesn't name so btlIcrSupported()/lenderTrackSupported()'s
         hasOwnProperty probe always sees them. */
      ["lost_reason", "lost_detail", "broker_fee_paid_at", "proc_fee_paid_at", "sols_fee_paid_at", "property_address",
        "waiting_on", "solicitor_firm", "doc_token", "referrer_client_id",
        "current_balance", "reversion_rate", "monthly_payment", "erc_amount",
        "policy_start_date", "exchange_date", "offer_issued_date", "repayment_method",
        "mortgage_account_number", "objective", "property_sold_at",
        "monthly_rent", "icr_stress_rate", "icr_required_pct",
        "lender_reference", "application_status", "application_status_at"]
        .forEach(function (f) { if (r[f] === undefined) r[f] = null; });
    }
    /* R13 — the care columns exist on every client row, false/null/false until
       the client-detail form (or the reviewer sync) sets them. */
    if (table === "clients") {
      if (r.is_vulnerable === undefined) r.is_vulnerable = false;
      if (r.vulnerability_note === undefined) r.vulnerability_note = null;
      if (r.suppress_automation === undefined) r.suppress_automation = false;
    }
    /* R13 — staff_absences: nothing is optional but the note, which is free text. */
    if (table === "staff_absences" && r.note === undefined) r.note = null;
    /* R13 — case_files: `kind` is a free-text label ("ID", "Payslip", …), optional. */
    if (table === "case_files" && r.kind === undefined) r.kind = null;
    /* R9-M10 — a checklist item starts life REQUESTED, stamped with the moment
       it was asked for, with nothing received against it. */
    if (table === "case_documents") {
      if (!r.status) r.status = "requested";
      if (r.requested_at === undefined || r.requested_at === null) r.requested_at = r.created_at;
      ["received_at", "note", "storage_path"].forEach(function (f) { if (r[f] === undefined) r[f] = null; });
    }
    if (table === "duplicate_dismissals") {
      if (!r.kind) r.kind = "client";
      if (r.reason === undefined) r.reason = null;
      if (r.dismissed_by === undefined) r.dismissed_by = CURRENT_UID;
    }
    if (table === "watch_alerts") {
      /* M3 columns */
      ["snoozed_until", "snooze_note", "snoozed_by"].forEach(function (f) { if (r[f] === undefined) r[f] = null; });
    }
    if (table === "email_queue") {
      if (!r.status) r.status = "queued";
      /* production email_queue schedules sends; an interactive queue is due immediately */
      if (r.scheduled_for === undefined || r.scheduled_for === null) r.scheduled_for = r.created_at;
      if (r.error === undefined) r.error = null;
      if (r.sent_at === undefined) r.sent_at = null;
      /* R66 · M8 — subject / body_html / attachment_path exist on every row, null until something
         writes them, so select("*") always returns the keys (the standing parity rule). A `custom`
         row is the only one the APP fills both text columns on; every other type leaves them for
         process-emails to compose. */
      ["subject", "body_html", "attachment_path"].forEach(function (f) { if (r[f] === undefined) r[f] = null; });
    }
    if (table === "sms_queue" && !r.status) r.status = "queued";
    /* r12b — appointments.outcome: null = not recorded. Exists on every row,
       empty until the app writes attended / no_show / rearranged. */
    if (table === "appointments" && r.outcome === undefined) r.outcome = null;
    if (table === "leads") {
      if (!r.status) r.status = "new";
      /* R11 — discard_reason exists on every row, null until something records it */
      if (r.discard_reason === undefined) r.discard_reason = null;
      /* R7-5 — first_contact_at exists on every row, null until acceptLead()
         or a contacted discardLead() stamps it */
      if (r.first_contact_at === undefined) r.first_contact_at = null;
    }
    if (table === "fact_finds" && !r.status) r.status = "sent";
    if (table === "case_emails" && !r.triage_status) r.triage_status = "new";
    /* R14 — vault_entries: category default 'other', fields default '[]'::jsonb,
       visible_to default null (= visible to every staff role), sort_order
       default 0. owner_label/note/updated_by are nullable with no default. */
    if (table === "vault_entries") {
      if (!r.category) r.category = "other";
      if (r.fields === undefined || r.fields === null) r.fields = [];
      if (r.visible_to === undefined) r.visible_to = null;
      if (r.sort_order === undefined || r.sort_order === null) r.sort_order = 0;
      if (r.owner_label === undefined) r.owner_label = null;
      if (r.note === undefined) r.note = null;
      if (r.updated_by === undefined) r.updated_by = null;
    }
    return r;
  }

  /* =========================================================================
     FIXTURES
     ======================================================================= */
  /* --- profiles ---------------------------------------------------------- */
  /* M1 — per-adviser identity. Wayne and Daniel have theirs filled in so the
     per-adviser sign-off path is exercised; Kim and Luke are deliberately blank
     so the settings.adviser_name / adviser_phone fallback is exercised too. */
  var PROFILE_IDENTITY = {
    p2: {
      phone: "01202 900124",
      email_signoff: "Wayne Kellow\nMortgage & Protection Adviser\nNexMoney · 01202 900124"
    },
    p4: {
      phone: "01202 900123",
      email_signoff: "Daniel Potts\nDirector\nNexMoney"
    }
  };
  /* r12b — tour_seen_at (nullable timestamptz). Every staff persona has
     already seen the first-run tour EXCEPT Luke (p3, adviser): he is the one
     persona the app's first-run tour has to actually fire for, so the tour
     logic gets exercised without every other page-load test tripping it. */
  var TOUR_SEEN_AT = { p3: null };
  Object.keys(PERSONAS).forEach(function (k) {
    var p = PERSONAS[k];
    var ident = PROFILE_IDENTITY[p.id] || {};
    DB.profiles.push({
      id: p.id, full_name: p.full_name, email: p.email, role: p.role, introducer_id: null,
      phone: ident.phone || null, email_signoff: ident.email_signoff || null,
      tour_seen_at: Object.prototype.hasOwnProperty.call(TOUR_SEEN_AT, p.id) ? TOUR_SEEN_AT[p.id] : iso(shift(-60)),
      created_at: iso(shift(-420))
    });
  });
  /* one deactivated colleague — exercises the "no access (still assigned)" paths */
  DB.profiles.push({ id: "p6", full_name: "Priya Raman", email: "priya@nexmoney.co.uk", role: "none", introducer_id: null, phone: null, email_signoff: null, tour_seen_at: iso(shift(-380)), created_at: iso(shift(-380)) });

  /* --- introducers ------------------------------------------------------- */
  [
    ["Foyle & Co Estate Agents", "rachel@foyleandco.co.uk"],
    ["Harding Accountancy", "mail@hardingaccountancy.co.uk"],
    ["Southbourne Lettings", "hello@southbournelettings.co.uk"],
    ["Wessex Wealth Planning", null]
  ].forEach(function (t) {
    DB.introducers.push({ id: nid("in"), name: t[0], email: t[1], created_at: iso(shift(-300)) });
  });
  DB.profiles.filter(function (p) { return p.role === "introducer"; }).forEach(function (p) { p.introducer_id = DB.introducers[0].id; });

  /* --- settings ---------------------------------------------------------- */
  var SETTINGS_SEED = {
    company_name: "NexMoney",
    adviser_name: "Daniel Potts",
    adviser_phone: "01202 900123",
    from_email: "hello@nexmoney.co.uk",
    reply_to_email: "hello@nexmoney.co.uk",
    google_review_link: "https://g.page/r/nexmoney-bournemouth/review",
    review_platform_link: "https://g.page/r/nexmoney-bournemouth/review",
    site_url: "https://www.nexmoney.co.uk",
    /* DELIBERATE: bank details are present-but-empty, so has_bank_details() is false
       and the fee-request flow blocks exactly as it does on a fresh production DB. */
    bank_account_name: "",
    bank_sort_code: "",
    bank_account_number: "",
    monthly_fee_target: "9500",
    rate_reminder_months: "6",
    /* R64 · L5 — the gone-quiet window, seeded at its default so the fixture reads exactly as the
       hard-coded six months did before it became a setting. A suite that wants a different window
       upserts this key and re-runs loadSettings(); blank/absent still means 6 in app.js. */
    client_quiet_months: "6",
    review_delay_days: "14",
    referral_delay_days: "21",
    solicitor_chase_days: "7",
    /* R63 · A2/A3 — THE FIVE bool10 KEYS, AND WHY THEY ARE SPELLED "1"/"0" HERE.
       The Settings form in app.js writes these five as "1"/"0"; the rows production was seeded
       with, and the SQL trigger that reads them, use 'on'/'off'. Both spellings are real, both
       are in the field, and everything that READS one of these keys must accept either —
       app.js's isBool10On() and this file's settingBool10On() are the two places that do.
       The seeded VALUES below are unchanged (auto_offer_update and auto_referral stay off, so
       "the setting is off, so nothing was queued" is a state the harness can still reach); only
       the reading rule moved. */
    auto_docs_request: "1",
    auto_submitted_update: "1",
    auto_offer_update: "0",
    auto_completion_email: "1",
    auto_referral: "0",
    auto_protection_email: "",
    auto_gi_email: "",
    auto_sms_rate_end: "off",
    auto_sms_appointment: "off",
    docs_list: "Photo ID|Last 3 payslips|Last 3 months bank statements|Proof of deposit",
    protection_gate: "on",
    protection_avg_commission: "850",
    financial_promotions_approved: "off",
    birthday_enabled: "off",
    anniversary_enabled: "off",
    /* r8_m1 — the annual review touch, seeded OFF exactly as production ships
       it: a firm that has never been asked must not start booking calls into
       its advisers' task lists on the strength of a deploy. The tests that
       exercise it turn it on themselves, which is also the only way to prove
       the switch is really the gate. */
    annual_review_enabled: "off",
    /* R63 · H1a/H1b — automatic stage-checklist tasks, seeded ON. Unlike the two
       switches either side of it this one does not email anybody: it writes the
       firm's OWN checklist onto their OWN cases, which is the work they had
       already agreed was the work. It ships on because the defect it fixes is
       that 127 of 134 live cases carried no open task at all while the checklist
       sat in the case modal being advisory. The app treats an ABSENT row as ON
       for the same reason (playbookAutoTasksOn), so this row is the mock stating
       the prod default out loud rather than the thing that creates it — the
       tests that prove the switch really is the gate set it to "off" themselves. */
    playbook_auto_tasks: "on",
    /* r9_m10 — the nightly document chase, seeded OFF for the same reason the
       annual review touch is: chasing a client is a decision a firm makes, not
       something a deploy starts doing to their book on its own. The tests that
       exercise it turn it on themselves, which is also the only way to prove the
       switch really is the gate. `doc_chase_days` is the quiet window — nothing
       is chased if anything about documents went to that client inside it. */
    doc_chase_enabled: "off",
    doc_chase_days: "3",
    /* r9 — how long an unanswered review request is left before it is nudged
       once. Seven days: long enough not to read as nagging, short enough that
       the completion is still recent to the client. */
    review_reminder_days: "7",
    nps_enabled: "on",
    owner_digest: "on",
    owner_digest_email: "daniel@nexmoney.co.uk",
    outlook_enabled: "0",
    outlook_mailboxes: "",
    sms_enabled: "off",
    sms_provider: "twilio",
    sms_from: "NexMoney",
    cron_key: "cron_9f2b41ce77a04e13b6d5",
    /* R13 · M-42 — the backup nag. Empty string, not null/absent: this is a
       firm that has NEVER exported, which is the "never" state the nag's
       copy has to render (as opposed to a database that hasn't taken the
       migration at all, which is feature-detected on the KEY being absent —
       see app.js's hasOwnProperty check — and this key is always present). */
    last_full_export_at: "",
    /* R13 · M-43 — the cron heartbeat. Noon-pinned, ~3 days ago: comfortably
       past the 48h staleness threshold, so the amber "may be silently stuck"
       state is the harness default and is testable without a test having to
       manufacture staleness itself. process-emails UPSERTs this on every
       FULL (unscoped) run — see the process-emails stub — so a battery that
       runs an unscoped send will move this value forward; nothing in the
       existing suites relies on it staying exactly 3 days stale. */
    last_cron_run_at: iso(shiftNoon(-3)),
    /* R68 · M15 — THE EMAIL HOLD, seeded 'on' because that is what production
       actually holds: `settings.email_hold = 'on'`, and nothing sends while it
       is anything other than 'off'. app.js has referred to this key in a comment
       since R60 and no screen has ever shown it; the Settings "Email sending"
       strip is the first thing that reads it, so the harness has to hold the
       real value or the strip's default state would be untestable. Tests that
       want the released state write 'off' themselves — which is also the only
       way to prove the switch really is the gate. */
    email_hold: "on"
  };
  Object.keys(SETTINGS_SEED).forEach(function (k) {
    DB.settings.push({ key: k, value: SETTINGS_SEED[k], updated_at: iso(shift(-30)) });
  });

  /* --- clients (40, with the deliberate landmines) ------------------------ */
  var CLIENT_SEED = [
    /* first, last, email, phone, dobOffsetYears, address */
    ["Ruby", "Sinclair", "ruby.sinclair@example.com", "07700 900101", 41, "12 Alum Chine Road, Bournemouth BH4 8DU"],
    ["Duncan", "Armitage", "duncan.armitage@example.com", "07700 900102", 53, "4 Seafield Gardens, Poole BH14 8EQ"],
    ["Deborah", "Ashworth", "deborah.ashworth@example.com", "07700 900103", 38, "88 Charminster Road, Bournemouth BH8 8UE"],
    ["Debbie", "Ashworth", "deborah.ashworth@example.com", "07700 900199", 38, "88 Charminster Rd, Bournemouth BH8 8UE"],
    ["Gordon", "Pike", "gordon.pike@example.com", "07700 900411", 61, "3 Wollaston Road, Bournemouth BH6 4AR"],
    ["G", "Pike", "gpike.builder@example.com", "+44 7700 900411", 61, "3 Wollaston Rd, Bournemouth"],
    ["Marcus", "Bell", null, "07700 900105", 34, "17 Ashley Road, Poole BH14 9BN"],
    ["Yvonne", "Kerr", null, null, 47, "2 Kinson Road, Bournemouth BH10 5EJ"],
    ["Tanya", "Osei", "tanya.osei@example.com", "0770 12", 29, "9 Malmesbury Park Road, Bournemouth"],
    ["Ross", "McKay", "ross(at)example.com", "07700 900107", 44, "31 Southbourne Grove, Bournemouth"],
    ["James", "Whitfield", "james.whitfield@example.com", "07700 900108", 36, "5 Manor Road, Bournemouth BH1 3EY"],
    ["Priya", "Nadkarni", "priya.nadkarni@example.com", "07700 900109", 33, "44 Wimborne Road, Poole BH15 2BU"],
    ["Sarah", "Ellingham", "sarah.ellingham@example.com", "07700 900110", 45, "18 Belle Vue Road, Bournemouth"],
    ["Tom", "Beresford", "tom.beresford@example.com", "07700 900111", 39, "7 Parkstone Road, Poole BH15 2NN"],
    ["Alice", "Fenwick", "alice.fenwick@example.com", "07700 900112", 31, "62 Christchurch Road, Bournemouth"],
    ["Owen", "Cadwallader", "owen.cadwallader@example.com", "07700 900113", 55, "21 Sandbanks Road, Poole BH14 8AQ"],
    ["Nadia", "Hussain", "nadia.hussain@example.com", "07700 900114", 37, "14 Holdenhurst Road, Bournemouth"],
    ["Callum", "Brodie", "callum.brodie@example.com", "07700 900115", 28, "3 Gervis Road, Bournemouth BH1 3DD"],
    ["Elaine", "Mowbray", "elaine.mowbray@example.com", "07700 900116", 58, "26 Wick Lane, Christchurch BH23 1HX"],
    ["Peter", "Thackeray", "peter.thackeray@example.com", "07700 900117", 49, "8 Barrack Road, Christchurch"],
    ["Hannah", "Verity", "hannah.verity@example.com", "07700 900118", 32, "55 Bargates, Christchurch BH23 1QD"],
    ["Ian", "Corrigan", "ian.corrigan@example.com", "07700 900119", 42, "11 Stourvale Road, Bournemouth"],
    ["Meera", "Chandran", "meera.chandran@example.com", "07700 900120", 35, "72 Castle Lane West, Bournemouth"],
    ["Bruce", "Lindquist", "bruce.lindquist@example.com", "07700 900121", 63, "6 Iford Lane, Bournemouth BH6 5NG"],
    ["Sophie", "Ravenhill", "sophie.ravenhill@example.com", "07700 900122", 27, "40 Kings Road, Poole BH14 0BQ"],
    ["Andrew", "Pemberton", "andrew.pemberton@example.com", "07700 900123", 51, "2 Bournemouth Road, Poole"],
    ["Louise", "Garnham", "louise.garnham@example.com", "07700 900124", 40, "19 Sea Road, Bournemouth BH5 1DB"],
    ["Kwame", "Boateng", "kwame.boateng@example.com", "07700 900125", 36, "23 Cranleigh Road, Bournemouth"],
    ["Fiona", "Strachan", "fiona.strachan@example.com", "07700 900126", 46, "9 Fernside Road, Poole BH15 2JL"],
    ["Damian", "Fairhurst", "damian.fairhurst@example.com", "07700 900127", 54, "15 Church Road, Bournemouth"],
    ["Georgia", "Nkemelu", "georgia.nkemelu@example.com", "07700 900128", 30, "48 Ringwood Road, Poole BH14 0RQ"],
    ["Stuart", "Hollingsworth", "stuart.h@example.com", "07700 900129", 48, "5 Portchester Road, Bournemouth"],
    ["Bethany", "Quirke", "bethany.quirke@example.com", "07700 900130", 26, "34 Alma Road, Bournemouth BH9 1AL"],
    ["Nigel", "Trewin", "nigel.trewin@example.com", "07700 900131", 59, "12 Sandecotes Road, Poole"],
    ["Rosalind", "Amery", "rosalind.amery@example.com", "07700 900132", 43, "7 Wimborne Road East, Ferndown"],
    ["Craig", "Dunwoody", "craig.dunwoody@example.com", "07700 900133", 38, "60 New Road, Bournemouth BH10 6AA"],
    ["Amara", "Okonkwo", "amara.okonkwo@example.com", "07700 900134", 34, "3 Leybourne Avenue, Bournemouth"],
    ["Victor", "Salisbury", "victor.salisbury@example.com", "07700 900135", 66, "28 Salisbury Road, Poole BH14 9EG"],
    ["Chloe", "Pennington", "chloe.pennington@example.com", "07700 900136", 29, "17 Cecil Avenue, Bournemouth"],
    ["Harold", "Mainwaring", "harold.mainwaring@example.com", "07700 900137", 71, "1 Undercliff Drive, Bournemouth BH1 3AQ"]
  ];
  /* R8 — WHO HAS A DATE OF BIRTH. Every fixture client used to have one, which
     made the "Missing DOB" segment (and the fix-it-from-the-row affordance next
     to it) permanently empty, and made a fixture book that looks nothing like a
     real one: a DOB is captured on a fact-find and almost never on the phone
     call that opened the case, so a real book is full of holes.
     ~60% carry one here. The pattern is deterministic — the same clients are
     blank on every run — and it leaves the seed's own age spread (26 → 71)
     intact on the ones that have it, so anything age-banded has bands to draw.
     Clients 2 and 3 are exempt from the blanking: they are the strong duplicate
     pair and their matching DOB is what makes that match strong. */
  var HAS_DOB = function (i) { return i === 2 || i === 3 || (i % 5 !== 3 && i % 5 !== 4); };
  /* R13 · CARE COLUMNS (Consumer Duty) — `is_vulnerable` / `vulnerability_note` /
     `suppress_automation`, mirroring app.js's CARE_COLS. Two fixture rows carry
     something other than the false/null/false default, chosen deliberately:
       · i===11 (Priya Nadkarni) — vulnerable, WITH a note, AND suppressed. A
         completed-book client (indices 10..27 get a completed case below) with
         an email on file, so suppression is actually observable in the queueing
         paths that would otherwise mail her (review request/reminder, rate-end
         reminder if she ever gets a retention successor).
       · i===20 (Hannah Verity) — suppressed but NOT vulnerable: the "do not
         contact" case, a business decision with no care reason behind it. Also
         completed-book, also has an email, for the same observability reason.
     Everyone else stays false/null/false — the untouched default a real book
     is mostly made of. */
  CLIENT_SEED.forEach(function (c, i) {
    DB.clients.push({
      id: nid("cl"),
      first_name: c[0], last_name: c[1], email: c[2], phone: c[3],
      date_of_birth: HAS_DOB(i) ? dateOnly(new Date(NOW.getFullYear() - c[4], (i * 7) % 12, ((i * 5) % 27) + 1)) : null,
      address: c[5], notes: null,
      sms_opt_out: i === 9 || i === 21, marketing_opt_out: i === 7 || i === 30,
      is_vulnerable: i === 11,
      vulnerability_note: i === 11 ? "Recently bereaved — prefers correspondence by post, not phone; give extra time on decisions." : null,
      suppress_automation: i === 11 || i === 20,
      created_at: iso(shift(-(400 - i * 8))), updated_at: iso(shift(-(120 - (i % 90))))
    });
  });
  var CL = function (n) { return DB.clients[n].id; };

  /* --- cases (50) -------------------------------------------------------- */
  var LENDERS = ["Halifax", "Nationwide", "Santander", "NatWest", "Barclays", "Coventry Building Society",
    "Accord", "Skipton", "Virgin Money", "The Mortgage Works", "Leeds Building Society", "Aldermore"];
  var KINDS = ["purchase", "remortgage", "product_transfer", "buy_to_let", "first_time_buyer", "other"];
  var OWNERS = ["p2", "p3", "p4", "p2", "p3", "p1", null, "p2", "p3", "p4", "p2", "p3", "p6"];
  var LEAD_SOURCES = ["Google", "Referral", "Repeat client", "Website", "Introducer", "Facebook", null];
  var PROT = ["not_discussed", "discussed", "quoted", "policy_taken", "declined"];
  var GI = ["not_discussed", "quoted", "policy_taken", "declined", "not_applicable"];

  function mkCase(o) {
    var row = {
      id: nid("ca"),
      client_id: o.client_id,
      case_kind: o.case_kind,
      stage: o.stage,
      lender: o.lender || null,
      product_name: o.product_name || null,
      loan_amount: o.loan_amount == null ? null : o.loan_amount,
      property_value: o.property_value == null ? null : o.property_value,
      rate_percent: o.rate_percent == null ? null : o.rate_percent,
      rate_type: o.rate_type || "fixed",
      rate_end_date: o.rate_end_date || null,
      rate_end_estimated: !!o.rate_end_estimated,
      erc_end_date: o.erc_end_date || null,
      offer_expiry_date: o.offer_expiry_date || null,
      expected_completion_date: o.expected_completion_date || null,
      term_years: o.term_years == null ? null : o.term_years,
      submitted_at: o.submitted_at || null,
      proc_fee: o.proc_fee == null ? null : o.proc_fee,
      sols_fee: o.sols_fee == null ? null : o.sols_fee,
      broker_fee: o.broker_fee == null ? null : o.broker_fee,
      fee_status: o.fee_status || "not_requested",
      fee_requested_at: o.fee_requested_at || null,
      fee_paid_at: o.fee_paid_at || null,
      /* M2 — per-fee-type cash dates (backfilled from fee_paid_at below) */
      broker_fee_paid_at: o.broker_fee_paid_at || null,
      proc_fee_paid_at: o.proc_fee_paid_at || null,
      sols_fee_paid_at: o.sols_fee_paid_at || null,
      /* M2 — lost reasons */
      lost_reason: o.lost_reason || null,
      lost_detail: o.lost_detail || null,
      /* M7 — the property the case is about. NULL on most rows by design: the
         column landed today with no backfill, so every case created before it
         has nothing in it. */
      property_address: o.property_address || null,
      /* M10 — what the case is waiting on, who is conveyancing it, and the
         token behind the client's document-upload link. NULL on nearly every
         row on purpose: these landed with no backfill, so the book the app has
         to cope with is mostly blank. */
      waiting_on: o.waiting_on || null,
      solicitor_firm: o.solicitor_firm || null,
      doc_token: o.doc_token || null,
      /* M11 — the client who sent this one to us. */
      referrer_client_id: o.referrer_client_id || null,
      protection_status: o.protection_status || "not_discussed",
      protection_commission: o.protection_commission == null ? null : o.protection_commission,
      gi_status: o.gi_status || "not_discussed",
      lead_source: o.lead_source === undefined ? null : o.lead_source,
      introducer_id: o.introducer_id || null,
      assigned_to: o.assigned_to === undefined ? null : o.assigned_to,
      completed_at: o.completed_at || null,
      retention_source_case_id: o.retention_source_case_id || null,
      offer_doc_path: o.offer_doc_path || null,
      nps_score: o.nps_score == null ? null : o.nps_score,
      review_requested_at: o.review_requested_at || null,
      rate_reminder_queued_at: o.rate_reminder_queued_at || null,
      /* r12b — the retention call-pack columns (W-15). Four nullable numerics,
         NULL on nearly every row on purpose: they landed with no backfill, so
         the book the app has to cope with is mostly blank exactly like M7/M10
         before it. See the r12b fixture pass below for the handful of rows
         that carry real (or deliberately partial) numbers. */
      current_balance: o.current_balance == null ? null : o.current_balance,
      reversion_rate: o.reversion_rate == null ? null : o.reversion_rate,
      monthly_payment: o.monthly_payment == null ? null : o.monthly_payment,
      erc_amount: o.erc_amount == null ? null : o.erc_amount,
      /* r13 — policy_start_date / exchange_date / offer_issued_date /
         repayment_method. Four more nullable, writable columns with no
         backfill — null on nearly every row on purpose, exactly like the
         r12b call-pack numerics above. See the r13 fixture pass below for
         the handful of rows that carry real values. */
      policy_start_date: o.policy_start_date || null,
      exchange_date: o.exchange_date || null,
      offer_issued_date: o.offer_issued_date || null,
      repayment_method: o.repayment_method || null,
      /* R14b — cases.mortgage_account_number, nullable text, no backfill —
         null on nearly every row, exactly like the four r13 columns above.
         See the R14 fixture pass below for the two rows that carry a
         (plainly fake) value. */
      mortgage_account_number: o.mortgage_account_number || null,
      /* R57 — the pinned objective. Nullable text, no backfill, same rule as
         every plain-column addition above. */
      objective: o.objective || null,
      /* R59 — property_sold_at, the visible SOLD stamp written by the rate-end
         outcome's sold path. Nullable date, no backfill, same rule as above. */
      property_sold_at: o.property_sold_at || null,
      /* R16 §A/§B — BTL rent/ICR trio (numerics, null = not recorded) and the
         submit-to-lender tracker (lender_reference text, application_status
         text, application_status_at timestamptz). No backfill — null on
         nearly every row, exactly like every other plain-column addition
         above. See the R16 fixture pass below for the handful of rows that
         carry real (fake) values. */
      monthly_rent: o.monthly_rent == null ? null : o.monthly_rent,
      icr_stress_rate: o.icr_stress_rate == null ? null : o.icr_stress_rate,
      icr_required_pct: o.icr_required_pct == null ? null : o.icr_required_pct,
      lender_reference: o.lender_reference || null,
      application_status: o.application_status || null,
      application_status_at: o.application_status_at || null,
      created_at: o.created_at || iso(shift(-30)),
      updated_at: o.updated_at || o.created_at || iso(shift(-10))
    };
    DB.cases.push(row);
    caseEvent(row.id, "case_created", "Stage: " + row.stage, row.created_at, row.assigned_to || "p4");
    return row;
  }

  /* 18 completed cases spread over the last 6 months (3 per month) */
  var completedCases = [];
  for (var m = 0; m < 6; m++) {
    for (var k = 0; k < 3; k++) {
      var idx = m * 3 + k;
      var compDays = -(m * 30 + 6 + k * 8);
      /* noon-pinned: submitted_at below is dateOnly() (midnight); completed_at
         is iso(comp) (keeps hh:mm:ss) — see shiftNoon() comment. EXCEPT the one
         case that lands exactly on review_delay_days (14): the review-request
         drip backlog below decides "already 14 days old" with
         (NOW - completed_at)/DAY < delay, and shift(-14) is the one
         construction that keeps that exactly 14.000 days — always the same
         side of the line — because it is built from the identical NOW
         instance the drip check reads. Noon-pinning that one case would make
         its age wobble either side of 14 with real wall-clock time instead,
         which is a second copy of the very bug this pin is fixing. */
      var comp = compDays === -14 ? shift(compDays) : shiftNoon(compDays);
      var clientIdx = 10 + idx;                      /* clients 10..27 */
      var proc = 1150 + rint(0, 22) * 100;
      var broker = pick([0, 0, 395, 495, 695, 995]);
      var sols = pick([0, 150, 250, 350]);
      var feeStatus = broker > 0 ? pick(["paid", "paid", "requested", "not_requested", "waived"]) : "not_requested";
      var c = mkCase({
        client_id: CL(clientIdx),
        case_kind: pick(KINDS),
        stage: "completed",
        lender: pick(LENDERS),
        product_name: pick(["2yr Fixed 95%", "5yr Fixed 85%", "5yr Fixed 75%", "2yr Tracker", "3yr Fixed 90%"]),
        loan_amount: 95000 + rint(0, 60) * 5000,
        property_value: 180000 + rint(0, 80) * 5000,
        rate_percent: Number((3.79 + rint(0, 22) / 10).toFixed(2)),
        rate_end_date: dateOnly(shift(compDays + (m === 5 ? 40 : 730))),
        rate_end_estimated: idx % 7 === 0,
        erc_end_date: idx % 5 === 0 ? dateOnly(shift(compDays + 900)) : null,
        term_years: pick([20, 25, 30, 35]),
        submitted_at: dateOnly(shift(compDays - rint(30, 70))),
        proc_fee: proc, sols_fee: sols, broker_fee: broker,
        fee_status: feeStatus,
        fee_requested_at: feeStatus === "not_requested" ? null : iso(shift(compDays + 1)),
        /* R5-18 (MOCK_ARTEFACT) — a fee cannot have been banked in the future.
           completion + 3..20 days ran past the fixture "now" for recent months,
           which is what manufactured the 88%-vs-45% target-bar discrepancy.
           Clamped to yesterday; the deliberate future-dated row for the app-side
           clamp test is seeded separately (see FUTURE-DATED FEE below). */
        fee_paid_at: feeStatus === "paid"
          ? iso(Math.min(shift(compDays + rint(3, 20)).getTime(), shift(-1).getTime()))
          : null,
        protection_status: PROT[idx % PROT.length],
        protection_commission: idx % PROT.length === 3 ? 600 + rint(0, 9) * 50 : null,
        gi_status: GI[idx % GI.length],
        lead_source: LEAD_SOURCES[idx % LEAD_SOURCES.length],
        introducer_id: idx % 4 === 0 ? DB.introducers[idx % DB.introducers.length].id : null,
        assigned_to: OWNERS[idx % OWNERS.length],
        completed_at: iso(comp),
        nps_score: idx % 3 === 0 ? rint(6, 10) : null,
        review_requested_at: idx % 3 === 0 ? iso(shift(compDays + 14)) : null,
        created_at: iso(shift(compDays - rint(60, 140))),
        updated_at: iso(shift(compDays + 1))
      });
      completedCases.push(c);
    }
  }

  /* the retention pair: a completed case + a linked enquiry that came from it */
  var retentionSource = completedCases[2];
  retentionSource.rate_end_date = dateOnly(shift(75));
  retentionSource.rate_reminder_queued_at = iso(shift(-6));
  var retentionCase = mkCase({
    client_id: retentionSource.client_id,
    case_kind: "remortgage", stage: "fact_find",
    lender: retentionSource.lender, loan_amount: retentionSource.loan_amount,
    property_value: retentionSource.property_value,
    rate_end_date: retentionSource.rate_end_date, rate_end_estimated: false,
    term_years: 22, lead_source: "Repeat client",
    assigned_to: retentionSource.assigned_to || "p2",
    retention_source_case_id: retentionSource.id,
    protection_status: "discussed",
    created_at: iso(shift(-14)), updated_at: iso(shift(-3))
  });
  var retentionCase2 = mkCase({
    client_id: completedCases[7].client_id,
    case_kind: "product_transfer", stage: "enquiry",
    lender: completedCases[7].lender, loan_amount: completedCases[7].loan_amount,
    rate_end_date: dateOnly(shift(120)),
    lead_source: "Repeat client", assigned_to: "p3",
    retention_source_case_id: completedCases[7].id,
    created_at: iso(shift(-9)), updated_at: iso(shift(-9))
  });
  /* one retention win and one retention loss, so the conversion % has a basis */
  mkCase({
    client_id: completedCases[11].client_id, case_kind: "remortgage", stage: "completed",
    lender: "Barclays", loan_amount: 178000, property_value: 295000, rate_percent: 4.34,
    rate_end_date: dateOnly(shift(1750)), term_years: 21,
    proc_fee: 1490, broker_fee: 495, sols_fee: 0, fee_status: "paid",
    fee_requested_at: iso(shift(-58)), fee_paid_at: iso(shift(-50)),
    protection_status: "policy_taken", protection_commission: 910,
    lead_source: "Repeat client", assigned_to: "p2",
    retention_source_case_id: completedCases[11].id,
    /* noon-pinned to match its dateOnly() submitted_at — see shiftNoon() comment */
    completed_at: iso(shiftNoon(-55)), submitted_at: dateOnly(shift(-96)),
    created_at: iso(shift(-130)), updated_at: iso(shiftNoon(-55))
  });
  mkCase({
    client_id: completedCases[15].client_id, case_kind: "remortgage", stage: "not_proceeding",
    lender: "NatWest", loan_amount: 143000, term_years: 19,
    lead_source: "Repeat client", assigned_to: "p3",
    retention_source_case_id: completedCases[15].id,
    created_at: iso(shift(-160)), updated_at: iso(shift(-110))
  });

  /* 4 not_proceeding */
  [28, 29, 30, 31].forEach(function (ci, i) {
    mkCase({
      client_id: CL(ci), case_kind: pick(KINDS), stage: "not_proceeding",
      lender: pick(LENDERS), loan_amount: 120000 + i * 25000, property_value: 210000 + i * 30000,
      rate_percent: 4.99, broker_fee: pick([0, 495]), proc_fee: 0,
      lead_source: LEAD_SOURCES[i % LEAD_SOURCES.length],
      introducer_id: i === 0 ? DB.introducers[0].id : null,
      assigned_to: OWNERS[(i + 2) % OWNERS.length],
      protection_status: "declined",
      created_at: iso(shift(-(90 + i * 20))), updated_at: iso(shift(-(30 + i * 5)))
    });
  });

  /* Ruby Sinclair — the dense client (6 cases across the live pipeline) */
  var RUBY = CL(0);
  var rubySpecs = [
    { stage: "enquiry", kind: "buy_to_let", days: -4, prot: "not_discussed" },
    { stage: "fact_find", kind: "buy_to_let", days: -26, prot: "not_discussed" },
    { stage: "decision_in_principle", kind: "remortgage", days: -33, prot: "discussed" },
    { stage: "application", kind: "buy_to_let", days: -48, prot: "not_discussed" },
    { stage: "offer", kind: "purchase", days: -70, prot: "quoted" },
    { stage: "exchange", kind: "buy_to_let", days: -96, prot: "policy_taken" }
  ];
  rubySpecs.forEach(function (s, i) {
    mkCase({
      client_id: RUBY, case_kind: s.kind, stage: s.stage,
      lender: LENDERS[i % LENDERS.length],
      product_name: "5yr Fixed 75%",
      loan_amount: 140000 + i * 30000, property_value: 260000 + i * 40000,
      rate_percent: Number((4.19 + i / 10).toFixed(2)),
      rate_end_date: s.stage === "offer" || s.stage === "exchange" ? dateOnly(shift(1780)) : null,
      term_years: 25,
      submitted_at: ["application", "offer", "exchange"].indexOf(s.stage) >= 0 ? dateOnly(shift(s.days + 10)) : null,
      expected_completion_date: s.stage === "offer" ? dateOnly(shift(24)) : (s.stage === "exchange" ? dateOnly(shift(9)) : null),
      proc_fee: 1400 + i * 60, broker_fee: i % 2 === 0 ? 495 : 0, sols_fee: 0,
      fee_status: "not_requested",
      protection_status: s.prot, protection_commission: s.prot === "policy_taken" ? 780 : null,
      gi_status: s.kind === "purchase" ? "not_discussed" : "not_applicable",
      lead_source: "Repeat client",
      assigned_to: i === 5 ? null : (i % 2 === 0 ? "p2" : "p3"),
      created_at: iso(shift(s.days - 10)),
      updated_at: iso(shift(s.days))
    });
  });

  /* Duncan Armitage — 2 live cases (the app's own duplicate-title example) */
  [{ stage: "application", days: -40 }, { stage: "offer", days: -62 }].forEach(function (s, i) {
    mkCase({
      client_id: CL(1), case_kind: i ? "remortgage" : "product_transfer", stage: s.stage,
      lender: "Skipton", product_name: "2yr Fixed 60%",
      loan_amount: 210000, property_value: 430000, rate_percent: 4.44,
      rate_end_date: dateOnly(shift(38)), rate_end_estimated: i === 1,
      erc_end_date: dateOnly(shift(210)),
      expected_completion_date: i === 1 ? dateOnly(shift(31)) : null,
      submitted_at: dateOnly(shift(s.days + 12)),
      proc_fee: 1680, broker_fee: 695, sols_fee: 0, fee_status: "requested",
      fee_requested_at: iso(shift(-9)),
      protection_status: i ? "quoted" : "not_discussed",
      lead_source: "Referral", assigned_to: "p3", term_years: 18,
      created_at: iso(shift(s.days - 20)), updated_at: iso(shift(s.days))
    });
  });

  /* the rest of the live pipeline, filling every stage */
  var LIVE_SPECS = [
    { ci: 2, stage: "enquiry", days: -2, own: "p2" },
    { ci: 3, stage: "enquiry", days: -6, own: null },
    { ci: 6, stage: "enquiry", days: -11, own: "p4" },
    { ci: 7, stage: "fact_find", days: -13, own: "p2" },
    { ci: 8, stage: "fact_find", days: -19, own: "p3" },
    { ci: 9, stage: "fact_find", days: -28, own: null },
    { ci: 4, stage: "decision_in_principle", days: -24, own: "p4" },
    { ci: 5, stage: "decision_in_principle", days: -35, own: "p2" },
    { ci: 32, stage: "application", days: -30, own: "p3" },
    { ci: 33, stage: "application", days: -52, own: "p1" },
    { ci: 34, stage: "application", days: -18, own: "p4" },
    { ci: 35, stage: "offer", days: -44, own: "p2" },
    { ci: 36, stage: "offer", days: -25, own: "p3" },
    { ci: 37, stage: "offer", days: -58, own: "p1" },
    { ci: 38, stage: "exchange", days: -66, own: "p2" },
    { ci: 39, stage: "exchange", days: -21, own: "p4" }
  ];
  LIVE_SPECS.forEach(function (s, i) {
    var isOfferish = s.stage === "offer" || s.stage === "exchange";
    /* deliberately leave a few offer/exchange cases with NO expected completion date */
    var noDate = (i === 12 || i === 14);
    var kind = KINDS[(i + 1) % KINDS.length];
    mkCase({
      client_id: CL(s.ci), case_kind: kind, stage: s.stage,
      lender: LENDERS[(i + 3) % LENDERS.length],
      product_name: pick(["2yr Fixed 85%", "5yr Fixed 80%", "5yr Fixed 60%", "2yr Tracker"]),
      loan_amount: 105000 + i * 17500,
      property_value: 195000 + i * 24000,
      rate_percent: Number((4.09 + (i % 9) / 10).toFixed(2)),
      rate_end_date: isOfferish ? dateOnly(shift(1800 + i * 5)) : (i % 4 === 0 ? dateOnly(shift(90 + i * 7)) : null),
      rate_end_estimated: i % 6 === 0,
      erc_end_date: i % 5 === 0 ? dateOnly(shift(2100)) : null,
      offer_expiry_date: s.stage === "offer" ? dateOnly(shift(70)) : null,
      expected_completion_date: isOfferish && !noDate ? dateOnly(shift(12 + i * 4)) : null,
      term_years: pick([20, 25, 30]),
      submitted_at: ["application", "offer", "exchange"].indexOf(s.stage) >= 0 ? dateOnly(shift(s.days + 14)) : null,
      proc_fee: 1200 + i * 45, sols_fee: i % 3 === 0 ? 250 : 0,
      broker_fee: i % 3 === 0 ? 0 : 495,
      fee_status: "not_requested",
      protection_status: PROT[(i + 2) % PROT.length],
      gi_status: (kind === "purchase" || kind === "first_time_buyer") ? GI[i % GI.length] : "not_applicable",
      lead_source: LEAD_SOURCES[(i + 3) % LEAD_SOURCES.length],
      introducer_id: i % 5 === 0 ? DB.introducers[(i + 1) % DB.introducers.length].id : null,
      assigned_to: s.own,
      created_at: iso(shift(s.days - 12)),
      updated_at: iso(shift(s.days))
    });
  });

  /* DELIBERATE LANDMINE: rate ended 15 days ago AND the ERC runs on for months */
  var ercTrap = mkCase({
    client_id: CL(19), case_kind: "remortgage", stage: "completed",
    lender: "Precise Mortgages", product_name: "2yr Fixed 75%",
    loan_amount: 188000, property_value: 305000, rate_percent: 5.64,
    rate_end_date: dateOnly(shift(-15)),
    erc_end_date: dateOnly(shift(190)),
    term_years: 24,
    proc_fee: 1310, sols_fee: 0, broker_fee: 795, fee_status: "requested",
    fee_requested_at: iso(shift(-40)),
    protection_status: "not_discussed", gi_status: "not_discussed",
    lead_source: "Google", assigned_to: "p2",
    completed_at: iso(shift(-745)),
    created_at: iso(shift(-820)), updated_at: iso(shift(-60))
  });

  /* DELIBERATE DIRT for Data health — one completed case per fault class.
     Applied to existing rows rather than added, so the case count stays honest. */
  completedCases[4].rate_end_date = null;                 /* completed, no rate-end date   */
  completedCases[4].erc_end_date = null;
  completedCases[9].completed_at = null;                  /* completed, no completion date */
  completedCases[13].broker_fee = 0;                      /* completed, no fee recorded    */
  completedCases[13].proc_fee = 0;
  completedCases[13].sols_fee = 0;
  completedCases[13].fee_status = "waived";
  completedCases[13].fee_paid_at = null;

  /* The duplicate pair sharing an EMAIL is a strong match (same surname + DOB);
     the pair sharing a PHONE stays a weak one. Two different merge journeys. */
  DB.clients[3].last_name = DB.clients[2].last_name;
  DB.clients[3].date_of_birth = DB.clients[2].date_of_birth;

  /* ---------------------------------------------------------------- M2 seeds */
  /* Backfill exactly as the migration does: the single legacy date stands in for
     each fee type that has an amount. */
  DB.cases.forEach(function (c) {
    if (c.fee_status !== "paid" || !c.fee_paid_at) return;
    if (Number(c.broker_fee || 0) > 0) c.broker_fee_paid_at = c.fee_paid_at;
    if (Number(c.proc_fee || 0) > 0) c.proc_fee_paid_at = c.fee_paid_at;
    if (Number(c.sols_fee || 0) > 0) c.sols_fee_paid_at = c.fee_paid_at;
  });

  /* SPLIT-PAID case (B7 / Batch 6.4): broker banked last month, proc banked this
     month, so a per-type-date report must land each £ in a different month while
     the legacy single date can only ever pick one. */
  (function splitPaid() {
    var c = completedCases.filter(function (x) {
      return Number(x.broker_fee || 0) > 0 && Number(x.proc_fee || 0) > 0 && x.fee_status === "paid";
    })[0];
    if (!c) return;
    var lastMonth = new Date(NOW.getFullYear(), NOW.getMonth() - 1, 14, 12, 0, 0);
    var thisMonth = new Date(NOW.getFullYear(), NOW.getMonth(), Math.max(1, Math.min(NOW.getDate() - 1, 12)), 12, 0, 0);
    c.broker_fee_paid_at = iso(lastMonth);
    c.proc_fee_paid_at = iso(thisMonth);
    c.sols_fee_paid_at = Number(c.sols_fee || 0) > 0 ? iso(thisMonth) : null;
    c.fee_paid_at = iso(thisMonth);           /* legacy column = the latest date */
  })();

  /* FUTURE-DATED FEE — one row deliberately banked in the future, so Batch 6.4's
     "excludes future-dated payments (N)" clamp has something to exclude. This is
     the only future cash date in the fixtures (see R5-18 clamp above). */
  (function futureDatedFee() {
    var c = completedCases.filter(function (x) {
      return Number(x.broker_fee || 0) > 0 && x.fee_status === "requested";
    })[0];
    if (!c) return;
    /* keep it inside the CURRENT month wherever the fixture "now" falls, so the
       date inflates this month's collected figure until the clamp lands */
    var endOfMonth = new Date(NOW.getFullYear(), NOW.getMonth() + 1, 0, 12, 0, 0);
    var future = shift(9).getTime() < endOfMonth.getTime() ? shift(9) : endOfMonth;
    if (future.getTime() <= NOW.getTime()) future = shift(9);
    c.fee_status = "paid";
    c.broker_fee_paid_at = iso(future);
    c.fee_paid_at = c.broker_fee_paid_at;
    if (Number(c.proc_fee || 0) > 0) c.proc_fee_paid_at = c.broker_fee_paid_at;
  })();

  /* LOST REASONS — a mix, so B6's losses panel has real buckets AND a legacy
     "(not recorded)" bucket. Batch 2 makes the reason mandatory going forward. */
  (function seedLostReasons() {
    var lost = DB.cases.filter(function (c) { return c.stage === "not_proceeding"; });
    var seeds = [
      { reason: "went_direct", detail: "Client went straight to Nationwide for a product transfer." },
      { reason: "another_broker", detail: "Used the estate agent's in-house broker." },
      { reason: "affordability", detail: null }
    ];
    lost.slice(0, seeds.length).forEach(function (c, i) {
      c.lost_reason = seeds[i].reason;
      c.lost_detail = seeds[i].detail;
    });
  })();

  /* RETENTION WINDOW — one completed case whose rate ends INSIDE the reminder
     window with no reminder queued and no successor, so mock
     queue_automated_emails() has a case to auto-create from (production's real
     create path). The already-ended rates (Kwame Boateng, −132d) stay outside
     the window on purpose: that is the production gap the manual "Start
     retention case" button exists to close. */
  (function retentionWindowSeed() {
    var src = completedCases[8];              /* owned by an adviser, so the successor is too */
    src.rate_end_date = dateOnly(shift(45));
    src.rate_end_estimated = false;
    src.rate_reminder_queued_at = null;
  })();

  /* A current-month cohort so the Reports funnel / lead sources have depth on
     the picker's default month. Live stages only — a completed case's created_at
     must stay behind its completion date. */
  (function currentMonthCohort() {
    var wanted = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange", "not_proceeding"];
    /* R8 FIXTURE REPAIR — `Math.max(2, NOW.getDate() - 2)` broke this block for the
       first days of every month, i.e. two days in thirty:
         · on the 1st and 2nd it back-dated the "current-month" cohort into the
           PREVIOUS month, which is the one thing the block exists to avoid;
         · with no room to spread, every row landed on the same instant, so two
           cases on one property stopped being "at different times" and the M7
           fixture assertion in r5_batch2 failed; and
         · a row landing at exactly `NOW` ties with rows the APP inserts during a
           test (applyInsertDefaults stamps iso(NOW) too), which makes "the three
           most recent cases" ambiguous and cost r5_batch7 its import assertion.
       Rows are now placed inside this month by construction, spread across the
       part of it that has actually happened, and never within a minute of NOW. */
    var maxBack = Math.max(0, NOW.getDate() - 1);
    var monthStart = new Date(NOW.getFullYear(), NOW.getMonth(), 1, 0, 0, 0).getTime();
    var latest = NOW.getTime() - 60000;
    var elapsed = Math.max(0, NOW.getTime() - monthStart);
    var COHORT_MAX = wanted.length * 2;
    var seq = 0;
    wanted.forEach(function (stage, i) {
      var pool = DB.cases.filter(function (c) { return c.stage === stage; });
      pool.slice(0, 2).forEach(function (c, j) {
        var back = Math.min(maxBack, 1 + i * 2 + j);
        var t = shift(-back).getTime() - (seq * 3) * 60000;
        /* Too new, or before the month began (a month only hours old): fall back to
           an even spread over the elapsed part of the month, which is distinct per
           row and always in the past. */
        if (t > latest || t < monthStart) t = monthStart + Math.round((elapsed * (seq + 1)) / (COHORT_MAX + 2));
        var when = new Date(t);
        seq++;
        c.created_at = iso(when);
        /* The submitted stages carry a submission INSIDE this month too — without
           it, on the 1st the reports page's default month opens with no
           applications at all and every month-on-month comparison is against
           nothing. A case is submitted no earlier than it is created. */
        if (["application", "offer", "exchange"].indexOf(stage) >= 0) c.submitted_at = dateOnly(when);
        if (new Date(c.updated_at) < new Date(c.created_at)) c.updated_at = c.created_at;
        if (!c.lead_source) c.lead_source = LEAD_SOURCES[(i + j) % (LEAD_SOURCES.length - 1)];
        DB.case_events.forEach(function (ev) {
          if (ev.case_id === c.id && ev.event === "case_created") ev.created_at = c.created_at;
        });
      });
    });
  })();

  /* PRIOR-YEAR COMPLETIONS (Batch 6.1 / S8) — the year-on-year series on the
     "Completions by month" chart needs a previous calendar year to draw beside
     the current one, and the base fixture only spans the last six months, so
     the prior year was empty and a YoY chart had nothing to show.
     Deliberately placed in March / May / September so June and July of the
     prior year stay COMPLETELY EMPTY: that is the "no data" case the KPI delta
     chips must distinguish from a real fall to zero. Fees are banked in the
     same month each case completed, and the rate ends well outside the
     retention reminder window so these rows add no alerts or Today items. */
  (function priorYearCompletions() {
    var pyr = NOW.getFullYear() - 1;
    [{ mo: 2, day: 11, cl: 28, adv: "p2", proc: 1420, broker: 495, sols: 250, loan: 232000, kind: "remortgage", lender: "Halifax", src: "Referral" },
     { mo: 4, day: 6,  cl: 29, adv: "p3", proc: 1180, broker: 695, sols: 0,   loan: 189000, kind: "purchase",   lender: "Nationwide", src: "Google" },
     { mo: 8, day: 23, cl: 30, adv: "p2", proc: 1610, broker: 0,   sols: 250, loan: 274000, kind: "buy_to_let", lender: "Barclays", src: "Repeat client" }
    ].forEach(function (s) {
      var comp = new Date(pyr, s.mo, s.day, 12, 0, 0);
      var created = new Date(pyr, s.mo - 4, s.day, 9, 0, 0);
      var submitted = new Date(pyr, s.mo - 1, s.day, 10, 0, 0);
      var c = mkCase({
        client_id: CL(s.cl), case_kind: s.kind, stage: "completed",
        lender: s.lender, product_name: "5yr Fixed 75%",
        loan_amount: s.loan, property_value: Math.round(s.loan / 0.72), rate_percent: 4.79,
        rate_end_date: dateOnly(shift(400)), term_years: 25,
        submitted_at: iso(submitted),
        proc_fee: s.proc, sols_fee: s.sols, broker_fee: s.broker,
        fee_status: "paid", fee_requested_at: iso(comp), fee_paid_at: iso(comp),
        protection_status: "policy_taken", gi_status: "not_applicable",
        lead_source: s.src, assigned_to: s.adv,
        completed_at: iso(comp), created_at: iso(created), updated_at: iso(comp)
      });
      /* M2 per-type cash dates, same as the backfill above (which has already run) */
      c.broker_fee_paid_at = s.broker > 0 ? iso(comp) : null;
      c.proc_fee_paid_at = s.proc > 0 ? iso(comp) : null;
      c.sols_fee_paid_at = s.sols > 0 ? iso(comp) : null;
    });
  })();

  /* --- case_tasks -------------------------------------------------------- */
  var liveCases = DB.cases.filter(function (c) { return ["completed", "not_proceeding"].indexOf(c.stage) === -1; });
  var TASK_TITLES = ["Chase solicitor for exchange date", "Call client re documents", "Send DIP to client",
    "Book fact find call", "Chase lender for offer", "Protection call", "Confirm valuation booked",
    "Follow up on payslips", "Chase broker fee invoice", "Review rate options"];
  liveCases.forEach(function (c, i) {
    if (i % 5 === 4) return;
    var dueOffset = i % 4 === 0 ? -(rint(1, 12)) : (i % 4 === 1 ? 0 : rint(1, 13));
    DB.case_tasks.push({
      id: nid("tk"), case_id: c.id, title: TASK_TITLES[i % TASK_TITLES.length],
      due_date: dateOnly(shift(dueOffset)), done_at: null,
      created_by: c.assigned_to || "p4",
      /* a few tasks are deliberately unassigned so the Unassigned scope has rows */
      assigned_to: (i % 7 === 3) ? null : (c.assigned_to || "p1"),
      created_at: iso(shift(-rint(2, 24)))
    });
  });
  /* a handful of already-done tasks, plus a couple of far-future ones */
  liveCases.slice(0, 6).forEach(function (c, i) {
    DB.case_tasks.push({
      id: nid("tk"), case_id: c.id, title: "Initial call", due_date: dateOnly(shift(-(20 + i))),
      done_at: iso(shift(-(18 + i))), created_by: "p4", assigned_to: c.assigned_to || "p2",
      created_at: iso(shift(-(25 + i)))
    });
    DB.case_tasks.push({
      id: nid("tk"), case_id: c.id, title: "Annual review reminder", due_date: dateOnly(shift(120 + i * 10)),
      done_at: null, created_by: "p4", assigned_to: c.assigned_to || "p3",
      created_at: iso(shift(-2))
    });
  });

  /* --- case_notes (with the Call:/Email:/Meeting: prefix convention) ------ */
  var NOTE_BODIES = [
    "Call: discussed affordability, client happy to proceed on the 5yr fix.",
    "Email: sent the document checklist and the fact-find link.",
    "Meeting: face to face at the office — signed the client agreement.",
    "Client wants completion before the end of the school term.",
    "Call: left voicemail, will try again tomorrow.",
    "Email: chased the solicitor for the exchange date.",
    "Valuation came back at asking price.",
    "Call: protection conversation held, quotes to follow."
  ];
  DB.cases.forEach(function (c, i) {
    var n = (i % 3) + 1;
    for (var j = 0; j < n; j++) {
      DB.case_notes.push({
        id: nid("nt"), case_id: c.id,
        body: NOTE_BODIES[(i + j) % NOTE_BODIES.length],
        created_by: c.assigned_to || "p4",
        created_at: iso(shift(-(rint(1, 60) + j * 3)))
      });
    }
  });

  /* --- appointments (incl. a deliberate same-slot clash for p2) ---------- */
  var APPT_TITLES = ["Fact find call", "Review meeting", "Protection review", "Document collection", "Completion call"];
  for (var a = 0; a < 16; a++) {
    var apptDom = Math.min(28, 2 + a * 2);
    /* Never let this spread land ON TODAY: the dedicated "today" appointments seeded right below
       this loop (Ruby/Duncan's deliberate p2 clash + Marcus's plain-titled one) are the exact,
       closed set several tests (tests/r5_batch9.js's Day-view §2) key off — "today has exactly
       these 3". apptDom is always even (2 + a*2), so nudging it off today by 1 always lands on an
       odd day this loop never otherwise uses, with no risk of colliding with another seeded day. */
    if (apptDom === NOW.getDate()) apptDom = apptDom >= 28 ? apptDom - 1 : apptDom + 1;
    var when = new Date(NOW.getFullYear(), NOW.getMonth(), apptDom, 9 + (a % 7), 0, 0, 0);
    var c2 = liveCases[a % liveCases.length];
    DB.appointments.push({
      id: nid("ap"), title: APPT_TITLES[a % APPT_TITLES.length],
      starts_at: iso(when), ends_at: iso(new Date(when.getTime() + 45 * 60000)),
      staff_id: ["p2", "p3", "p4", "p1"][a % 4],
      client_id: c2.client_id, case_id: c2.id,
      location: pick(["Office", "Phone", "Teams", "Client's home"]), notes: null,
      /* r12b — outcome: null everywhere in fixtures. The app records it. */
      outcome: null,
      created_at: iso(shift(-20))
    });
  }
  /* today's two appointments … */
  var todayAt = function (h) { var d = new Date(NOW); d.setHours(h, 0, 0, 0); return d; };
  DB.appointments.push({
    id: nid("ap"), title: "Fact find call — Ruby Sinclair",
    starts_at: iso(todayAt(10)), ends_at: iso(new Date(todayAt(10).getTime() + 60 * 60000)),
    staff_id: "p2", client_id: RUBY, case_id: DB.cases.filter(function (c) { return c.client_id === RUBY; })[0].id,
    location: "Teams", notes: null, outcome: null, created_at: iso(shift(-4))
  });
  /* … the second one CLASHES with the first (same adviser, same slot) */
  DB.appointments.push({
    id: nid("ap"), title: "Protection review — Duncan Armitage",
    starts_at: iso(todayAt(10)), ends_at: iso(new Date(todayAt(10).getTime() + 45 * 60000)),
    staff_id: "p2", client_id: CL(1), case_id: DB.cases.filter(function (c) { return c.client_id === CL(1); })[0].id,
    location: "Phone", notes: "Double-booked — needs moving", outcome: null, created_at: iso(shift(-2))
  });
  DB.appointments.push({
    id: nid("ap"), title: "Completion call — Whitfield",
    starts_at: iso(todayAt(15)), ends_at: iso(new Date(todayAt(15).getTime() + 30 * 60000)),
    staff_id: "p3", client_id: CL(10), case_id: null,
    location: "Phone", notes: null, outcome: null, created_at: iso(shift(-3))
  });
  /* PLAN-R5 Batch 3 (R5-9) — a PLAIN-titled appointment today. Every other appointment seeded for
     today already has the client's name typed into its title, which is exactly the case R5-9 must
     NOT double up; this is the case it must fill in. Deliberately at 14:00 so it clashes with
     nothing (R5-25's pair is the 10:00 one above). */
  (function plainTitledApptToday() {
    var marcus = DB.clients.filter(function (x) { return x.first_name === "Marcus" && x.last_name === "Bell"; })[0];
    if (!marcus) return;
    var mcase = DB.cases.filter(function (c) { return c.client_id === marcus.id; })[0] || null;
    DB.appointments.push({
      id: nid("ap"), title: "Protection review",
      starts_at: iso(todayAt(14)), ends_at: iso(new Date(todayAt(14).getTime() + 45 * 60000)),
      staff_id: "p2", client_id: marcus.id, case_id: mcase ? mcase.id : null,
      location: "Office", notes: null, outcome: null, created_at: iso(shift(-5))
    });
  })();

  /* --- email_queue (incl. failed sends: a bounce and a missing address) --- */
  var EMAIL_TYPES = ["welcome", "docs_request", "submitted_update", "offer_update", "completion_congrats",
    "rate_end_reminder", "review_request", "fee_request", "protection_offer", "gi_exchange"];
  DB.cases.slice(0, 26).forEach(function (c, i) {
    var cl = DB.clients.filter(function (x) { return x.id === c.client_id; })[0];
    var status = i % 9 === 0 ? "queued" : (i % 11 === 3 ? "cancelled" : "sent");
    var created = iso(shift(-(rint(2, 60))));
    DB.email_queue.push({
      id: nid("eq"), case_id: c.id, client_id: c.client_id,
      email_type: EMAIL_TYPES[i % EMAIL_TYPES.length],
      to_email: (cl && cl.email) || "",
      subject: "NexMoney — your mortgage update",
      status: status,
      error: null,
      sent_at: status === "sent" ? iso(shift(-(rint(1, 40)))) : null,
      scheduled_for: created,
      created_at: created
    });
  });
  /* failed #1 — the client has no email address on file at all */
  var marcusCase = DB.cases.filter(function (c) { return c.client_id === CL(6); })[0];
  DB.email_queue.push({
    id: nid("eq"), case_id: marcusCase ? marcusCase.id : null, client_id: CL(6),
    email_type: "welcome", to_email: "", subject: "Welcome to NexMoney",
    status: "failed", error: "No recipient address — the client record has no email on file",
    sent_at: null, scheduled_for: iso(shift(-5)), created_at: iso(shift(-5))
  });
  /* failed #2 — a hard bounce (offers the "Fix contact" link) */
  var rossCase = DB.cases.filter(function (c) { return c.client_id === CL(9); })[0];
  DB.email_queue.push({
    id: nid("eq"), case_id: rossCase ? rossCase.id : null, client_id: CL(9),
    email_type: "docs_request", to_email: "ross(at)example.com", subject: "Your document checklist",
    status: "failed", error: "550 5.1.1 recipient address is invalid — message bounced",
    sent_at: null, scheduled_for: iso(shift(-3)), created_at: iso(shift(-3))
  });
  /* A stuck-in-the-queue row, older than a day.
     R5-1/R5-51 HARNESS FIX: this row used to hardcode Duncan Armitage's address
     onto Callum Brodie's case — an impossible state that no code path can
     produce, and it made the "queued row addressed to the wrong person" repro
     unfalsifiable. The recipient is now derived from the row's own client. */
  (function stuckQueued() {
    var c = liveCases[1];
    var cl = DB.clients.filter(function (x) { return x.id === c.client_id; })[0] || {};
    DB.email_queue.push({
      id: nid("eq"), case_id: c.id, client_id: c.client_id,
      email_type: "rate_end_reminder", to_email: cl.email || "",
      subject: "Your rate is coming to an end", status: "queued", error: null,
      sent_at: null, scheduled_for: iso(shift(-4)), created_at: iso(shift(-4))
    });
  })();
  /* …and the HONEST version of R5-51's scenario, kept separate: a row queued to
     the address the client had at the time, whose client has since changed their
     email. to_email is a genuine stale snapshot, not a mismatched person. */
  (function staleAddressQueued() {
    var cl = DB.clients[35];                                 /* Craig Dunwoody, live at Offer */
    if (!cl || !cl.email) return;
    var c = DB.cases.filter(function (x) { return x.client_id === cl.id && isLive(x.stage); })[0];
    var stale = cl.email;                                    /* what we queued to */
    cl.email = "craig.dunwoody@newdomain.example.com";        /* changed afterwards */
    cl.updated_at = iso(shift(-1));
    DB.email_queue.push({
      id: nid("eq"), case_id: c ? c.id : null, client_id: cl.id,
      email_type: "docs_request", to_email: stale,
      subject: "Your document checklist", status: "queued", error: null,
      sent_at: null, scheduled_for: iso(shift(-2)), created_at: iso(shift(-2))
    });
  })();

  /* --- sms_queue --------------------------------------------------------- */
  DB.cases.slice(0, 8).forEach(function (c, i) {
    var cl = DB.clients.filter(function (x) { return x.id === c.client_id; })[0];
    DB.sms_queue.push({
      id: nid("sq"), case_id: c.id, client_id: c.client_id,
      sms_type: i % 2 ? "appointment_reminder" : "rate_end",
      to_phone: (cl && cl.phone) || "",
      status: i === 3 ? "failed" : (i === 5 ? "queued" : "sent"),
      error: i === 3 ? "Invalid destination number — not a valid mobile" : null,
      sent_at: i === 3 || i === 5 ? null : iso(shift(-(rint(1, 25)))),
      created_at: iso(shift(-(rint(2, 40))))
    });
  });
  DB.sms_queue.push({
    id: nid("sq"), case_id: null, client_id: CL(8),
    sms_type: "rate_end", to_phone: "0770 12", status: "failed",
    error: "Invalid number — could not be delivered", sent_at: null, created_at: iso(shift(-6))
  });

  /* --- case_emails (inbound, Outlook sync) ------------------------------- */
  liveCases.slice(0, 7).forEach(function (c, i) {
    var cl = DB.clients.filter(function (x) { return x.id === c.client_id; })[0];
    DB.case_emails.push({
      id: nid("ce"), case_id: c.id, client_id: c.client_id,
      from_email: (cl && cl.email) || "unknown@example.com",
      subject: pick(["Re: your mortgage application", "Documents attached", "Quick question about the offer", "Re: fact find"]),
      snippet: "Thanks for the update — I've attached the last three payslips as requested…",
      received_at: iso(shift(-(i + 1))),
      triage_status: i < 4 ? "new" : "handled",
      created_at: iso(shift(-(i + 1)))
    });
  });

  /* --- fact_finds (one submitted, matching factfind.html's answer keys) --- */
  var ffCase = liveCases.filter(function (c) { return c.stage === "fact_find"; })[0] || liveCases[0];
  var ffClient = DB.clients.filter(function (c) { return c.id === ffCase.client_id; })[0];
  DB.fact_finds.push({
    id: nid("ff"), case_id: ffCase.id, client_id: ffCase.client_id, created_by: "p2",
    token: "ff-demo-0001-submitted", status: "submitted",
    submitted_at: iso(shift(-2)), created_at: iso(shift(-9)),
    data: {
      a1_first: ffClient.first_name,
      a1_last: ffClient.last_name,
      a1_dob: "1989-04-17",
      a1_address: "31 Ferncroft Gardens",
      a1_postcode: "BH10 6JJ",
      email: ffClient.email || "new.address@example.com",
      phone: "07700 900777",
      a2_first: "",
      m_loan: "245000",
      m_value: "390000",
      m_term: "27",
      c_credit_cards: "3200",
      c_loans: "0",
      p_review: "yes",
      p_life: "no",
      p_ip: "no",
      has_a2: "no"
    }
  });
  DB.fact_finds.push({
    id: nid("ff"), case_id: liveCases[3].id, client_id: liveCases[3].client_id, created_by: "p3",
    token: "ff-demo-0002-sent", status: "sent", submitted_at: null,
    created_at: iso(shift(-4)), data: {}
  });
  /* A few more SUBMITTED fact-finds so the Apply flow is easy to reach from several
     cases. Each carries values that CONFLICT with the case/client on some fields and
     fill gaps on others — that is the whole point of the Apply diff screen. */
  liveCases.filter(function (c) { return ["fact_find", "decision_in_principle", "application"].indexOf(c.stage) >= 0; })
    .slice(0, 4).forEach(function (c, i) {
      if (DB.fact_finds.some(function (f) { return f.case_id === c.id; })) return;
      var cl = DB.clients.filter(function (x) { return x.id === c.client_id; })[0] || {};
      DB.fact_finds.push({
        id: nid("ff"), case_id: c.id, client_id: c.client_id, created_by: c.assigned_to || "p4",
        token: "ff-demo-submitted-" + (i + 3), status: "submitted",
        submitted_at: iso(shift(-(i + 1))), created_at: iso(shift(-(i + 6))),
        data: {
          a1_first: cl.first_name || "", a1_last: cl.last_name || "",
          a1_dob: cl.date_of_birth || "1987-11-02",
          a1_address: "8 Bryanstone Road", a1_postcode: "BH3 7JJ",
          email: cl.email || "supplied.by.client" + i + "@example.com",
          phone: cl.phone || "07700 9008" + (10 + i),
          m_loan: String((c.loan_amount || 200000) + 15000),
          m_value: String((c.property_value || 320000) + 5000),
          m_term: String((c.term_years || 25) + 2),
          c_credit_cards: String(1000 + i * 750), c_loans: i % 2 ? "8400" : "0",
          p_review: i % 2 ? "yes" : "no", p_life: "no", p_ip: i % 2 ? "no" : "yes",
          has_a2: "no"
        }
      });
    });
  /* …and every seeded SUBMITTED fact-find carries the trigger's output, so the
     "Review submitted fact-find" task exists on those cases from the start
     (PLAN-R5 § Harness fixes 5). */
  DB.fact_finds.filter(function (f) { return f.status === "submitted"; })
    .forEach(function (f) { logFactFindSubmit(f, f.submitted_at, null); });

  /* --- leads (new + old) ------------------------------------------------- */
  [
    ["Deborah & Michael Ashworth", "d.m.ashworth@example.com", "07700 900301", "remortgage", "Our fix ends in October, can you look at options?", "new", -1, "320000"],
    ["Owen Trelawney", "owen.trelawney@example.com", "07700 900302", "first-time-buyer", "First purchase, 10% deposit saved.", "new", -2, "245000"],
    ["Farida Bahri", "farida.bahri@example.com", "07700 900303", "buy-to-let", "Looking at a second BTL in Poole.", "new", -4, "199000"],
    ["Colin Sharratt", null, "07700 900304", "home-mover", "Moving up the road, need a bigger place.", "new", -6, null],
    ["Janet Pilkington", "janet.pilkington@example.com", "07700 900305", "remortgage", "Rate ends next year.", "converted", -95, "280000"],
    ["Alan Rutherford", "alan.rutherford@example.com", "07700 900306", "first-time-buyer", null, "discarded", -140, null]
  ].forEach(function (l) {
    DB.leads.push({
      id: nid("ld"), name: l[0], email: l[1], phone: l[2], enquiry_type: l[3],
      message: l[4], status: l[5], created_at: iso(shift(l[6])),
      property_value: l[7], converted_case_id: null,
      /* R11 — `alter table leads add column discard_reason text` (nullable, no
         backfill, no RLS change). Null on every fixture row, including the
         one already discarded — production shipped this with nothing filled
         in, so a discarded lead with no reason on file is the honest state,
         not a fixture gap. */
      discard_reason: null,
      /* R7-5 — `alter table leads add column first_contact_at timestamptz`
         (nullable, no backfill). Null on every row above; none of them has
         ever been accepted or discarded-after-contact. */
      first_contact_at: null
    });
  });

  /* R7-5 — three already-accepted leads, so the owner-only Lead-response
     report (Reports) has real data instead of its degraded "no
     first_contact_at column" state. first_contact_at is built as N MINUTES
     after the same row's created_at — a span, not a wall-clock timestamp —
     so the response time this report shows never depends on what real
     instant the fixtures happened to load at (the lesson from the
     conveyancer-speed noon-pinning above: a stable span comes from anchoring
     both ends to the same reference, not from picking an absolute time).
     Two carry a span; the third is left null — an accept from before this
     column existed and never backfilled, exactly as production shipped it,
     and the one shape leadResponseMins() must handle (both dates required,
     or no response time). All three sit inside the report's 90-day window;
     Janet Pilkington above (-95 days, no stamp either) does not, and was
     never meant to. */
  [
    ["Priya Nathan", "priya.nathan@example.com", "07700 900307", "remortgage", "Two-year fix ending soon, want to compare.", -10, 22],
    ["Martin Oyelaran", "martin.oyelaran@example.com", "07700 900308", "buy-to-let", "New-build BTL, need advice on rates.", -22, 3 * 60 + 40],
    ["Harriet Coombes", "harriet.coombes@example.com", "07700 900309", "home-mover", "Chain of three, need an AIP fast.", -35, null]
  ].forEach(function (l) {
    var createdAt = shift(l[5]);
    DB.leads.push({
      id: nid("ld"), name: l[0], email: l[1], phone: l[2], enquiry_type: l[3],
      message: l[4], status: "converted", created_at: iso(createdAt),
      property_value: null, converted_case_id: null, discard_reason: null,
      first_contact_at: l[6] == null ? null : iso(new Date(createdAt.getTime() + l[6] * 60000))
    });
  });

  /* =========================================================================
     ROUND 6 — MULTI-PROPERTY FIXTURES (M7 · cases.property_address)

     The point of the round: a client is not a property. Until now every fixture
     client had at most one address (their own, on `clients.address`), so
     "which property is this case about?" was unanswerable and nothing that
     groups, de-duplicates or labels BY PROPERTY could be tested at all.

     What is seeded here, and why each one exists:
       (a) Gareth Pollard — a portfolio landlord: 5 buy-to-lets across 5
           DIFFERENT addresses in 5 different stages, two of them completed with
           rates that end in DIFFERENT months (so "which of his properties needs
           looking at first?" has a real answer, and neither rate sits inside the
           6-month reminder window, which would otherwise manufacture alerts).
       (b) Melanie Underhill — the ordinary shape: the home she lives in, plus
           one buy-to-let. Two cases, two addresses, two completely different
           conversations.
       (c) Ruby Sinclair — her SIX existing cases get addresses, and two of them
           are on the SAME property at different times (a buy-to-let application
           on 8 Grand Avenue, then a remortgage of the same flat a fortnight
           later). "Same property, different case" is the thing most likely to be
           got wrong, so it is in the fixtures rather than left to a test to set
           up. Duncan Armitage's pair is the same shape on his own home.
       (d) Ian & Susan Fairweather — a joint-name client with two properties, so
           nothing may assume one name means one person or one address.
       LANDMINE: 9 Bryanstone Road appears on TWO different clients' cases —
           the previous owner completed there months ago and sold it to Gareth,
           who is now at Offer on it. Matching cases on address string alone
           will merge two unrelated people.

     Everything else keeps property_address NULL on purpose. The column landed
     today with no backfill, so most of the book has nothing in it and the app
     has to read as well without it as with it.

     Placement: this block runs AFTER `liveCases`, the appointment/email/SMS
     seeds and the task/note seeds have been built from the earlier fixtures, so
     it adds rows without renumbering a single existing id or shifting which
     case an existing appointment hangs off. It runs BEFORE the case_events and
     audit seeds, so the new cases still get a stage history and a change log.
     ======================================================================= */
  (function multiPropertyFixtures() {
    /* a date n whole months from now, for rate-end dates that must land in
       named, DIFFERENT months however far the fixture "now" has drifted */
    var inMonths = function (n, day) { return dateOnly(new Date(NOW.getFullYear(), NOW.getMonth() + n, day)); };
    /* an absolute past date, used to keep new completions inside months the
       fixtures already populate (June/July of the prior year stay empty on
       purpose — the KPI delta chips distinguish "no data" from a fall to zero) */
    var on = function (y, mo, day) { return new Date(y, mo - 1, day, 12, 0, 0); };
    var PY = NOW.getFullYear() - 1;

    var newClient = function (first, last, email, phone, ageYears, address, madeDaysAgo) {
      var c = {
        id: nid("cl"), first_name: first, last_name: last, email: email, phone: phone,
        date_of_birth: dateOnly(new Date(NOW.getFullYear() - ageYears, 3, 17)),
        address: address, notes: null, sms_opt_out: false, marketing_opt_out: false,
        is_vulnerable: false, vulnerability_note: null, suppress_automation: false,
        created_at: iso(shift(-madeDaysAgo)), updated_at: iso(shift(-Math.round(madeDaysAgo / 4)))
      };
      DB.clients.push(c);
      return c.id;
    };

    /* ---- (a) the portfolio landlord --------------------------------------
       He lives in Westbourne and rents out five other properties. Two are
       done and on fixed rates that expire in different months; the other
       three are at three different points of the pipeline. */
    var pollard = newClient("Gareth", "Pollard", "gareth.pollard@example.com", "07700 900141", 57,
      "5 Grosvenor Road, Westbourne, Bournemouth BH4 9AZ", 900);
    var pollardCompletedA = mkCase({
      client_id: pollard, case_kind: "buy_to_let", stage: "completed",
      property_address: "Flat 4, 27 Stourwood Avenue, Southbourne, Bournemouth BH6 3QP",
      lender: "The Mortgage Works", product_name: "2yr Fixed 75%",
      loan_amount: 172000, property_value: 235000, rate_percent: 5.19, term_years: 22,
      rate_end_date: inMonths(8, 14), rate_end_estimated: false,
      submitted_at: dateOnly(on(PY, 1, 20)),
      proc_fee: 1290, broker_fee: 595, sols_fee: 250, fee_status: "paid",
      fee_requested_at: iso(on(PY, 3, 25)), fee_paid_at: iso(on(PY, 4, 2)),
      protection_status: "declined", gi_status: "policy_taken",
      lead_source: "Referral", assigned_to: "p2",
      completed_at: iso(on(PY, 3, 24)),
      created_at: iso(on(PY - 1, 11, 5)), updated_at: iso(on(PY, 4, 2))
    });
    pollardCompletedA.broker_fee_paid_at = pollardCompletedA.fee_paid_at;
    pollardCompletedA.proc_fee_paid_at = pollardCompletedA.fee_paid_at;
    pollardCompletedA.sols_fee_paid_at = pollardCompletedA.fee_paid_at;
    var pollardCompletedB = mkCase({
      client_id: pollard, case_kind: "buy_to_let", stage: "completed",
      property_address: "63 Malvern Road, Bournemouth BH9 3AS",
      lender: "Aldermore", product_name: "2yr Fixed 70%",
      loan_amount: 148000, property_value: 212000, rate_percent: 5.44, term_years: 20,
      /* deliberately a DIFFERENT month from the one above */
      rate_end_date: inMonths(14, 27), rate_end_estimated: false,
      submitted_at: dateOnly(on(PY, 8, 1)),
      proc_fee: 1110, broker_fee: 595, sols_fee: 0, fee_status: "paid",
      fee_requested_at: iso(on(PY, 9, 9)), fee_paid_at: iso(on(PY, 9, 19)),
      protection_status: "declined", gi_status: "quoted",
      lead_source: "Repeat client", assigned_to: "p2",
      completed_at: iso(on(PY, 9, 8)),
      created_at: iso(on(PY, 5, 12)), updated_at: iso(on(PY, 9, 19))
    });
    pollardCompletedB.broker_fee_paid_at = pollardCompletedB.fee_paid_at;
    pollardCompletedB.proc_fee_paid_at = pollardCompletedB.fee_paid_at;
    mkCase({
      client_id: pollard, case_kind: "buy_to_let", stage: "application",
      property_address: "12A Herbert Avenue, Parkstone, Poole BH12 4HR",
      lender: "Paragon", product_name: "5yr Fixed 75%",
      loan_amount: 196000, property_value: 268000, rate_percent: 5.09, term_years: 25,
      submitted_at: dateOnly(shift(-38)),
      proc_fee: 1470, broker_fee: 595, sols_fee: 0, fee_status: "requested",
      fee_requested_at: iso(shift(-30)),
      protection_status: "discussed", gi_status: "quoted",
      lead_source: "Repeat client", assigned_to: "p2",
      created_at: iso(shift(-74)), updated_at: iso(shift(-6))
    });
    mkCase({
      client_id: pollard, case_kind: "buy_to_let", stage: "offer",
      /* the landmine address — see the previous owner below */
      property_address: "9 Bryanstone Road, Bournemouth BH3 7JQ",
      lender: "Precise Mortgages", product_name: "2yr Fixed 70%",
      loan_amount: 154000, property_value: 224000, rate_percent: 5.74, term_years: 18,
      submitted_at: dateOnly(shift(-33)), offer_expiry_date: dateOnly(shift(64)),
      expected_completion_date: dateOnly(shift(27)),
      proc_fee: 1155, broker_fee: 595, sols_fee: 250, fee_status: "not_requested",
      protection_status: "quoted", gi_status: "quoted",
      lead_source: "Repeat client", assigned_to: "p2",
      created_at: iso(shift(-58)), updated_at: iso(shift(-4))
    });
    mkCase({
      client_id: pollard, case_kind: "buy_to_let", stage: "enquiry",
      property_address: "148 Ashley Road, Parkstone, Poole BH14 9BY",
      lender: null, loan_amount: 132000, property_value: 185000, term_years: 20,
      protection_status: "discussed", gi_status: "not_discussed",
      lead_source: "Repeat client", assigned_to: "p2",
      created_at: iso(shift(-9)), updated_at: iso(shift(-9))
    });

    /* LANDMINE — the PREVIOUS owner of 9 Bryanstone Road (Kwame Boateng, whose
       purchase completed there earlier in the year and who has since sold it on
       to Gareth). The SAME address string therefore sits on two unrelated
       clients' cases. Nothing may read that as one property-owner relationship,
       as a duplicate client, or as one case superseding the other. */
    var priorOwner = completedCases[completedCases.length - 1];
    priorOwner.property_address = "9 Bryanstone Road, Bournemouth BH3 7JQ";

    /* ---- (b) home + one buy-to-let ---------------------------------------- */
    var underhill = newClient("Melanie", "Underhill", "melanie.underhill@example.com", "07700 900142", 44,
      "22 Ravenscourt Road, Southbourne, Bournemouth BH6 3NG", 620);
    var underhillHome = mkCase({
      client_id: underhill, case_kind: "remortgage", stage: "completed",
      property_address: "22 Ravenscourt Road, Southbourne, Bournemouth BH6 3NG",
      lender: "Nationwide", product_name: "5yr Fixed 80%",
      loan_amount: 218000, property_value: 340000, rate_percent: 4.29, term_years: 24,
      rate_end_date: inMonths(46, 19), rate_end_estimated: false,
      submitted_at: dateOnly(on(PY, 3, 28)),
      proc_fee: 1420, broker_fee: 495, sols_fee: 0, fee_status: "paid",
      fee_requested_at: iso(on(PY, 5, 20)), fee_paid_at: iso(on(PY, 5, 29)),
      protection_status: "policy_taken", protection_commission: 720, gi_status: "not_applicable",
      lead_source: "Google", assigned_to: "p3",
      completed_at: iso(on(PY, 5, 19)),
      created_at: iso(on(PY, 2, 10)), updated_at: iso(on(PY, 5, 29))
    });
    underhillHome.broker_fee_paid_at = underhillHome.fee_paid_at;
    underhillHome.proc_fee_paid_at = underhillHome.fee_paid_at;
    mkCase({
      client_id: underhill, case_kind: "buy_to_let", stage: "application",
      property_address: "Flat 1, 5 Owls Road, Boscombe, Bournemouth BH5 1AF",
      lender: "Skipton", product_name: "5yr Fixed 75%",
      loan_amount: 129000, property_value: 176000, rate_percent: 5.14, term_years: 25,
      submitted_at: dateOnly(shift(-26)),
      proc_fee: 968, broker_fee: 495, sols_fee: 0, fee_status: "not_requested",
      protection_status: "discussed", gi_status: "quoted",
      lead_source: "Repeat client", assigned_to: "p3",
      created_at: iso(shift(-49)), updated_at: iso(shift(-5))
    });

    /* ---- (d) a joint-name client with two properties ---------------------- */
    var fairweather = newClient("Ian & Susan", "Fairweather", "fairweathers@example.com", "07700 900143", 52,
      "3 Sandown Road, Christchurch BH23 2LW", 480);
    mkCase({
      client_id: fairweather, case_kind: "remortgage", stage: "decision_in_principle",
      property_address: "3 Sandown Road, Christchurch BH23 2LW",
      lender: "Coventry Building Society", product_name: "5yr Fixed 70%",
      loan_amount: 187000, property_value: 315000, rate_percent: 4.39, term_years: 19,
      rate_end_date: inMonths(9, 30), rate_end_estimated: true,
      proc_fee: 1310, broker_fee: 495, sols_fee: 0, fee_status: "not_requested",
      protection_status: "discussed", gi_status: "not_applicable",
      lead_source: "Referral", assigned_to: "p3",
      created_at: iso(shift(-21)), updated_at: iso(shift(-3))
    });
    mkCase({
      client_id: fairweather, case_kind: "buy_to_let", stage: "offer",
      property_address: "Flat 9, Belvedere Court, 41 West Cliff Road, Bournemouth BH2 5EX",
      lender: "Leeds Building Society", product_name: "2yr Fixed 75%",
      loan_amount: 141000, property_value: 199000, rate_percent: 5.29, term_years: 21,
      submitted_at: dateOnly(shift(-29)), offer_expiry_date: dateOnly(shift(58)),
      expected_completion_date: dateOnly(shift(19)),
      proc_fee: 1058, broker_fee: 495, sols_fee: 250, fee_status: "not_requested",
      protection_status: "quoted", gi_status: "quoted",
      lead_source: "Referral", assigned_to: "p3",
      created_at: iso(shift(-52)), updated_at: iso(shift(-2))
    });

    /* ---- (c) addresses for the cases that already exist -------------------
       Ruby's six live cases become six cases across FIVE properties: the
       buy-to-let application on 8 Grand Avenue and the remortgage decision in
       principle that followed it a fortnight later are the same flat. */
    var RUBY_PROPERTIES = [
      "16 Kimberley Road, Southbourne, Bournemouth BH6 5DL",            /* enquiry          */
      "Flat 2, 118 Poole Road, Westbourne, Bournemouth BH4 9EF",        /* fact find        */
      "8 Grand Avenue, Southbourne, Bournemouth BH6 3SY",               /* DIP  ─┐ one flat */
      "8 Grand Avenue, Southbourne, Bournemouth BH6 3SY",               /* app  ─┘          */
      "31 Chessel Avenue, Boscombe, Bournemouth BH5 1LQ",               /* offer            */
      "Flat 5, Marlborough Court, 7 Durley Chine Road, Bournemouth BH2 5JS" /* exchange     */
    ];
    DB.cases.filter(function (c) { return c.client_id === RUBY; })
      .forEach(function (c, i) { if (RUBY_PROPERTIES[i]) c.property_address = RUBY_PROPERTIES[i]; });

    /* Duncan's product transfer and remortgage are two cases on his own home —
       the same shape as Ruby's pair, on a residential rather than a rental. */
    DB.cases.filter(function (c) { return c.client_id === CL(1); })
      .forEach(function (c) { c.property_address = "4 Seafield Gardens, Poole BH14 8EQ"; });
  })();

  /* =========================================================================
     ROUND 8 — THE CLIENT-TOUCH FIXTURES

     Round 8 asks the book questions it has never been asked: whose birthday is
     it, who completed a year ago today, who have we not actually spoken to
     since last winter, and who is waiting behind today's five review requests.
     Every one of those has a right answer only if the fixtures contain the
     shape being asked about, so each block below exists for one question:

       (a) BIRTHDAYS — one client whose birthday is TODAY and one whose birthday
           is TOMORROW, so "today's birthdays" is provably not "every client
           with a DOB", and the day boundary is a fixture rather than something
           a test has to manufacture. (Whose DOB is missing entirely is decided
           up in CLIENT_SEED — see HAS_DOB.)
       (b) ANNUAL REVIEW — completions on today's MM-DD exactly 12 and 24 months
           back (both must fire), and one 11 months back (must not: it is not
           its anniversary today). The 24-month case also carries LAST year's
           annual-review call task, dated 12 months ago, which is OUTSIDE the
           11-month idempotency look-back and therefore must not suppress this
           year's call — the boundary that decides whether the touch is annual
           or one-off.
       (c) SEGMENT MEMBERS — a client with no case at all, two clients whose
           last real contact is 8 and 14 months old, and one at 5 months who
           must NOT read as cold. Note the 8-month one's CASE was updated three
           weeks ago: a case moving through the pipeline is not the same thing
           as the client hearing from us, and that is precisely the distinction
           the segment exists to draw.
       (d) REVIEW DRIP — the eligible backlog is trimmed to 8, which is bigger
           than one run's cap of 5 and small enough to drain in two runs. Both
           halves matter: 8 > 5 makes the cap observable, and draining in two
           runs keeps the Emails page's "queue is empty" state reachable.

     Placement: after the multi-property block (so nothing above is renumbered)
     and before the case_events / audit seeds (so the new cases still get a
     stage history and a change log).
     ======================================================================= */
  (function roundEightFixtures() {
    var noonOn = function (y, m, d) { return new Date(y, m, d, 12, 0, 0); };
    /* The same calendar day, n whole years back: the MM-DD match production's
       annual-review touch does. (29 February is the one day of the year that
       has no anniversary in a non-leap year; JS rolls it to 1 March here and
       the touch simply finds nothing that day, which is what the SQL does too.) */
    var yearsAgoToday = function (n) { return noonOn(NOW.getFullYear() - n, NOW.getMonth(), NOW.getDate()); };
    var monthsAgo = function (n) { return noonOn(NOW.getFullYear(), NOW.getMonth() - n, NOW.getDate()); };
    var addClient = function (o) {
      var c = {
        id: nid("cl"), first_name: o.first, last_name: o.last, email: o.email, phone: o.phone,
        date_of_birth: o.dob || null, address: o.address, notes: null,
        sms_opt_out: false, marketing_opt_out: false,
        is_vulnerable: false, vulnerability_note: null, suppress_automation: false,
        created_at: iso(o.created), updated_at: iso(o.updated || o.created)
      };
      DB.clients.push(c);
      return c.id;
    };
    var addNote = function (caseId, body, when, by) {
      DB.case_notes.push({ id: nid("nt"), case_id: caseId, body: body, created_by: by || null, created_at: iso(when) });
    };

    /* ---- (a) birthdays --------------------------------------------------- */
    /* Ruby Sinclair's birthday is today, Duncan Armitage's is tomorrow. Their
       ages are left exactly as CLIENT_SEED set them — only the day moves, so
       nothing that reads an age changes. */
    var bdayFor = function (client, when) {
      if (!client || !client.date_of_birth) return;
      client.date_of_birth = dateOnly(new Date(Number(String(client.date_of_birth).slice(0, 4)), when.getMonth(), when.getDate()));
    };
    bdayFor(DB.clients[0], NOW);
    bdayFor(DB.clients[1], shift(1));

    /* FIXED dates of birth for the seven clients tests/fixtures/revolution_sample.csv
       is written against. Everything else in these fixtures is generated relative
       to "now", which is right — but a CSV file on disk cannot chase a moving
       date, and "the import matched this client on name + DOB" is exactly the
       assertion a moving DOB would quietly turn into "the import matched on name
       alone". These seven therefore carry absolute dates, and the sample file
       carries the same seven. (A real person's DOB does not move either; only
       their age does, which is the point.) */
    var FIXED_DOB = {
      "James Whitfield": "1990-03-14",
      "Priya Nadkarni": "1992-11-02",
      "Sarah Ellingham": "1981-06-27",
      "Owen Cadwallader": "1970-09-09",
      "Nadia Hussain": "1989-01-21",
      "Callum Brodie": "1997-12-05",
      "Nigel Trewin": "1967-04-30"
    };
    DB.clients.forEach(function (c) {
      var k = [c.first_name, c.last_name].filter(Boolean).join(" ");
      if (FIXED_DOB[k]) c.date_of_birth = FIXED_DOB[k];
    });

    /* ---- (b) annual-review fodder ---------------------------------------- */
    /* Three completions with addresses, so the call task can name the property
       the review is about. Rate ends are all well outside the 6-month reminder
       window: this block must add annual-review fodder and nothing else — no
       retention successors, no rate-end alerts. */
    var reviewFodder = [
      {
        first: "Nathaniel", last: "Fearnley", email: "nathaniel.fearnley@example.com", phone: "07700 900151",
        age: 47, home: "26 Talbot Avenue, Bournemouth BH3 7HU",
        property: "26 Talbot Avenue, Bournemouth BH3 7HU",
        completed: yearsAgoToday(1), subDays: 61, rateEndMonths: 14, adv: "p2",
        lender: "Coventry Building Society", loan: 204000, value: 312000, proc: 1465, broker: 495
      },
      {
        first: "Marguerite", last: "Vasey", email: "marguerite.vasey@example.com", phone: "07700 900152",
        age: 61, home: "4 Beaufort Road, Southbourne, Bournemouth BH6 5AJ",
        property: "Flat 2, 11 Wharncliffe Road, Boscombe, Bournemouth BH5 1AH",
        completed: yearsAgoToday(2), subDays: 61, rateEndMonths: 20, adv: "p3",
        lender: "Skipton", loan: 143000, value: 198000, proc: 1080, broker: 595
      },
      {
        /* the control: eleven months old, so today is NOT its anniversary */
        first: "Douglas", last: "Hearn", email: "douglas.hearn@example.com", phone: "07700 900153",
        age: 39, home: "17 Draycott Road, Bournemouth BH10 5EN",
        property: "17 Draycott Road, Bournemouth BH10 5EN",
        completed: monthsAgo(11), subDays: 62, rateEndMonths: 8, adv: "p2",
        lender: "Nationwide", loan: 176000, value: 265000, proc: 1310, broker: 0
      }
    ];
    reviewFodder.forEach(function (f, i) {
      var comp = f.completed;
      var cid = addClient({
        first: f.first, last: f.last, email: f.email, phone: f.phone,
        /* one of the three has no DOB on file — the annual review call is the
           moment an adviser would notice and fill it in */
        dob: i === 2 ? null : dateOnly(noonOn(NOW.getFullYear() - f.age, (i * 5 + 2) % 12, 9 + i * 4)),
        address: f.home,
        created: noonOn(comp.getFullYear(), comp.getMonth() - 5, Math.min(28, comp.getDate())),
        updated: comp
      });
      var c = mkCase({
        client_id: cid, case_kind: i === 1 ? "buy_to_let" : "remortgage", stage: "completed",
        property_address: f.property,
        lender: f.lender, product_name: "5yr Fixed 75%",
        loan_amount: f.loan, property_value: f.value, rate_percent: 4.64, term_years: 24,
        rate_end_date: dateOnly(noonOn(NOW.getFullYear(), NOW.getMonth() + f.rateEndMonths, 18)),
        rate_end_estimated: false,
        /* A fixed day count, not "2 calendar months before" — these three feed
           the conveyancer-speed report (any completed, non-product-transfer
           case with both dates counts) as well as the annual-review fodder
           they were built for, and "2 months" measured in calendar months
           wobbles by a day or two depending which two months it lands on,
           which in turn nudges which third a firm's average falls in every
           time the fixture "now" crosses a month boundary. subDays is that
           wobble pinned to today's value so the gap is exact regardless of
           what real date the fixtures load on. */
        submitted_at: dateOnly(shift(-f.subDays, comp)),
        proc_fee: f.proc, broker_fee: f.broker, sols_fee: 0,
        fee_status: "paid",
        fee_requested_at: iso(comp), fee_paid_at: iso(comp),
        protection_status: i === 1 ? "policy_taken" : "declined",
        protection_commission: i === 1 ? 690 : null,
        gi_status: "not_applicable",
        lead_source: i === 1 ? "Referral" : "Google",
        assigned_to: f.adv,
        completed_at: iso(comp),
        created_at: iso(noonOn(comp.getFullYear(), comp.getMonth() - 5, Math.min(28, comp.getDate()))),
        updated_at: iso(comp)
      });
      c.broker_fee_paid_at = f.broker > 0 ? iso(comp) : null;
      c.proc_fee_paid_at = f.proc > 0 ? iso(comp) : null;
      /* the review request went out a fortnight after completion, years ago —
         these are annual-review fodder, not review-drip fodder */
      c.review_requested_at = iso(new Date(comp.getTime() + 14 * DAY));
      addNote(c.id, "Call: completion day — keys collected, client delighted.", comp, f.adv);
      if (i === 1) {
        /* LAST year's annual review call on the two-year-old case: created 12
           months ago, i.e. OUTSIDE the 11-month idempotency window, so this
           year's call must still be written. */
        DB.case_tasks.push({
          id: nid("tk"), case_id: c.id,
          title: "Annual review call — " + f.first + " " + f.last + " (completed " +
            ukDate(dateOnly(comp)) + ", on " + firstAddrLine(f.property) + ")",
          due_date: dateOnly(yearsAgoToday(1)), done_at: iso(yearsAgoToday(1)),
          created_by: null, assigned_to: f.adv, created_at: iso(yearsAgoToday(1))
        });
        addNote(c.id, "Call: annual review — happy on the current rate, nothing to do until the fix ends.", yearsAgoToday(1), f.adv);
      }
    });

    /* ---- (c) segment members --------------------------------------------- */
    /* A client with NO case at all. The "No live case" segment says "or they
       have no case at all" and until now nothing in the book was in that state,
       so the words were untested. An enquiry that never became a case is the
       ordinary way it happens. */
    addClient({
      first: "Petra", last: "Winsloe", email: "petra.winsloe@example.com", phone: "07700 900154",
      dob: null, address: "9 Portman Crescent, Bournemouth BH5 2AR",
      created: shift(-210), updated: shift(-210)
    });

    /* Cold: last real contact 14 months ago. The case completed long before
       that and nothing has been said since. */
    var northcote = addClient({
      first: "Alfred", last: "Northcote", email: "alfred.northcote@example.com", phone: "07700 900155",
      dob: dateOnly(noonOn(NOW.getFullYear() - 68, 10, 3)),
      address: "31 Gloucester Road, Boscombe, Bournemouth BH7 6JB",
      created: monthsAgo(30), updated: monthsAgo(14)
    });
    /* submitted_at below is a FIXED day count before completion, not
       monthsAgo(21) — this case also feeds the conveyancer-speed report
       (any completed, non-product-transfer case with both dates counts), and
       two independent monthsAgo() calls wobble against each other by a day
       or two depending which two calendar months separate them, nudging
       which third a firm's average falls in as the fixture "now" crosses a
       month boundary. 61 is today's gap, pinned — see reviewFodder's
       subDays for the same fix. */
    var northcoteCompleted = monthsAgo(19);
    var northcoteCase = mkCase({
      client_id: northcote, case_kind: "remortgage", stage: "completed",
      property_address: "31 Gloucester Road, Boscombe, Bournemouth BH7 6JB",
      lender: "Leeds Building Society", product_name: "5yr Fixed 80%",
      loan_amount: 158000, property_value: 219000, rate_percent: 4.44, term_years: 17,
      rate_end_date: dateOnly(noonOn(NOW.getFullYear() + 2, 4, 22)), rate_end_estimated: false,
      submitted_at: dateOnly(shift(-61, northcoteCompleted)),
      proc_fee: 1185, broker_fee: 395, sols_fee: 0, fee_status: "paid",
      fee_requested_at: iso(northcoteCompleted), fee_paid_at: iso(northcoteCompleted),
      protection_status: "declined", gi_status: "not_applicable",
      lead_source: "Referral", assigned_to: "p3",
      completed_at: iso(northcoteCompleted),
      created_at: iso(monthsAgo(24)), updated_at: iso(northcoteCompleted)
    });
    northcoteCase.broker_fee_paid_at = northcoteCase.fee_paid_at;
    northcoteCase.proc_fee_paid_at = northcoteCase.fee_paid_at;
    northcoteCase.review_requested_at = iso(monthsAgo(18));
    addNote(northcoteCase.id, "Call: courtesy call after completion — all well.", monthsAgo(14), "p3");

    /* Cold WITH a live case: the case moved three weeks ago (a stage change an
       administrator made), but the last time anyone actually spoke to her was
       eight months back. Case activity is not client contact — this is the
       client the segment is for. Protection is "discussed" with no outcome, so
       she is a member of the no-protection-outcome segment too, and the stage
       (fact find) keeps her out of the protection-gap watchtower rule, which
       only fires at application/offer. */
    var farrant = addClient({
      first: "Suki", last: "Farrant", email: "suki.farrant@example.com", phone: "07700 900156",
      dob: dateOnly(noonOn(NOW.getFullYear() - 36, 6, 28)),
      address: "5 Rothesay Road, Bournemouth BH3 7HA",
      created: monthsAgo(10), updated: shift(-21)
    });
    var farrantCase = mkCase({
      client_id: farrant, case_kind: "remortgage", stage: "fact_find",
      property_address: "5 Rothesay Road, Bournemouth BH3 7HA",
      lender: null, loan_amount: 167000, property_value: 244000, term_years: 22,
      rate_end_date: dateOnly(noonOn(NOW.getFullYear() + 1, 9, 7)), rate_end_estimated: true,
      proc_fee: 1250, broker_fee: 495, sols_fee: 0, fee_status: "not_requested",
      protection_status: "discussed", gi_status: "not_discussed",
      lead_source: "Website", assigned_to: "p3",
      created_at: iso(monthsAgo(10)), updated_at: iso(shift(-21))
    });
    addNote(farrantCase.id, "Call: talked through the options, sending a fact find over.", monthsAgo(8), "p3");

    /* The control the cold segment is measured against: five months, which is
       inside the six-month line and must NOT read as cold. */
    var halloran = addClient({
      first: "Gwen", last: "Halloran", email: "gwen.halloran@example.com", phone: "07700 900157",
      dob: dateOnly(noonOn(NOW.getFullYear() - 52, 1, 14)),
      address: "12 Petersfield Road, Bournemouth BH7 6QL",
      created: monthsAgo(20), updated: monthsAgo(5)
    });
    var halloranCase = mkCase({
      client_id: halloran, case_kind: "product_transfer", stage: "completed",
      property_address: "12 Petersfield Road, Bournemouth BH7 6QL",
      lender: "Halifax", product_name: "2yr Fixed 70%",
      loan_amount: 121000, property_value: 196000, rate_percent: 4.89, term_years: 15,
      /* Deliberately 18 months out, NOT inside the 6-month reminder window: this
         client exists to be the not-quite-cold control, and a rate ending sooner
         would quietly hand queue_automated_emails() a SECOND retention case to
         create on every run. A fixture that changes what another block is
         measuring is worse than no fixture at all. */
      rate_end_date: dateOnly(noonOn(NOW.getFullYear() + 1, 11, 30)), rate_end_estimated: false,
      submitted_at: dateOnly(monthsAgo(9)),
      proc_fee: 605, broker_fee: 0, sols_fee: 0, fee_status: "paid",
      fee_requested_at: iso(monthsAgo(8)), fee_paid_at: iso(monthsAgo(8)),
      protection_status: "policy_taken", protection_commission: 540, gi_status: "not_applicable",
      lead_source: "Repeat client", assigned_to: "p2",
      completed_at: iso(monthsAgo(8)),
      created_at: iso(monthsAgo(11)), updated_at: iso(monthsAgo(5))
    });
    halloranCase.proc_fee_paid_at = halloranCase.fee_paid_at;
    halloranCase.review_requested_at = iso(monthsAgo(7));
    addNote(halloranCase.id, "Call: five-month check-in — rate ends this December, diarised.", monthsAgo(5), "p2");

    /* ---- (d) the review-request drip backlog ------------------------------ */
    /* Eight eligible completions, not nineteen. The cap is 5 a run, so eight
       proves the cap AND drains in two runs — which is what keeps the Emails
       page's "nothing is waiting" state reachable, and keeps the firm-wide
       flush's promise ("N will be sent") true, since a run can never create
       rows behind the confirm it has already shown. Everything older is
       stamped as already asked, on the date it would have gone out. */
    (function reviewDripBacklog() {
      var delay = Number(setting("review_delay_days", "14")) || 14;
      var eligible = DB.cases.filter(function (c) {
        if (c.stage !== "completed" || !c.completed_at || c.review_requested_at) return false;
        if ((NOW - new Date(c.completed_at)) / DAY < delay) return false;
        var cl = DB.clients.filter(function (x) { return x.id === c.client_id; })[0];
        return !!(cl && cl.email && !cl.marketing_opt_out);
      }).sort(function (a, b) { return a.completed_at < b.completed_at ? 1 : -1; });   /* newest first */
      eligible.slice(8).forEach(function (c) {
        c.review_requested_at = iso(new Date(new Date(c.completed_at).getTime() + delay * DAY));
      });
    })();
  })();

  /* =========================================================================
     ROUND 9 — THE DOCUMENT-CHASE AND ADVOCACY FIXTURES

     Round 9 asks the book three questions it has never been asked: what is this
     case actually waiting for, who is slowing our completions down, and who
     sent us this client. Each block below exists for one of them.

     A DELIBERATE CONSTRAINT ON THIS WHOLE PASS: it adds NO clients and NO cases.
     Everything here is written onto rows that already exist. Round 8 learned the
     hard way that a fixture which changes what another block is measuring is
     worse than no fixture at all, and every new completed case is a new member
     of the review drip, a new row in every month's completions, and possibly a
     new watchtower alert. The new COLUMNS are invisible to all of that, so
     writing them onto the existing book costs nothing and keeps every count in
     the battery where round 8 left it. The only rows added anywhere are
     case_documents (a brand-new table), the document emails those checklists
     imply, and the one note-and-task pair that a detractor's review left behind.

       (a) CHECKLISTS — four cases, one per state the chase can be in:
             · part-received, and mailed yesterday   → nothing due (the control)
             · three outstanding, two chases already → the third is due tonight
             · three chases already spent            → a task, not a fourth email
             · everything in                         → nothing due, ever again
           Sixty-five other cases have NO checklist at all, which is the legacy
           majority the checklist-aware template has to keep sending the old
           firm-wide list to.
       (b) SOLICITORS AND WAITING-ON — three firms across the completed book,
           assigned so that each one's average submission-to-completion time is
           genuinely different, and a waiting_on value on the live cases that are
           stuck. Note what waiting_on is NOT: it is not the stage. A case can
           sit at Application for a month waiting on the CLIENT, and the report
           that matters is "who do I have to ring", not "what stage is it".
       (c) ADVOCACY — referrer attribution on three cases (one client having
           sent two of them), a review request that went out eight days ago and
           was never answered, a detractor who told us why, a promoter, and
           enough scores overall to draw a distribution rather than a number.

     Placement: after the round-8 block (so nothing above is renumbered) and
     before the case_events / audit seeds (so anything new still gets a history).
     ======================================================================= */
  (function roundNineFixtures() {
    var nameOf = function (cid) {
      var c = DB.clients.filter(function (x) { return x.id === cid; })[0];
      return c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "";
    };
    /* Cases are chosen BY CLIENT NAME AND STAGE, never by id: ids renumber the
       moment anything above this block seeds one more row, and a fixture that
       silently lands on a different case is the worst kind of harness bug. */
    var caseFor = function (client, stage) {
      return DB.cases.filter(function (c) {
        return nameOf(c.client_id) === client && (!stage || c.stage === stage);
      })[0] || null;
    };
    var clientNamed = function (n) {
      return DB.clients.filter(function (c) { return [c.first_name, c.last_name].filter(Boolean).join(" ") === n; })[0] || null;
    };
    var addNote = function (caseId, body, whenDaysAgo, by) {
      DB.case_notes.push({ id: nid("nt"), case_id: caseId, body: body, created_by: by || null, created_at: iso(shift(-whenDaysAgo)) });
    };
    /* A document mail that has already gone out. Status "sent" on purpose: a
       queued row has not reached the client, so it must not count as a chase and
       must not count as contact. */
    var sentMail = function (cs, type, daysAgo, subject) {
      var cl = DB.clients.filter(function (x) { return x.id === cs.client_id; })[0] || {};
      DB.email_queue.push({
        id: nid("eq"), case_id: cs.id, client_id: cs.client_id, email_type: type,
        to_email: cl.email || "", subject: subject,
        status: "sent", error: null,
        sent_at: iso(shift(-daysAgo)), scheduled_for: iso(shift(-daysAgo)), created_at: iso(shift(-daysAgo))
      });
    };
    var addDoc = function (cs, item, o) {
      var opts = o || {};
      var reqDays = opts.requestedDaysAgo == null ? 14 : opts.requestedDaysAgo;
      DB.case_documents.push({
        id: nid("cd"), case_id: cs.id, item: item,
        status: opts.status || "requested",
        requested_at: iso(shift(-reqDays)),
        received_at: opts.receivedDaysAgo == null ? null : iso(shift(-opts.receivedDaysAgo)),
        note: opts.note || null,
        storage_path: opts.storage_path || null,
        created_at: iso(shift(-reqDays))
      });
    };
    /* R12a·D8 — a document received THROUGH THE UPLOAD LINK gets a real entry in
       `storageFiles` behind its storage_path, the same shape `storage.upload()`
       writes for a genuine file (size/type/at) — so the admin "open" link's
       createSignedUrl exercises a file that is actually there. A document
       received by some other route (email, phone, handed over at a meeting) has
       no storage_path at all — that is the field the app uses to decide whether
       an "open" link renders, not the status, and at least one fixture row below
       is deliberately left that way (see "received by EMAIL" below). */
    /* R13 · BUCKET CORRECTION — the bucket is "client-docs" in production, not
       "case-documents". `case_documents.storage_path` is written WITH the
       bucket prefix on it (that's the real contract — see the file banner),
       so `seedDocFile` now returns the PREFIXED value for the fixture row
       while `storageFiles` keeps keying "<bucket>/<path-in-bucket>" exactly
       as `storage.from(bucket)` below writes it — the two agree because
       DOC_STORAGE_BUCKET + "/" + path === the prefixed value returned.
       DOC_STORAGE_BUCKET itself is declared at module scope now (search
       "storage object registry" near the top of this file) — the doc-upload
       handler needs to reach the exact same constant. */
    var seedDocFile = function (path, sizeBytes) {
      storageFiles[DOC_STORAGE_BUCKET + "/" + path] = { size: sizeBytes || 84213, type: "application/pdf", at: iso(shift(-7)) };
      return DOC_STORAGE_BUCKET + "/" + path;
    };

    /* ---- (a) the four checklists ----------------------------------------- */
    /* The items are the firm's own docs_list, verbatim. A checklist is created
       FROM that list, so the two agreeing is not a coincidence to be tested
       around — it is how the feature works. */
    var DOCS = String(setting("docs_list", "")).split("|").map(function (s) { return s.trim(); }).filter(Boolean);
    var D_ID = DOCS[0] || "Photo ID";
    var D_PAY = DOCS[1] || "Last 3 payslips";
    var D_BANK = DOCS[2] || "Last 3 months bank statements";
    var D_DEP = DOCS[3] || "Proof of deposit";

    /* A1 · PART-RECEIVED, RECENTLY MAILED — Sarah Ellingham, at Fact Find.
       Four items, two of them in (both through the link, which is why the case
       carries the two notes the upload function writes), and a docs_request that
       went out YESTERDAY. This is the control the quiet window exists for: there
       are outstanding items and no chase has ever been sent, and still nothing
       may go tonight, because we spoke to her yesterday. */
    var partial = caseFor("Sarah Ellingham", "fact_find");
    if (partial) {
      partial.doc_token = "doc-ellingham-4f21c8";
      partial.waiting_on = "client";
      addDoc(partial, D_ID, { requestedDaysAgo: 9, status: "received", receivedDaysAgo: 7, storage_path: seedDocFile("docs/" + partial.id + "/photo-id.pdf") });
      addDoc(partial, D_PAY, { requestedDaysAgo: 9, status: "received", receivedDaysAgo: 6, storage_path: seedDocFile("docs/" + partial.id + "/payslips.pdf") });
      addDoc(partial, D_BANK, { requestedDaysAgo: 9 });
      addDoc(partial, D_DEP, { requestedDaysAgo: 9 });
      addNote(partial.id, "Document received via upload link: " + D_ID, 7, null);
      addNote(partial.id, "Document received via upload link: " + D_PAY, 6, null);
      sentMail(partial, "docs_request", 1, "Your document checklist");
    }

    /* A2 · THE THIRD CHASE IS DUE — Bethany Quirke, at Application.
       Three items, none of them in, an original request twelve days ago and two
       chases since. The last of them was four days ago, so the quiet window
       (three days) has passed and tonight's run must send the third — and the
       third is the LAST. */
    var chaseDue = caseFor("Bethany Quirke", "application");
    if (chaseDue) {
      chaseDue.doc_token = "doc-quirke-90b7ae";
      chaseDue.waiting_on = "client";
      [D_ID, D_BANK, D_DEP].forEach(function (item) { addDoc(chaseDue, item, { requestedDaysAgo: 12 }); });
      sentMail(chaseDue, "docs_request", 12, "Your document checklist");
      sentMail(chaseDue, "docs_chase", 8, "Still waiting on your documents");
      sentMail(chaseDue, "docs_chase", 4, "Still waiting on your documents");
    }

    /* A3 · CHASES EXHAUSTED — Rosalind Amery, at Application.
       Three chases spent over a month and nothing has arrived. The next run must
       write the adviser a call task instead of a fourth email. Deliberately the
       one checklist case with NO doc_token: the upload link is not the point of
       the feature, chasing is, and the mails on this case therefore prove the
       checklist-aware template still lists the missing items when there is no
       link to offer. One item is WAIVED — she is not on payslips, she is self
       employed — which is why "three outstanding" and "four items" are both
       true here, and why anything counting outstanding work must count status,
       not rows. */
    var exhausted = caseFor("Rosalind Amery", "application");
    if (exhausted) {
      exhausted.waiting_on = "client";
      [D_ID, D_BANK, D_DEP].forEach(function (item) { addDoc(exhausted, item, { requestedDaysAgo: 34 }); });
      addDoc(exhausted, D_PAY, {
        requestedDaysAgo: 34, status: "waived",
        note: "Self-employed — SA302s and tax year overviews requested instead."
      });
      sentMail(exhausted, "docs_request", 34, "Your document checklist");
      sentMail(exhausted, "docs_chase", 22, "Still waiting on your documents");
      sentMail(exhausted, "docs_chase", 15, "Still waiting on your documents");
      sentMail(exhausted, "docs_chase", 8, "Still waiting on your documents");
    }

    /* A4 · EVERYTHING IN — Tanya Osei, at Fact Find. The clean state: a
       checklist with nothing outstanding, so no chase may ever fire on it and
       the upload page has nothing left to ask for. It keeps its token, because a
       client who opens yesterday's link after sending everything must get a page
       that says so rather than a 404.
       R12a·D8 — not every "received" item arrived through the link: the first two
       (Photo ID, payslips) came back that way and carry a real seeded file, but
       the bank statements arrived by EMAIL — received is a decision a member of
       staff records with the ✓ Received button regardless of how the file turned
       up, and storage_path is null on that row on purpose. The admin "open" link
       must render for the first two and must NOT render for the third — this is
       the one field that tells the two apart, not the status. */
    var clean = caseFor("Tanya Osei", "fact_find");
    if (clean) {
      clean.doc_token = "doc-osei-2d64f0";
      [D_ID, D_PAY].forEach(function (item, i) {
        addDoc(clean, item, { requestedDaysAgo: 20, status: "received", receivedDaysAgo: 17 - i * 2, storage_path: seedDocFile("docs/" + clean.id + "/" + (i + 1) + ".pdf") });
      });
      addDoc(clean, D_BANK, {
        requestedDaysAgo: 20, status: "received", receivedDaysAgo: 13,
        note: "Received by email — client couldn't get the upload link to work on her phone."
      });
      sentMail(clean, "docs_request", 20, "Your document checklist");
    }

    /* ---- (b) solicitors, and what each live case is waiting on ------------ */
    /* Three firms, and they are not interchangeable: the whole point of putting
       the name on the case is that after a year the firm can say which
       conveyancer costs it weeks. The assignment below is by MEASURED duration
       (submission → completion) on the cases that already exist, fastest third
       to Harker & Bligh and slowest to Bexley Rowe, so an average-days-by-
       solicitor report has three genuinely different answers to give. Doing it
       the other way round — naming firms at random and then moving the dates —
       would have rewritten completion dates that a dozen other fixtures and
       reports depend on. */
    var SOLICITORS = ["Harker & Bligh LLP", "Trelawny Conveyancing", "Bexley Rowe Solicitors"];
    (function seedSolicitors() {
      /* A product transfer has no solicitor — nothing changes hands — so those
         are left blank on purpose, along with everything that never completed.
         "Blank" here means "there was no conveyancer", not "we forgot". */
      var withDuration = DB.cases.filter(function (c) {
        return c.stage === "completed" && c.completed_at && c.submitted_at && c.case_kind !== "product_transfer";
      }).map(function (c) {
        return { c: c, days: Math.round((new Date(c.completed_at) - new Date(c.submitted_at)) / DAY) };
      }).filter(function (x) { return x.days > 0; })
        .sort(function (a, b) { return a.days - b.days || (a.c.id < b.c.id ? -1 : 1); });
      var third = Math.ceil(withDuration.length / 3);
      withDuration.forEach(function (x, i) {
        x.c.solicitor_firm = SOLICITORS[Math.min(2, Math.floor(i / third))];
      });
    })();

    /* WAITING ON. Only live cases, and only from Application onwards — before
       that there is nothing outside the office to wait for. The value cycles so
       all three appear, and every case that says it is waiting on a solicitor is
       given the solicitor it is waiting on: a "waiting on solicitor" report whose
       rows cannot name the solicitor is a list of shrugs. */
    (function seedWaitingOn() {
      var order = ["client", "lender", "solicitor"];
      var live = DB.cases.filter(function (c) {
        return ["application", "offer", "exchange"].indexOf(c.stage) >= 0;
      });
      live.forEach(function (c, i) {
        if (c.waiting_on) return;                       /* the checklist cases already said "client" */
        c.waiting_on = order[i % order.length];
        if (c.waiting_on === "solicitor" && !c.solicitor_firm) {
          c.solicitor_firm = SOLICITORS[i % SOLICITORS.length];
        }
      });
      /* And the ones that are genuinely STUCK — nothing has moved on them in
         over six weeks — get the value spelled out even where the cycle above
         did not reach them, because these are the rows the report exists for. */
      DB.cases.filter(function (c) {
        return isLive(c.stage) && (NOW - new Date(c.updated_at)) / DAY > 45 && !c.waiting_on;
      }).forEach(function (c, i) {
        c.waiting_on = order[(i + 2) % order.length];
        if (c.waiting_on === "solicitor" && !c.solicitor_firm) c.solicitor_firm = SOLICITORS[(i + 1) % SOLICITORS.length];
      });
    })();

    /* ---- (c) advocacy ----------------------------------------------------- */
    /* WHO SENT US THIS CLIENT. Three cases, two referrers, and the two of them
       are deliberately different shapes, because app.js has to decide WHERE the
       thank-you task goes:
         · Meera Chandran has exactly ONE case, so a thank-you lands on it with
           nothing to decide. She has referred TWO clients, which is what makes a
           "who refers us business" list have a top row at all.
         · Gareth Pollard is the landlord with five cases, three of them live.
           There is no right answer to "which of his six buy-to-lets does this
           thank-you belong on", so the app must decline to guess — and that path
           needs a fixture or it is never walked. */
    (function seedReferrers() {
      var meera = clientNamed("Meera Chandran");
      var pollard = clientNamed("Gareth Pollard");
      var pairs = [
        [caseFor("Amara Okonkwo", "offer"), meera],
        [caseFor("Ian & Susan Fairweather", "offer"), meera],
        [caseFor("Ross McKay", "fact_find"), pollard]
      ];
      pairs.forEach(function (p) {
        if (!p[0] || !p[1]) return;
        p[0].referrer_client_id = p[1].id;
        if (!p[0].lead_source) p[0].lead_source = "Referral";
      });
    })();

    /* THE REVIEW LOOP. Three states, because the reminder only means anything if
       all three exist side by side:
         · asked eight days ago, never answered      → the reminder is due
         · answered badly, with a reason             → note + call task
         · answered well                             → nothing happens at all
       The unanswered one carries a SENT email as well as the stamp on the case:
       the stamp records that we decided to ask, the sent row records that the
       client was actually asked, and the reminder is keyed on the second. */
    (function seedReviewLoop() {
      /* Their first completion that has been ASKED and not yet scored — the same
         rule for all three, so none of these lands on a case that already
         carries somebody else's answer. */
      var askedUnscored = function (client) {
        return DB.cases.filter(function (x) {
          return nameOf(x.client_id) === client && x.stage === "completed" &&
            x.nps_score == null && !!x.review_requested_at;
        })[0] || null;
      };
      var unanswered = askedUnscored("Sophie Ravenhill");
      if (unanswered) {
        unanswered.review_requested_at = iso(shift(-8));
        unanswered.nps_score = null;
        sentMail(unanswered, "review_request", 8, "How did we do?");
      }

      /* The detractor, exactly as nps-capture v2 leaves a case: the score on the
         case, the client's own words in a note, and a call task on the case's
         adviser due tomorrow. Written here rather than by calling the edge
         function so the state exists on a cold page load — the Reports review
         panel and the adviser's task list both have to show it before anybody
         submits anything. */
      var detractor = askedUnscored("Ian Corrigan");
      if (detractor) {
        var reason = "Took nearly three weeks to get an answer on the valuation and I had to chase every time.";
        detractor.nps_score = 4;
        DB.case_notes.push({
          id: nid("nt"), case_id: detractor.id,
          body: "Review feedback (4/10): " + reason,
          created_by: null, created_at: iso(shift(-2))
        });
        DB.case_tasks.push({
          id: nid("tk"), case_id: detractor.id,
          title: "Call " + nameOf(detractor.client_id) + " — review feedback needs attention",
          due_date: dateOnly(shift(1)), done_at: null,
          created_by: null, assigned_to: detractor.assigned_to || null,
          created_at: iso(shift(-2))
        });
      }

      /* The rest of the distribution. Six cases carried a score before this
         round and every one of them was a 6, an 8 or a 9 — a book with no
         extremes at either end, which is the one shape a review dashboard can
         say nothing useful about. These take it to twelve, spanning 4 to 10,
         with detractors, passives and promoters all represented. Each one is
         written onto a case that had ALREADY been asked (review_requested_at is
         set), so nothing here changes who is waiting in the review drip. */
      [["Damian Fairhurst", 9], ["Fiona Strachan", 7], ["Peter Thackeray", 10],
       ["Bruce Lindquist", 10], ["Kwame Boateng", 10]].forEach(function (p) {
        /* Their first already-asked, not-yet-scored completion — not simply
           their first completion, which for a two-time client can be one that
           already carries a score. */
        var c = DB.cases.filter(function (x) {
          return nameOf(x.client_id) === p[0] && x.stage === "completed" &&
            x.nps_score == null && !!x.review_requested_at;
        })[0];
        if (c) c.nps_score = p[1];
      });
    })();
  })();

  /* =========================================================================
     ROUND 12b FIXTURES — retention call-pack numerics (W-15) + a DIP-stage
     checklist for the widened document chase (W-24).

     Same constraint as the round-9 pass above: no new clients, no new cases.
     Everything here is written onto rows that already exist, so every count
     the rest of the battery depends on (completions per month, the review
     drip, watchtower alerts) is exactly where round 12a left it.
     ======================================================================= */
  (function roundTwelveBFixtures() {
    var nameOf = function (cid) {
      var c = DB.clients.filter(function (x) { return x.id === cid; })[0];
      return c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "";
    };
    var caseFor = function (client, stage) {
      return DB.cases.filter(function (c) {
        return nameOf(c.client_id) === client && (!stage || c.stage === stage);
      })[0] || null;
    };

    /* ---- (a) retention call-pack numerics --------------------------------
       Kwame Boateng and Louise Garnham are the two completed, rate-ended
       cases the Recover — rates that already ended panel shows UNCOVERED
       (rateEndRecoverModel(): completed, rate_end_date in the past, no
       successor case) — see the "already-ended rates" landmine comment on
       the retention window seed above. Real, plausible numbers on both: a
       balance a little under the original loan, a reversion rate in the
       7-8.5% SVR range, and (where seeded) a monthly payment computed off
       that balance/rate on a standard repayment formula, not a guess.
         · Kwame — the fuller of the two: all four columns.
         · Louise — deliberately PARTIAL: a balance and nothing else, so the
           app has to render "balance known, everything else unknown" rather
           than inventing a reversion rate or a zero payment.
       Andrew Pemberton is ALSO a completed, rate-ended case from the same
       cohort, but he already has a retention successor (ca022, the
       retention-loss fixture above) — the COVERED side of the same panel —
       and is left with all four columns NULL on purpose: proof the app must
       render absence, not zero, on a rate-ended case regardless of which
       side of the panel it falls on. */
    var kwame = caseFor("Kwame Boateng", "completed");
    if (kwame) {
      kwame.current_balance = 173200;
      kwame.reversion_rate = 8.09;
      kwame.monthly_payment = 1248;
      kwame.erc_amount = 3200;
    }
    var louise = caseFor("Louise Garnham", "completed");
    if (louise) {
      louise.current_balance = 322000;
      /* reversion_rate / monthly_payment / erc_amount stay null on purpose */
    }
    /* Andrew Pemberton — nothing written; his row keeps the mkCase() default
       of null on all four, which is the point of naming him here. */

    /* Sarah Ellingham's live fact_find case is the "at least one LIVE
       retention-relevant case" — it is r9's retention pair successor
       (retention_source_case_id points at her earlier completed case), and
       her current rate ends inside the next few months, exactly the case an
       adviser would pull a call-pack up for ahead of ringing her. */
    var sarahRetention = DB.cases.filter(function (c) {
      return nameOf(c.client_id) === "Sarah Ellingham" && c.stage === "fact_find" && c.retention_source_case_id;
    })[0];
    if (sarahRetention) {
      sarahRetention.current_balance = 111200;
      sarahRetention.reversion_rate = 7.79;
      sarahRetention.monthly_payment = 898;
      sarahRetention.erc_amount = 2450;
    }

    /* ---- (b) a DIP-stage checklist for the widened document chase --------
       r9's fixture pass hard-seeds four checklist cases and tests/r9_docs.js
       used to lock that count byte-for-byte (`G.checklistCases === 4`) — the
       "fixture shape" assertion the rest of that file's named lookups
       (Ellingham/Quirke/Amery/Osei) depend on. That lock has been loosened to
       `>= 4` (R9-5, tests/r9_docs.js) — it now asserts that those four named
       states exist, not a ceiling on the book — so a fifth checklist case no
       longer trips it, and Ruby Sinclair's decision_in_principle case (see the
       file banner above) can carry one: two items outstanding, none received,
       one request sent, at a stage r9's own fixtures never reached (fact_find
       and application only) — making the W-24 widening (DOC_CHASE_STAGES now
       running enquiry through exchange) independently observable without
       relying on a test moving a case's stage at runtime. doc_chase_enabled
       still seeds OFF, so nothing chases her tonight — a test that wants to
       see it fire has to turn the setting on itself, same as every other
       chase fixture. */
    var rubyDip = caseFor("Ruby Sinclair", "decision_in_principle");
    if (rubyDip) {
      var dipDocs = String(setting("docs_list", "")).split("|").map(function (s) { return s.trim(); }).filter(Boolean);
      var dipD_ID = dipDocs[0] || "Photo ID";
      var dipD_BANK = dipDocs[2] || "Last 3 months bank statements";
      rubyDip.doc_token = "doc-sinclair-7c3a10";
      rubyDip.waiting_on = "client";
      [dipD_ID, dipD_BANK].forEach(function (item) {
        DB.case_documents.push({
          id: nid("cd"), case_id: rubyDip.id, item: item,
          status: "requested",
          requested_at: iso(shift(-6)),
          received_at: null, note: null, storage_path: null,
          created_at: iso(shift(-6))
        });
      });
      var rubyCl = DB.clients.filter(function (x) { return x.id === rubyDip.client_id; })[0] || {};
      DB.email_queue.push({
        id: nid("eq"), case_id: rubyDip.id, client_id: rubyDip.client_id, email_type: "docs_request",
        to_email: rubyCl.email || "", subject: "Your document checklist",
        status: "sent", error: null,
        sent_at: iso(shift(-6)), scheduled_for: iso(shift(-6)), created_at: iso(shift(-6))
      });
    }
  })();

  /* =========================================================================
     ROUND 13 FIXTURES — the four new `cases` columns (policy_start_date /
     exchange_date / offer_issued_date / repayment_method), staff_absences,
     case_files. (Client care columns are seeded in-line on the CLIENT_SEED
     pass above, and the two new settings keys in the SETTINGS_SEED block —
     search "R13" in each.)

     Same constraint as every fixture pass since round 9: no new clients, no
     new cases — everything here is written onto rows that already exist, so
     every count the rest of the battery depends on stays exactly where round
     12b left it.
     ========================================================================= */
  (function roundThirteenFixtures() {
    var nameOf = function (cid) {
      var c = DB.clients.filter(function (x) { return x.id === cid; })[0];
      return c ? [c.first_name, c.last_name].filter(Boolean).join(" ") : "";
    };
    var caseFor = function (client, stage) {
      return DB.cases.filter(function (c) {
        return nameOf(c.client_id) === client && (!stage || c.stage === stage);
      })[0] || null;
    };
    var monthsAgo = function (n) { return dateOnly(new Date(NOW.getFullYear(), NOW.getMonth() - n, NOW.getDate())); };

    /* ---- (a) policy_start_date — two of the three policy_taken/completed
       cases the book already carries (Tom Beresford, Elaine Mowbray, Bruce
       Lindquist — all PROT[idx%5===3] from the completedCases loop). Bruce is
       left untouched on purpose: "most stay null" is the honest state a
       data-quality panel needs something to render against. */
    var tom = caseFor("Tom Beresford", "completed");
    /* inside the 24-month clawback window, ~4 months of it left to run */
    if (tom) tom.policy_start_date = monthsAgo(20);
    var elaine = caseFor("Elaine Mowbray", "completed");
    /* outside the clawback window entirely */
    if (elaine) elaine.policy_start_date = monthsAgo(26);
    /* Bruce Lindquist (policy_taken, completed) — policy_start_date stays
       null: the third policy_taken/completed case, deliberately untouched. */

    /* ---- (b) repayment_method — two completed cases, one of each value,
       from clients otherwise untouched by any earlier fixture pass. */
    var owen = caseFor("Owen Cadwallader", "completed");
    if (owen) owen.repayment_method = "repayment";
    var nadia = caseFor("Nadia Hussain", "completed");
    if (nadia) nadia.repayment_method = "interest_only";

    /* ---- (c) offer_issued_date / exchange_date — one case at each of
       those two live stages. */
    var amara = caseFor("Amara Okonkwo", "offer");
    if (amara) amara.offer_issued_date = dateOnly(shift(-9));
    var harold = caseFor("Harold Mainwaring", "exchange");
    if (harold) harold.exchange_date = dateOnly(shift(-4));

    /* ---- (d) staff_absences — p3 Luke Richards, absent TODAY spanning a
       few fixed days (started yesterday, runs two more), so lead-routing
       exclusion is testable against a stable, non-flaky window. Plus one
       past absence, so the table is not a single-row fixture. Noon-pinned
       per house rules (see shiftNoon() and the R11/R12b flake-fix notes) —
       `created_at` is a timestamp, `starts_on`/`ends_on` are dates and need
       no time component at all. */
    DB.staff_absences.push({
      id: nid("sa"), profile_id: "p3",
      starts_on: dateOnly(shift(-1)), ends_on: dateOnly(shift(2)),
      note: "Annual leave", created_by: "p3", created_at: iso(shiftNoon(-6))
    });
    DB.staff_absences.push({
      id: nid("sa"), profile_id: "p3",
      starts_on: dateOnly(shift(-40)), ends_on: dateOnly(shift(-37)),
      note: "Conference — out of office", created_by: "p4", created_at: iso(shiftNoon(-45))
    });

    /* ---- (e) case_files — 1-2 fixture rows with a real blob behind them,
       mirroring the case_documents pattern (search "R12a·D8 — seed real
       storage content" above): a real `storageFiles` entry keyed
       "client-docs/files/<caseId>/…", the same shape a genuine app upload
       via supabase-js storage.upload() would leave, so createSignedUrl on
       either of these exercises a file that is actually there. */
    var CASE_FILES_BUCKET = "client-docs";
    var seedCaseFile = function (caseId, clientId, name, kind, path, uploadedBy, daysAgo) {
      var full = CASE_FILES_BUCKET + "/files/" + caseId + "/" + path;
      storageFiles[full] = { size: 42117, type: "application/pdf", at: iso(shift(-daysAgo)) };
      DB.case_files.push({
        id: nid("cf"), case_id: caseId, client_id: clientId, name: name, kind: kind,
        storage_path: full, uploaded_by: uploadedBy, created_at: iso(shift(-daysAgo))
      });
    };
    if (tom) seedCaseFile(tom.id, tom.client_id, "Signed mortgage illustration.pdf", "Illustration", "illustration.pdf", "p2", 200);
    if (amara) seedCaseFile(amara.id, amara.client_id, "Offer letter — Amara Okonkwo.pdf", "Offer letter", "offer-letter.pdf", "p3", 9);

    /* ---- (f) three small, deliberate nudges so the new run_watchtower rule
       set (below, search "R13 · FULL-FIDELITY MIRROR") has real fixture
       content to fire on rather than reading zero across the book for a
       brand-new rule — every other row this pass touches was already
       exercising something; these three exist FOR the watchtower mirror:
         · ca031 (Ruby Sinclair, offer stage, protection_status 'quoted') —
           an ad hoc protection_quoted_at 20 days ago, so protection_quote_stale
           has one row on the ">14 days, not yet completed" branch as well as
           the "no date, completed" branch the fixture book already has four
           of.
         · ca058 (Gareth Pollard, one of his three live cases, offer stage) —
           offer_expiry_date pulled in to 10 days away, so offer_stale has a
           CRITICAL row (≤14 days) rather than reading zero across a book
           where every other live offer expires 8+ weeks out.
         · ca061 (application stage) — submitted_at cleared, so
           app_not_submitted has one row rather than reading zero across a
           book where every other application-stage case already has one. */
    var ruby031 = DB.cases.filter(function (c) { return c.id === "ca031"; })[0];
    if (ruby031) ruby031.protection_quoted_at = iso(shift(-20));
    var pollard058 = DB.cases.filter(function (c) { return c.id === "ca058"; })[0];
    if (pollard058) pollard058.offer_expiry_date = dateOnly(shift(10));
    var app061 = DB.cases.filter(function (c) { return c.id === "ca061"; })[0];
    if (app061) app061.submitted_at = null;

    /* ---- (g) R65 — the same treatment for the two new rules (11
       offer_before_completion, 12 erc_before_completion). Adjusted on rows
       that already exist, never added, so no case count anywhere in the
       battery moves (same discipline as the "DELIBERATE DIRT" block above).

       · offer_before_completion needs NO nudge and deliberately gets none.
         ca058 above already carries an offer expiring in 10 days AND an
         expected completion 27 days out, so the offer dies 17 days before the
         completion it is meant to fund — one CRITICAL row, and the only one:
         every other live offer in the book expires AFTER its expected
         completion (ca046 04 Nov / 21 Oct, ca048 04 Nov / 29 Oct, ca063
         23 Oct / 14 Sep), which is the right way round and is what keeps this
         rule at exactly one row rather than lighting up the whole pipeline.
         Asserted in tests/r65_watchtower.js §A, so if a future fixture edit
         moves those dates the suite says so instead of silently drifting.

       · erc_before_completion has nothing to fire on: the mock's four
         retention successors all point at sources with NO erc_end_date, so
         the rule read zero across the book. The FIRST LIVE successor (the
         Sarah Ellingham fact-find that came out of her own completed case)
         gets the pair of dates the rule is about:
           — the SOURCE's ERC is set to run to the very end of its fixed rate,
             which is what a lender's ERC normally does. Deliberately EQUAL to
             rate_end_date, not later, so v_alerts.erc_outlasts_rate (a strict
             `>`) is untouched and no ERC-conflict list anywhere gains a row;
           — the SUCCESSOR is given an expected completion 25 days before that
             date, which is the mistake the rule exists to catch: remortgage
             away 25 days early and the client pays an Early Repayment Charge
             for three and a half weeks of nothing.
         Derived from the source's own date rather than a fixed shift() so the
         gap is exactly 25 days whatever NOW is. */
    var r65Succ = DB.cases.filter(function (c) {
      return c.retention_source_case_id && ["completed", "not_proceeding"].indexOf(c.stage) === -1;
    })[0];
    if (r65Succ) {
      var r65Src = DB.cases.filter(function (c) { return c.id === r65Succ.retention_source_case_id; })[0];
      if (r65Src && r65Src.rate_end_date) {
        r65Src.erc_end_date = r65Src.rate_end_date;
        r65Succ.expected_completion_date = dateOnly(new Date(new Date(r65Src.erc_end_date + "T12:00:00").getTime() - 25 * DAY));
      }
    }
  })();

  /* --- R14b — cases.mortgage_account_number ------------------------------
     Nullable text, no backfill — null on nearly every case, exactly like the
     r13 forward-capture columns above. Two plainly-fake values, chosen on
     stable-named clients: James Whitfield is one of the seven FIXED_DOB
     clients above (always present, with a real loan_amount + lender), which
     is exactly the case tests/r14.js's security-card section already opens
     for its "DOB present" fixture — so this row lights up there rather than
     reading "—" on every run. Owen Cadwallader (also FIXED_DOB, completed,
     already carries a repayment_method from the r13 pass) gets the second
     value for variety, so a card with a number is not a one-off. */
  (function roundFourteenBFixtures() {
    var caseForClientName = function (name, stage) {
      var cl = DB.clients.filter(function (c) { return [c.first_name, c.last_name].filter(Boolean).join(" ") === name; })[0];
      if (!cl) return null;
      return DB.cases.filter(function (c) { return c.client_id === cl.id && (!stage || c.stage === stage); })[0] || null;
    };
    var jw = caseForClientName("James Whitfield");
    if (jw) jw.mortgage_account_number = "MTG-TEST-4471";
    var owen = caseForClientName("Owen Cadwallader", "completed");
    if (owen) owen.mortgage_account_number = "ACC-0099-TEST";
  })();

  /* --- R16 — BTL rental/ICR + submit-to-lender tracker --------------------
     Six new plain nullable columns (monthly_rent, icr_stress_rate,
     icr_required_pct, lender_reference, application_status,
     application_status_at), same no-migration-toggle rule as R14b's
     mortgage_account_number: null on nearly every case, a handful of real
     (fake) values set below on cases that already exist — no new clients, no
     new cases, so no count anywhere else in the battery moves.

     `tests/r16.js` mints its OWN fresh cases for every numbered assertion
     (exact ICR fail/pass/muted/null fixtures, and the chase-nudge boundary),
     the same way tests/r15.js does — see HARNESS.md's per-page-DB note. The
     values set here exist only so a BTL case and a tracked application are
     visibly present on the ordinary fixture book (open Gareth Pollard's
     application-stage BTL case and the block renders with real numbers),
     not because any suite's pass/fail count depends on the exact figures. */
  (function roundSixteenFixtures() {
    var caseForClientKindStage = function (name, kind, stage) {
      var cl = DB.clients.filter(function (c) { return [c.first_name, c.last_name].filter(Boolean).join(" ") === name; })[0];
      if (!cl) return null;
      return DB.cases.filter(function (c) { return c.client_id === cl.id && c.case_kind === kind && c.stage === stage; })[0] || null;
    };
    /* (a) ICR FAIL — Gareth Pollard's application-stage BTL case (loan
       196000, value 268000). rent 1200 -> annualRent 14400, stressInterest
       (default 5.5%) 10780, icrPct round(133.58)=134, needs default 145 -> fail. */
    var pollardApp = caseForClientKindStage("Gareth Pollard", "buy_to_let", "application");
    if (pollardApp) pollardApp.monthly_rent = 1200;
    /* (b) ICR PASS — Gareth Pollard's offer-stage BTL case (loan 154000,
       value 224000). rent 1500 -> annualRent 18000, stressInterest 8470,
       icrPct round(212.5..)=213 >= 145 -> pass. */
    var pollardOffer = caseForClientKindStage("Gareth Pollard", "buy_to_let", "offer");
    if (pollardOffer) pollardOffer.monthly_rent = 1500;
    /* (c) lender tracker, CHASEABLE — Harold Mainwaring's exchange-stage case
       (not BTL — the tracker itself is not kind-gated): status "submitted"
       stamped 15 days ago (>= the 10-day LENDER_CHASE_DAYS window) — the
       header nudge fires. Deliberately NOT Melanie Underhill's application
       case (ca061), which R13's fixture pass already uses for the
       app_not_submitted watchtower rule (submitted_at cleared there) —
       stacking an "in underwriting" status on a case fixtured as "not yet
       submitted" would be confusing to read even though nothing actually
       collides (app_not_submitted never reads application_status). */
    var haroldExchange = caseForClientKindStage("Harold Mainwaring", "first_time_buyer", "exchange");
    if (haroldExchange) {
      haroldExchange.lender_reference = "APP-441829";
      haroldExchange.application_status = "submitted";
      haroldExchange.application_status_at = iso(shift(-15));
    }
    /* (d) lender tracker, NOT chaseable despite being old — the Fairweathers'
       offer-stage BTL case: status "offer_issued" stamped 25 days ago. The
       chase nudge excludes offer_issued regardless of age. */
    var fairweatherOffer = caseForClientKindStage("Ian & Susan Fairweather", "buy_to_let", "offer");
    if (fairweatherOffer) {
      fairweatherOffer.lender_reference = "APP-552013";
      fairweatherOffer.application_status = "offer_issued";
      fairweatherOffer.application_status_at = iso(shift(-25));
    }
  })();

  /* --- vault_entries (R14 — the company password safe) -------------------
     EVERY value below is plainly, deliberately fake — no real lender login,
     no real staff password, ever. sort_order is left at the column default
     (0) for all twelve; nothing in this pass depends on a particular within-
     category order. */
  (function roundFourteenFixtures() {
    var V = function (o) {
      var row = {
        id: nid("ve"), category: o.category, name: o.name,
        owner_label: o.owner_label || null, fields: o.fields || [],
        note: o.note || null, visible_to: o.visible_to || null,
        sort_order: 0, updated_by: o.updated_by || null,
        created_at: iso(shift(o.daysAgo == null ? -180 : -o.daysAgo)),
        updated_at: iso(shift(o.updatedDaysAgo == null ? (o.daysAgo == null ? -180 : -o.daysAgo) : -o.updatedDaysAgo))
      };
      DB.vault_entries.push(row);
      return row;
    };
    var F = function (label, value, secret) { return { label: label, value: value, secret: !!secret }; };

    /* lender — "Test Bank A" held individually by all three advising/owner
       personas, plus a Shared "Test Bank B" (note lives here, exercising the
       note field). Each row mixes a non-secret Username with two secrets
       (Password + a memorable word), so masking is exercised everywhere. */
    V({
      category: "lender", name: "Test Bank A", owner_label: "Daniel",
      fields: [F("Username", "daniel.p", false), F("Password", "test-pass-1", true), F("Memorable word", "bluecar", true)],
      updated_by: "p4", daysAgo: 210
    });
    V({
      category: "lender", name: "Test Bank A", owner_label: "Luke",
      fields: [F("Username", "luke.r", false), F("Password", "test-pass-2", true), F("Memorable word", "redkite", true)],
      updated_by: "p3", daysAgo: 205
    });
    V({
      category: "lender", name: "Test Bank A", owner_label: "Wayne",
      fields: [F("Username", "wayne.k", false), F("Password", "test-pass-3", true), F("Memorable word", "greenfern", true)],
      updated_by: "p2", daysAgo: 200
    });
    V({
      category: "lender", name: "Test Bank B", owner_label: "Shared",
      fields: [F("Username", "team.bankb", false), F("Password", "hunter2", true)],
      note: "Shared desk login — do not change without telling the whole team first.",
      updated_by: "p1", daysAgo: 190
    });
    /* a second Shared lender so the category has more than the one obvious
       pair, and so a search on "Test Bank" without "A"/"B" has three+ hits */
    V({
      category: "lender", name: "Test Building Society", owner_label: "Wayne",
      fields: [F("Username", "wayne.k2", false), F("Password", "test-pass-8", true)],
      updated_by: "p2", daysAgo: 150
    });

    /* protection — agency number (non-secret) + passcode (secret) */
    V({
      category: "protection", name: "Test Protect", owner_label: "Luke",
      fields: [F("Agency number", "AG-10293", false), F("Passcode", "test-pass-4", true)],
      updated_by: "p3", daysAgo: 170
    });

    /* gi (general insurance) — Shared */
    V({
      category: "gi", name: "Test GI", owner_label: "Shared",
      fields: [F("Username", "nexmoney-gi", false), F("Password", "test-pass-5", true)],
      updated_by: "p1", daysAgo: 160
    });

    /* admin — an ordinary Shared row everyone sees, PLUS a gated one
       (visible_to = ['owner']) so the RLS visibility gate has something to
       test: only the owner role sees it, not admin, not adviser. */
    V({
      category: "admin", name: "Test Admin System", owner_label: "Shared",
      fields: [F("Username", "admin@nexmoney.test", false), F("Password", "test-pass-6", true)],
      updated_by: "p1", daysAgo: 140
    });
    V({
      category: "admin", name: "Test Admin Restricted", owner_label: "Shared",
      fields: [F("Username", "root@nexmoney.test", false), F("Password", "test-pass-7", true)],
      visible_to: ["owner"], updated_by: "p4", daysAgo: 130
    });
    V({
      category: "admin", name: "Test Backup Email", owner_label: "Daniel",
      fields: [F("Email", "backup@example.com", false), F("Recovery code", "test-pass-9", true)],
      updated_by: "p4", daysAgo: 100
    });

    /* contact — both fields non-secret on purpose (a BDM's direct line is
       not a credential) */
    V({
      category: "contact", name: "Test BDM", owner_label: "Shared",
      fields: [F("Direct number", "01202 900199", false), F("Email", "bdm@example.com", false)],
      updated_by: "p1", daysAgo: 120
    });

    /* other — a blank secret value: something the team knows it needs to
       fill in but has not yet, exercising the "nothing behind the mask yet"
       state. Also carries a note. */
    V({
      category: "other", name: "Test Office WiFi", owner_label: "Shared",
      fields: [F("Network", "NexMoney-Guest", false), F("Password", "", true)],
      note: "Router reset — password not set yet, ask Daniel.",
      updated_by: "p2", daysAgo: 30
    });
  })();

  /* --- case_events: give the live cases a stage history ------------------ */
  var STAGE_ORDER = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange", "completed"];
  DB.cases.forEach(function (c) {
    var idx = STAGE_ORDER.indexOf(c.stage);
    if (idx <= 0) return;
    var created = new Date(c.created_at).getTime();
    var span = Math.max(DAY, new Date(c.updated_at).getTime() - created);
    for (var s = 1; s <= idx; s++) {
      caseEvent(c.id, "stage_changed", STAGE_ORDER[s - 1] + " → " + STAGE_ORDER[s],
        iso(new Date(created + (span * s) / (idx + 1))), c.assigned_to || "p4");
    }
    if (c.fee_status === "paid") caseEvent(c.id, "fee_status_changed", "requested → paid", c.fee_paid_at || c.updated_at, c.assigned_to || "p4");
    if (c.protection_status === "policy_taken") caseEvent(c.id, "protection_status_changed", "quoted → policy_taken", c.updated_at, c.assigned_to || "p4");
  });

  /* --- audit_log seed rows ---------------------------------------------- */
  (function seedAudit() {
    /* Every case and client carries a history, so the Change history drawer on any
       record opens with real rows rather than an empty state. */
    DB.cases.forEach(function (c, i) {
      auditRow("cases", "insert", c, clone(c), c.created_at, c.assigned_to || "p4");
      if (c.stage !== "enquiry") {
        auditRow("cases", "update", c, { stage: { old: "enquiry", new: c.stage } }, c.updated_at, c.assigned_to || "p4");
      }
      if (i % 3 === 0) {
        auditRow("cases", "update", c, {
          broker_fee: { old: null, new: c.broker_fee },
          assigned_to: { old: null, new: c.assigned_to }
        }, iso(shift(-((i % 25) + 2))), "p1");
      }
      if (i % 4 === 1) {
        auditRow("cases", "update", c, { lender: { old: null, new: c.lender }, rate_percent: { old: null, new: c.rate_percent } }, iso(shift(-((i % 18) + 3))), c.assigned_to || "p2");
      }
    });
    DB.clients.forEach(function (cl, i) {
      auditRow("clients", "insert", cl, clone(cl), cl.created_at, "p1");
      if (i % 2 === 0) auditRow("clients", "update", cl, { phone: { old: null, new: cl.phone } }, cl.updated_at, "p2");
      if (i % 5 === 0) auditRow("clients", "update", cl, { address: { old: null, new: cl.address }, email: { old: null, new: cl.email } }, cl.updated_at, "p4");
    });
    DB.case_tasks.slice(0, 20).forEach(function (t) { auditRow("case_tasks", "insert", t, clone(t), t.created_at, t.created_by); });
    DB.case_notes.slice(0, 20).forEach(function (n) { auditRow("case_notes", "insert", n, clone(n), n.created_at, n.created_by); });
    DB.appointments.slice(0, 10).forEach(function (ap) { auditRow("appointments", "insert", ap, clone(ap), ap.created_at, ap.staff_id); });
    DB.introducers.forEach(function (i2) { auditRow("introducers", "insert", i2, clone(i2), i2.created_at, "p4"); });
    /* R14 — every vault entry gets its creation audited too, exactly like
       every other AUDITED table above; this also exercises maskChanges()'s
       secret-field masking at fixture-load time, not just from a live test
       write. */
    DB.vault_entries.forEach(function (v) { auditRow("vault_entries", "insert", v, clone(v), v.created_at, v.updated_by || "p1"); });
    /* Owner-only rows: settings + profiles (withheld from everyone else on SELECT) */
    ["company_name", "monthly_fee_target", "google_review_link"].forEach(function (key, i) {
      var row = DB.settings.filter(function (s) { return s.key === key; })[0];
      auditRow("settings", "update", row, { value: { old: "", new: row.value } }, iso(shift(-(20 + i))), "p4");
    });
    var bank = DB.settings.filter(function (s) { return s.key === "bank_sort_code"; })[0];
    auditRow("settings", "update", bank, { value: { old: "", new: "" } }, iso(shift(-18)), "p4");
    var cron = DB.settings.filter(function (s) { return s.key === "cron_key"; })[0];
    auditRow("settings", "insert", cron, clone(cron), iso(shift(-40)), "p4");
    auditRow("profiles", "update", DB.profiles[0], { role: { old: "adviser", new: "admin" } }, iso(shift(-35)), "p4");
    auditRow("profiles", "update", DB.profiles[5], { role: { old: "adviser", new: "none" } }, iso(shift(-12)), "p4");
    /* nothing in a forensic log may be dated in the future */
    var nowIso = iso(NOW);
    DB.audit_log.forEach(function (r) { if (r.happened_at > nowIso) r.happened_at = nowIso; });
    DB.audit_log.sort(function (a, b) { return a.happened_at < b.happened_at ? -1 : 1; });
  })();

  /* =========================================================================
     WATCHTOWER — computed rules over the fixtures (idempotent, re-runnable)

     R13 · FULL-FIDELITY MIRROR of production's `run_watchtower` — see
     /root/fleet/run_watchtower_prod_rules.md. This replaces the mock's old,
     different seven-rule set (rate_ended, erc_conflict, no_adviser,
     protection_gap, stalled, completed_no_date, no_contact — none of which
     production actually has) with production's real ten — R65 makes it twelve:
       1. offer_stale            — per-case, dedupe offer_stale:<case_id>
       2. app_not_submitted      — per-case, dedupe app_not_submitted:<case_id>
       3. exchange_no_chase      — per-case, dedupe exchange_no_chase:<case_id>
       4. lead_slow              — per-lead, dedupe lead_slow:<lead_id>
       5. email_unanswered       — per-CLIENT (R65), dedupe email_unanswered:c:<client_id>
                                   · an email with NO client_id stays per-email,
                                     dedupe email_unanswered:<email_id> (the old key)
       6. fee_aging              — per-case, dedupe fee_aging:<case_id>
       7. workload               — per-staff, dedupe workload:<profile_id>
       8. retention_gap          — AGGREGATE, one row, dedupe retention_gap:global
       9. fee_aging_60           — AGGREGATE, one row, dedupe fee_aging_60
      10. protection_quote_stale — per-case, dedupe protection_quote_stale:<case_id>
      11. offer_before_completion (R65) — per-case, dedupe offer_before_completion:<case_id>
      12. erc_before_completion   (R65) — per-case, dedupe erc_before_completion:<case_id>

     `email_unanswered` reads `case_emails` — the mock already models an
     inbound-email table under that exact name (triage_status/received_at,
     seeded a few rows up — search "case_emails (inbound, Outlook sync)"),
     so this rule is real, not modelled against a substitute or skipped.

     R65 · WHY RULE 5 IS NOW PER CLIENT. The rule fired once per unanswered
     message, so a client who sent three emails across two of their cases
     produced three byte-identical-looking WARNING rows on the Watchtower and
     three separate Dismiss buttons for what is, to the person doing the work,
     ONE conversation to answer. Production's function now aggregates them:
     one row per client, carrying the count, the latest subject and the latest
     message's case_id (so Open still lands on the case the conversation is
     actually about). An email with no client_id has no client to aggregate
     ON, so it keeps the old per-email key — those rows are the exception, not
     a second shape of the same thing.

     R65 · THE TWO NEW DATE RULES. Both are about a date pair the firm records
     but nothing ever compared:
       · offer_before_completion — an offer that expires BEFORE the completion
         it is supposed to fund. The lender's offer has a hard expiry; if the
         chain is not going to complete until after it, the offer has to be
         re-issued (or extended) and nobody finds out until the week it dies.
       · erc_before_completion — a retention case (a successor whose
         retention_source_case_id points at the client's earlier case) whose
         expected completion falls INSIDE the old rate's ERC window, i.e. the
         client is charged an Early Repayment Charge for leaving a deal they
         were about to leave for free a few weeks later.
     Both read only columns that already exist on `cases`, so there is no
     migration toggle and no applyInsertDefaults change to make.

     R65 · DATE TEXT. Rules 11/12 (and rule 5's timestamp) print DATES THE WAY
     PRODUCTION'S to_char DOES — `DD Mon YYYY` / `DD Mon HH24:MI`, evaluated
     AT TIME ZONE 'Europe/London' — not the raw ISO the older rules emit. That
     is deliberate parity with the SQL, not a house-style drift: app.js's
     humanizeAlertDates() only rewrites whole YYYY-MM-DD substrings, so an
     already-British date passes through it untouched and reads identically.

     `lead_slow`'s production detail branch on `leads.acknowledged_at` is NOT
     mirrored: this mock's `leads` table has never carried that column (only
     `first_contact_at` / `discard_reason` from earlier rounds), and adding a
     new column purely to light up one sentence of alert copy was out of
     scope for this pass. Stated here rather than guessed at — the rule
     itself (status/age/severity/dedupe) is otherwise exact.

     `protection_quote_stale` reads `cases.protection_quoted_at`, a column
     this mock has never formally declared (mkCase() does not default it) —
     it exists only because app.js already writes it ad hoc via `.update()`
     when a case is marked "quoted" (see tests/r12a.js § D9), and the mock's
     update path merges arbitrary payload keys onto a row without a fixed
     schema. Rows never touched by that code path simply have it undefined,
     which this rule treats identically to null (no quote date recorded).

     Every rule below upserts on `dedupe_key`, mirroring production's
     `ON CONFLICT (dedupe_key) DO UPDATE SET severity, title, detail,
     last_seen_at, resolved_at` — it never writes the M3 snooze columns,
     which is exactly why a snooze survives every Run checks / cron pass.
     ======================================================================= */
  function watchtowerRules() {
    var out = [];
    var today = TODAY;
    var nowMs = NOW.getTime();
    var GBP = function (n) { return "£" + Math.round(n).toLocaleString("en-GB"); };
    /* R65 — production prints these with to_char(… AT TIME ZONE 'Europe/London', 'DD Mon YYYY')
       and 'DD Mon HH24:MI'. Both are zero-padded on the day and 24-hour on the clock, which is
       what to_char does and what fmtD() in app.js (day:"numeric") does NOT — so they are built
       here rather than left to the app, exactly like every other word run_watchtower composes.
       A date-only column is read at midday UTC so the London calendar day can never slide across
       a midnight the way `new Date("2026-08-26")` at 00:00Z does under BST. */
    var LDN = "Europe/London";
    /* to_char's 'Mon' is a fixed three-letter English abbreviation. Intl's month:"short" is NOT
       (en-GB renders September as "Sept", en-AU as "Sep."), so the month name comes from this
       table and only the CALENDAR FIELDS come from Intl — via en-CA, which is ISO-ordered and
       therefore trivially parseable. */
    var WT_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var londonParts = function (t) {
      var ymd = new Intl.DateTimeFormat("en-CA", { timeZone: LDN, year: "numeric", month: "2-digit", day: "2-digit" }).format(t).split("-");
      var hm = new Intl.DateTimeFormat("en-GB", { timeZone: LDN, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
      return { y: ymd[0], m: Number(ymd[1]), d: ymd[2], hm: hm };
    };
    var wtDate = function (d) {
      if (!d) return "";
      var t = /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? new Date(String(d) + "T12:00:00Z") : new Date(d);
      if (isNaN(t.getTime())) return String(d);
      var p = londonParts(t);
      return p.d + " " + WT_MON[p.m - 1] + " " + p.y;
    };
    var wtStamp = function (ts) {
      if (!ts) return "";
      var t = new Date(ts);
      if (isNaN(t.getTime())) return String(ts);
      var p = londonParts(t);
      return p.d + " " + WT_MON[p.m - 1] + " " + p.hm;
    };
    /* whole days between two date-only strings, both read at midday so DST never rounds one out */
    var wtDayGap = function (from, to) {
      return Math.round((new Date(String(to) + "T12:00:00Z").getTime() - new Date(String(from) + "T12:00:00Z").getTime()) / DAY);
    };
    var plural = function (n, one, many) { return n + " " + (n === 1 ? one : many); };

    /* 1 · offer_stale — stage 'offer', expiry within 30 days (crit ≤14) OR no
       expiry recorded and untouched for 30+ days (warn). */
    DB.cases.forEach(function (c) {
      if (c.stage !== "offer") return;
      var nm = clientName(c.client_id);
      if (c.offer_expiry_date) {
        var days = Math.round((new Date(c.offer_expiry_date + "T12:00:00").getTime() - new Date(today + "T12:00:00").getTime()) / DAY);
        if (days > 30) return;
        out.push({
          rule: "offer_stale", severity: days <= 14 ? "crit" : "warn", case_id: c.id, client_id: c.client_id,
          title: "Offer expiry risk: " + nm,
          detail: "Offer expires " + c.offer_expiry_date + " (" + days + (days === 1 ? " day" : " days") + ")",
          dedupe_key: "offer_stale:" + c.id
        });
      } else {
        if ((nowMs - new Date(c.updated_at).getTime()) / DAY <= 30) return;
        out.push({
          rule: "offer_stale", severity: "warn", case_id: c.id, client_id: c.client_id,
          title: "Offer expiry risk: " + nm,
          detail: "In offer stage since " + String(c.updated_at).slice(0, 10) + " with no expiry date recorded",
          dedupe_key: "offer_stale:" + c.id
        });
      }
    });

    /* 2 · app_not_submitted — stage 'application', submitted_at null,
       untouched for 3+ days. */
    DB.cases.forEach(function (c) {
      if (c.stage !== "application" || c.submitted_at) return;
      if ((nowMs - new Date(c.updated_at).getTime()) / DAY <= 3) return;
      out.push({
        rule: "app_not_submitted", severity: "warn", case_id: c.id, client_id: c.client_id,
        title: "Application not yet submitted: " + clientName(c.client_id),
        detail: "At Application since " + String(c.updated_at).slice(0, 10) + " and not yet marked submitted.",
        dedupe_key: "app_not_submitted:" + c.id
      });
    });

    /* 3 · exchange_no_chase — stage 'exchange', no open 'Chase solicitors%'
       task and none completed in the last 14 days. */
    DB.cases.forEach(function (c) {
      if (c.stage !== "exchange") return;
      var openChase = DB.case_tasks.some(function (t) {
        return t.case_id === c.id && !t.done_at && /^Chase solicitors/.test(t.title || "");
      });
      if (openChase) return;
      var recentlyDone = DB.case_tasks.some(function (t) {
        return t.case_id === c.id && t.done_at && /^Chase solicitors/.test(t.title || "") &&
          (nowMs - new Date(t.done_at).getTime()) / DAY <= 14;
      });
      if (recentlyDone) return;
      out.push({
        rule: "exchange_no_chase", severity: "warn", case_id: c.id, client_id: c.client_id,
        title: "No solicitor chase on file: " + clientName(c.client_id),
        detail: "At Exchange with no open \"Chase solicitors\" task, and none completed in the last 14 days.",
        dedupe_key: "exchange_no_chase:" + c.id
      });
    });

    /* 4 · lead_slow — status 'new', created over an hour ago, never contacted. */
    DB.leads.forEach(function (l) {
      if (l.status !== "new" || l.first_contact_at) return;
      var ageH = (nowMs - new Date(l.created_at).getTime()) / 3600000;
      if (ageH <= 1) return;
      out.push({
        rule: "lead_slow", severity: ageH > 24 ? "crit" : "warn",
        case_id: null, client_id: null, lead_id: l.id,
        title: "Lead not yet contacted: " + (l.name || "(no name)"),
        detail: "Received " + Math.floor(ageH) + "h ago with no first contact recorded.",
        dedupe_key: "lead_slow:" + l.id
      });
    });

    /* 5 · email_unanswered — case_emails, triage_status 'new', received 24h+ ago.
       R65 — ONE ROW PER CLIENT, not per message. The waiting set is partitioned on client_id:
       every message that HAS one is folded into that client's single alert (count, latest
       subject, latest message's case_id); a message with NO client_id has nothing to fold into
       and keeps the original per-email dedupe key, so an unmatched inbox row is still visible
       and still individually dismissible. The alert's case_id is the LATEST message's case —
       across two cases the newest conversation is the one Open should land on. */
    var waiting = DB.case_emails.filter(function (e) {
      if (e.triage_status !== "new") return false;
      return (nowMs - new Date(e.received_at).getTime()) / DAY > 1;
    });
    var senderOf = function (e) { return e.from_name || e.from_email || "(unknown sender)"; };
    var emailAlert = function (rows, key, clientId) {
      /* newest first — the "latest" message supplies the sender, subject and case */
      var sorted = rows.slice().sort(function (a, b) { return String(a.received_at) < String(b.received_at) ? 1 : -1; });
      var latest = sorted[0];
      return {
        rule: "email_unanswered", severity: "warn",
        case_id: latest.case_id || null, client_id: clientId,
        title: "Client email unanswered: " + senderOf(latest),
        detail: plural(sorted.length, "message", "messages") + " waiting · latest \"" +
          (latest.subject || "(no subject)") + "\" received " + wtStamp(latest.received_at),
        dedupe_key: key
      };
    };
    var byClient = {}, clientOrder = [];
    waiting.forEach(function (e) {
      if (!e.client_id) {
        /* no client to aggregate on — the old per-email row, unchanged in shape and key */
        out.push(emailAlert([e], "email_unanswered:" + e.id, null));
        return;
      }
      if (!byClient[e.client_id]) { byClient[e.client_id] = []; clientOrder.push(e.client_id); }
      byClient[e.client_id].push(e);
    });
    clientOrder.forEach(function (cid) {
      out.push(emailAlert(byClient[cid], "email_unanswered:c:" + cid, cid));
    });

    /* 6 · fee_aging — fee_status 'requested', fee_requested_at 14+ days ago
       (crit past 30). */
    DB.cases.forEach(function (c) {
      if (c.fee_status !== "requested" || !c.fee_requested_at) return;
      var days = Math.floor((nowMs - new Date(c.fee_requested_at).getTime()) / DAY);
      if (days <= 14) return;
      out.push({
        rule: "fee_aging", severity: days > 30 ? "crit" : "warn", case_id: c.id, client_id: c.client_id,
        title: "Fee requested and unpaid: " + clientName(c.client_id),
        detail: "Requested " + String(c.fee_requested_at).slice(0, 10) + " (" + days + " days ago) and still unpaid.",
        dedupe_key: "fee_aging:" + c.id
      });
    });

    /* 7 · workload — staff with 5+ overdue open tasks. */
    var overdueByStaff = {};
    DB.case_tasks.forEach(function (t) {
      if (t.done_at || !t.due_date || t.due_date >= today || !t.assigned_to) return;
      overdueByStaff[t.assigned_to] = (overdueByStaff[t.assigned_to] || 0) + 1;
    });
    Object.keys(overdueByStaff).forEach(function (pid) {
      var n = overdueByStaff[pid];
      if (n < 5) return;
      var p = DB.profiles.filter(function (x) { return x.id === pid; })[0];
      out.push({
        rule: "workload", severity: "warn",
        case_id: null, client_id: null, staff_id: pid,
        title: "Heavy overdue task load: " + ((p && p.full_name) || pid),
        detail: n + " tasks overdue.",
        dedupe_key: "workload:" + pid
      });
    });

    /* 8 · retention_gap — AGGREGATE, single row, only when count > 0: cases
       with a rate ending inside 90 days, no reminder queued, no retention
       successor already started, not lost. */
    var retentionGapCases = DB.cases.filter(function (c) {
      if (c.stage === "not_proceeding" || !c.rate_end_date || c.rate_reminder_queued_at || c.retention_source_case_id) return false;
      var days = (new Date(c.rate_end_date + "T12:00:00").getTime() - new Date(today + "T12:00:00").getTime()) / DAY;
      return days >= 0 && days <= 90;
    });
    if (retentionGapCases.length > 0) {
      out.push({
        rule: "retention_gap", severity: "info", case_id: null, client_id: null,
        title: "Rates ending soon with no retention case started",
        detail: retentionGapCases.length + " case" + (retentionGapCases.length === 1 ? "" : "s") +
          " with a rate ending inside 90 days and no retention successor started.",
        dedupe_key: "retention_gap:global"
      });
    }

    /* 9 · fee_aging_60 — AGGREGATE, single row, only when count > 0:
       completed 60+ days ago with any of proc/broker/sols still unpaid. */
    var unpaidCases = DB.cases.filter(function (c) {
      if (c.stage !== "completed" || !c.completed_at) return false;
      if ((nowMs - new Date(c.completed_at).getTime()) / DAY <= 60) return false;
      var brokerUnpaid = c.broker_fee > 0 && !c.broker_fee_paid_at && ["paid", "waived"].indexOf(c.fee_status) === -1;
      var procUnpaid = c.proc_fee > 0 && !c.proc_fee_paid_at;
      var solsUnpaid = c.sols_fee > 0 && !c.sols_fee_paid_at;
      return brokerUnpaid || procUnpaid || solsUnpaid;
    });
    if (unpaidCases.length > 0) {
      var procTotal = 0, brokerTotal = 0, solsTotal = 0;
      unpaidCases.forEach(function (c) {
        if (c.proc_fee > 0 && !c.proc_fee_paid_at) procTotal += c.proc_fee;
        if (c.broker_fee > 0 && !c.broker_fee_paid_at && ["paid", "waived"].indexOf(c.fee_status) === -1) brokerTotal += c.broker_fee;
        if (c.sols_fee > 0 && !c.sols_fee_paid_at) solsTotal += c.sols_fee;
      });
      out.push({
        rule: "fee_aging_60", severity: "warn", case_id: null, client_id: null,
        title: "Unpaid fees aged over 60 days",
        detail: unpaidCases.length + " completed case" + (unpaidCases.length === 1 ? "" : "s") +
          " with fees unpaid >60 days — " + GBP(procTotal + brokerTotal + solsTotal) +
          " outstanding (proc " + GBP(procTotal) + " · broker " + GBP(brokerTotal) + " · sols " + GBP(solsTotal) + ")",
        dedupe_key: "fee_aging_60"
      });
    }

    /* 10 · protection_quote_stale — protection_status 'quoted' AND (quoted
       14+ days ago, OR no quote date recorded and the case is completed). */
    DB.cases.forEach(function (c) {
      if (c.protection_status !== "quoted") return;
      var qAt = c.protection_quoted_at || null;
      var detail = null;
      if (qAt) {
        var days = Math.floor((nowMs - new Date(qAt).getTime()) / DAY);
        if (days > 14) detail = "Quoted " + String(qAt).slice(0, 10) + " (" + days + "d) with no outcome recorded";
      } else if (c.stage === "completed") {
        detail = "Marked quoted with no quote date recorded · case completed " + String(c.completed_at || "").slice(0, 10);
      }
      if (!detail) return;
      out.push({
        rule: "protection_quote_stale", severity: "warn", case_id: c.id, client_id: c.client_id,
        title: "Protection quote stale: " + clientName(c.client_id),
        detail: detail,
        dedupe_key: "protection_quote_stale:" + c.id
      });
    });

    /* 11 · offer_before_completion (R65) — a case at 'offer' or 'exchange' that has BOTH an
       offer expiry and an expected completion date recorded, where the OFFER DIES FIRST.
       Nothing on the case screen compares those two fields, so the mismatch only surfaces in
       the week the offer expires — by which point re-issuing it is a rush job on the lender's
       timetable, not ours. CRITICAL once the offer itself is inside 30 days (the point at which
       there is no longer time to re-broke it calmly), a WARNING before that: the same date pair,
       but one is a fire and the other is a diary note.
       Exchange is included on purpose — an exchanged case still completes against the same
       offer, and that is exactly when a slipped completion date starts to bite. */
    DB.cases.forEach(function (c) {
      if (c.stage !== "offer" && c.stage !== "exchange") return;
      if (!c.offer_expiry_date || !c.expected_completion_date) return;
      if (!(c.offer_expiry_date < c.expected_completion_date)) return;
      var toExpiry = wtDayGap(today, c.offer_expiry_date);          /* days until the offer dies */
      var short = wtDayGap(c.offer_expiry_date, c.expected_completion_date);
      out.push({
        rule: "offer_before_completion", severity: toExpiry <= 30 ? "crit" : "warn",
        case_id: c.id, client_id: c.client_id,
        title: "Offer expires before completion: " + clientName(c.client_id),
        detail: "Offer expires " + wtDate(c.offer_expiry_date) + " · completion expected " +
          wtDate(c.expected_completion_date) + " — " + plural(short, "day", "days") + " short",
        dedupe_key: "offer_before_completion:" + c.id
      });
    });

    /* 12 · erc_before_completion (R65) — a LIVE retention case whose expected completion falls
       INSIDE the ERC window of the case it came from. The client is leaving the old deal early
       and paying the lender's Early Repayment Charge for the privilege, when waiting a few weeks
       would have cost nothing; the two dates live on two DIFFERENT case rows, which is precisely
       why nobody ever put them side by side. Always a WARNING: it is a conversation to have (a
       completion date to move, or a charge to explain and justify in writing), not an emergency.
       Completed / not_proceeding successors are excluded — the money is either already spent or
       the case is dead, and an alert about neither is noise. */
    var caseById = {};
    DB.cases.forEach(function (c) { caseById[c.id] = c; });
    DB.cases.forEach(function (c) {
      if (c.stage === "completed" || c.stage === "not_proceeding") return;
      if (!c.retention_source_case_id || !c.expected_completion_date) return;
      var src = caseById[c.retention_source_case_id];
      if (!src || !src.erc_end_date) return;
      if (!(c.expected_completion_date < src.erc_end_date)) return;
      var early = wtDayGap(c.expected_completion_date, src.erc_end_date);
      out.push({
        rule: "erc_before_completion", severity: "warn",
        case_id: c.id, client_id: c.client_id,
        title: "Completing inside the old rate's ERC: " + clientName(c.client_id),
        detail: "Old rate's ERC runs until " + wtDate(src.erc_end_date) + " · completion expected " +
          wtDate(c.expected_completion_date) + " — " + plural(early, "day", "days") + " early",
        dedupe_key: "erc_before_completion:" + c.id
      });
    });

    return out;
  }
  function runWatchtower() {
    var wanted = watchtowerRules();
    var wantedKeys = {};
    wanted.forEach(function (r) { wantedKeys[r.dedupe_key] = r; });
    var byKey = {};
    DB.watch_alerts.forEach(function (a) { byKey[a.dedupe_key] = a; });
    var resolved = 0, added = 0;
    /* auto-resolve sweep — any open alert not named by THIS run's rule set
       (i.e. whose last_seen_at was not just refreshed to "now" below) closes.
       Equivalent to comparing last_seen_at against the run start, since every
       alert this run DOES want gets last_seen_at stamped to now() a few
       lines down — so anything left with a stale last_seen_at after this
       loop is exactly "not named this run". */
    DB.watch_alerts.forEach(function (a) {
      if (a.resolved_at) return;
      if (!wantedKeys[a.dedupe_key]) { a.resolved_at = iso(NOW); resolved++; }
    });
    Object.keys(wantedKeys).forEach(function (k) {
      var r = wantedKeys[k];
      var existing = byKey[k];
      if (existing) {
        /* DO UPDATE — snoozed_until / snooze_note / snoozed_by are untouched */
        existing.severity = r.severity;
        existing.title = r.title;
        existing.detail = r.detail;
        existing.last_seen_at = iso(NOW);
        existing.resolved_at = null;
        return;
      }
      DB.watch_alerts.push({
        id: nid("wa"), rule: r.rule, severity: r.severity,
        case_id: r.case_id || null, client_id: r.client_id || null,
        staff_id: r.staff_id || null, lead_id: r.lead_id || null,
        dedupe_key: k,
        title: r.title, detail: r.detail,
        created_at: iso(NOW), last_seen_at: iso(NOW), resolved_at: null,
        /* M3 */
        snoozed_until: null, snooze_note: null, snoozed_by: null
      });
      added++;
    });
    var open = DB.watch_alerts.filter(function (a) { return !a.resolved_at; }).length;
    return { open: open, new: added, resolved: resolved };
  }
  runWatchtower();
  /* backdate the seeded alerts so "created" reads sensibly on the drawer */
  DB.watch_alerts.forEach(function (a, i) { a.created_at = iso(shift(-(i % 9) - 1)); });
  /* M3 — one alert already snoozed, so the "N snoozed" header/toggle has a row
     on first load. Invisible to the pre-round-5 app, which ignores the columns.
     R13 — re-pointed from the retired "protection_gap" rule to
     "protection_quote_stale", production's closest analogue (also an
     info-adjacent, non-urgent protection-conversation state). */
  (function seedSnooze() {
    var a = DB.watch_alerts.filter(function (x) { return x.rule === "protection_quote_stale" && !x.resolved_at; })[0]
      || DB.watch_alerts.filter(function (x) { return x.severity !== "crit" && !x.resolved_at; })[0];
    if (!a) return;
    a.snoozed_until = iso(shift(9));
    a.snooze_note = "Client is abroad until the 12th — protection call booked for their return.";
    a.snoozed_by = "p2";
  })();

  /* =========================================================================
     v_alerts — a computed view over cases + clients
     ======================================================================= */
  function vAlerts() {
    return DB.cases.filter(function (c) { return !!c.rate_end_date; }).map(function (c) {
      var cl = DB.clients.filter(function (x) { return x.id === c.client_id; })[0] || {};
      var days = Math.round((new Date(c.rate_end_date + "T12:00:00").getTime() - new Date(TODAY + "T12:00:00").getTime()) / DAY);
      return {
        case_id: c.id,
        client_id: c.client_id,
        client_name: [cl.first_name, cl.last_name].filter(Boolean).join(" ") || "(no name)",
        stage: c.stage,
        lender: c.lender,
        rate_percent: c.rate_percent,
        rate_end_date: c.rate_end_date,
        rate_end_estimated: !!c.rate_end_estimated,
        days_to_rate_end: days,
        erc_end_date: c.erc_end_date,
        erc_outlasts_rate: !!(c.erc_end_date && c.rate_end_date && c.erc_end_date > c.rate_end_date),
        fee_status: c.fee_status,
        broker_fee: c.broker_fee,
        rate_reminder_queued_at: c.rate_reminder_queued_at,
        assigned_to: c.assigned_to
      };
    });
  }
  var VIEWS = { v_alerts: vAlerts };

  /* =========================================================================
     QUERY BUILDER
     ======================================================================= */
  function sourceRows(table) {
    if (VIEWS[table]) return VIEWS[table]();
    if (!DB[table]) return [];
    return DB[table];
  }

  function Builder(table) {
    this._table = table;
    this._op = null;
    this._columns = "*";
    this._count = null;
    this._head = false;
    this._payload = null;
    this._returning = null;
    this._preds = [];
    this._orders = [];
    this._limit = null;
    this._range = null;
    this._single = null;   /* "single" | "maybe" */
  }
  var BP = Builder.prototype;

  BP.select = function (cols, opts) {
    opts = opts || {};
    if (this._op && this._op !== "select") { this._returning = cols == null ? "*" : cols; return this; }
    this._op = "select";
    this._columns = cols == null ? "*" : cols;
    if (opts.count) this._count = opts.count;
    if (opts.head) this._head = true;
    return this;
  };
  BP.insert = function (rows) { this._op = "insert"; this._payload = rows; return this; };
  BP.upsert = function (rows, opts) { this._op = "upsert"; this._payload = rows; this._upsertOpts = opts || {}; return this; };
  BP.update = function (patch) { this._op = "update"; this._payload = patch; return this; };
  BP["delete"] = function () { this._op = "delete"; return this; };

  function addFilter(b, col, op, val) {
    b._preds.push(function (row) { return testOp(row[col], op, val); });
    return b;
  }
  ["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike"].forEach(function (op) {
    BP[op] = function (col, val) { return addFilter(this, col, op, val); };
  });
  BP.is = function (col, val) { return addFilter(this, col, "is", val); };
  BP["in"] = function (col, vals) { return addFilter(this, col, "in", vals); };
  BP.contains = function (col, val) { return addFilter(this, col, "cs", val); };
  BP.not = function (col, op, val) {
    this._preds.push(function (row) { return !testOp(row[col], op, val); });
    return this;
  };
  BP.or = function (str) {
    var fn = parseLogicList(String(str), "or");
    this._preds.push(fn);
    return this;
  };
  BP.filter = function (col, op, val) { return addFilter(this, col, op, val); };
  BP.match = function (obj) {
    var self = this;
    Object.keys(obj || {}).forEach(function (k) { addFilter(self, k, "eq", obj[k]); });
    return this;
  };
  BP.order = function (col, opts) {
    opts = opts || {};
    var asc = opts.ascending === undefined ? true : !!opts.ascending;
    var nullsFirst = opts.nullsFirst === undefined ? !asc : !!opts.nullsFirst;  /* Postgres default */
    this._orders.push({ col: col, asc: asc, nullsFirst: nullsFirst });
    return this;
  };
  BP.limit = function (n) { this._limit = n; return this; };
  BP.range = function (from, to) { this._range = [from, to]; return this; };
  BP.single = function () { this._single = "single"; return this; };
  BP.maybeSingle = function () { this._single = "maybe"; return this; };
  BP.csv = function () { return this; };
  BP.abortSignal = function () { return this; };
  BP.returns = function () { return this; };
  BP.throwOnError = function () { this._throw = true; return this; };

  BP._matching = function () {
    var preds = this._preds;
    var table = this._table;
    var rows = sourceRows(table).filter(function (row) {
      return preds.every(function (p) { return p(row); });
    });
    /* R43 — saved_views' RLS is per-user on SELECT, UPDATE and DELETE alike, so the scoping goes
       HERE rather than in readFilter() (which only redacts the select path). It matters: the app
       deletes with .match({scope,name}) and nothing else, and in production that statement can
       only ever reach the caller's own row. Filtering here means it deletes exactly one person's
       "Unassigned leads", the same way, instead of every persona's. */
    if (table === "saved_views") {
      rows = rows.filter(function (r) { return r.user_id === CURRENT_UID; });
    }
    return rows;
  };
  BP._sort = function (rows) {
    if (!this._orders.length) return rows;
    var ord = this._orders;
    return rows.slice().sort(function (a, b) {
      for (var i = 0; i < ord.length; i++) {
        var o = ord[i];
        var av = a[o.col], bv = b[o.col];
        var an = av == null || av === "", bn = bv == null || bv === "";
        if (an && bn) continue;
        if (an) return o.nullsFirst ? -1 : 1;
        if (bn) return o.nullsFirst ? 1 : -1;
        var c = cmp(av, bv);
        if (c !== 0) return o.asc ? c : -c;
      }
      return 0;
    });
  };
  BP._finish = function (rows, total) {
    var res = { data: null, error: null, count: this._count ? total : null, status: 200, statusText: "OK" };
    if (this._head) { res.data = null; return res; }
    if (this._single === "single") {
      if (rows.length !== 1) {
        res.data = null;
        res.error = { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116", details: "Results contain " + rows.length + " rows", hint: null };
        res.status = 406;
        return res;
      }
      res.data = rows[0];
      return res;
    }
    if (this._single === "maybe") { res.data = rows.length ? rows[0] : null; return res; }
    res.data = rows;
    return res;
  };

  BP._runSelect = function () {
    var embErr = embedError(this._table, this._columns);
    if (embErr) return { data: null, error: embErr, count: null, status: 300, statusText: "Multiple Choices" };
    var rows = readFilter(this._table, this._matching());
    var total = rows.length;
    rows = this._sort(rows);
    if (this._range) rows = rows.slice(this._range[0], this._range[1] + 1);
    else if (this._limit != null) rows = rows.slice(0, this._limit);
    var table = this._table, cols = this._columns;
    var out = projectRows(table, rows, cols);
    return this._finish(out, total);
  };

  /* R43 — which columns an upsert resolves its conflict against. PostgREST uses the table's PRIMARY
     KEY unless the caller names an `onConflict` list, and until this round every table in this mock
     had a single-column key, so `raw[pk]` was the whole story. saved_views' key is the triple
     (user_id, scope, name), and its user_id arrives DEFAULTED rather than sent — so the probe row
     must carry that default too, or the second upsert of the same view would land as a duplicate
     row instead of an update. Deliberately NOT applyInsertDefaults(): that one has side effects
     (error_events' serial), and this is only ever a lookup. */
  function conflictCols(table, opts) {
    var oc = opts && opts.onConflict;
    if (oc) return String(oc).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    return pkCols(table);
  }
  function conflictProbe(table, raw) {
    if (table === "saved_views" && raw && raw.user_id == null) {
      var p = clone(raw); p.user_id = CURRENT_UID; return p;
    }
    return raw;
  }
  BP._runInsert = function (isUpsert) {
    var table = this._table;
    var incoming = Array.isArray(this._payload) ? this._payload : [this._payload];
    var keys = conflictCols(table, this._upsertOpts);
    var written = [];
    for (var i = 0; i < incoming.length; i++) {
      var raw = incoming[i] || {};
      var existing = null;
      if (isUpsert) {
        var probe = conflictProbe(table, raw);
        existing = DB[table].filter(function (r) {
          return keys.every(function (k) { return probe[k] != null && r[k] === probe[k]; });
        })[0] || null;
      }
      var badCol = undefinedColumn(table, raw);
      if (badCol) {
        return { data: null, error: pgError('column "' + badCol + '" of relation "' + table + '" does not exist', "42703"), count: null, status: 400, statusText: "Bad Request" };
      }
      var err = writePolicy(table, existing ? "update" : "insert", raw, existing ? [existing] : []);
      if (err) return { data: null, error: err, count: null, status: 403, statusText: "Forbidden" };
      if (existing) {
        var before = clone(existing);
        var diff = {};
        Object.keys(raw).forEach(function (k) {
          if (sameValue(before[k], raw[k])) return;
          diff[k] = { old: before[k] === undefined ? null : before[k], new: raw[k] };
          existing[k] = raw[k];
        });
        if (Object.keys(diff).length) {
          if (table === "cases" || table === "clients" || table === "vault_entries") existing.updated_at = iso(new Date());
          auditRow(table, "update", existing, diff);
          if (table === "cases") caseEventsForUpdate(before, existing);
          /* R63 · A2(b) — auto_stage_comms fires from BOTH write paths, because an upsert that
             lands on an existing row is an UPDATE as far as the trigger is concerned. */
          if (table === "cases") autoStageComms(before, existing);
          if (table === "fact_finds" && before.status !== "submitted" && existing.status === "submitted") {
            logFactFindSubmit(existing, existing.submitted_at || iso(new Date()));
          }
        }
        written.push(existing);
      } else {
        var row = applyInsertDefaults(table, raw);
        if (!DB[table]) return { data: null, error: pgError('relation "' + table + '" does not exist', "42P01"), count: null, status: 404, statusText: "Not Found" };
        DB[table].push(row);
        auditRow(table, "insert", row, clone(row));
        if (table === "cases") caseEvent(row.id, "case_created", "Stage: " + row.stage);
        if (table === "fact_finds" && row.status === "submitted") logFactFindSubmit(row, row.submitted_at || row.created_at);
        written.push(row);
      }
    }
    if (this._returning == null) return this._finish([], written.length);
    var t = table, ret = this._returning;
    var wErr = embedError(t, ret);
    if (wErr) return { data: null, error: wErr, count: null, status: 300, statusText: "Multiple Choices" };
    return this._finish(projectRows(t, written, ret), written.length);
  };

  BP._runUpdate = function () {
    var table = this._table;
    var targets = this._matching();
    var badCol = undefinedColumn(table, this._payload);
    if (badCol) {
      return { data: null, error: pgError('column "' + badCol + '" of relation "' + table + '" does not exist', "42703"), count: null, status: 400, statusText: "Bad Request" };
    }
    var err = writePolicy(table, "update", this._payload, targets);
    if (err) return { data: null, error: err, count: null, status: 403, statusText: "Forbidden" };
    var patch = this._payload || {};
    var updated = [];
    targets.forEach(function (row) {
      var before = clone(row);
      var diff = {};
      Object.keys(patch).forEach(function (k) {
        var a = before[k] === undefined ? null : before[k];
        var b = patch[k];
        if (sameValue(a, b)) return;
        diff[k] = { old: a, new: b };
        row[k] = b;
      });
      if (table === "cases" || table === "clients" || table === "vault_entries") row.updated_at = iso(new Date());
      if (Object.keys(diff).length) {
        auditRow(table, "update", row, diff);
        if (table === "cases") caseEventsForUpdate(before, row);
        if (table === "cases") autoStageComms(before, row);   /* R63 · A2(b) — the stage-comms trigger */
        if (table === "fact_finds" && before.status !== "submitted" && row.status === "submitted") {
          logFactFindSubmit(row, row.submitted_at || iso(new Date()));
        }
      }
      updated.push(row);
    });
    if (this._returning == null) return this._finish([], updated.length);
    var t = table, ret = this._returning;
    var uErr = embedError(t, ret);
    if (uErr) return { data: null, error: uErr, count: null, status: 300, statusText: "Multiple Choices" };
    return this._finish(projectRows(t, updated, ret), updated.length);
  };

  BP._runDelete = function () {
    var table = this._table;
    var targets = this._matching();
    var err = writePolicy(table, "delete", null, targets);
    if (err) return { data: null, error: err, count: null, status: 403, statusText: "Forbidden" };
    var removed = [];
    targets.forEach(function (row) {
      var i = DB[table].indexOf(row);
      if (i >= 0) DB[table].splice(i, 1);
      auditRow(table, "delete", row, clone(row));
      removed.push(row);
      /* ON DELETE CASCADE parity */
      if (table === "clients") {
        var kids = DB.cases.filter(function (c) { return c.client_id === row.id; });
        kids.forEach(function (c) {
          DB.cases.splice(DB.cases.indexOf(c), 1);
          auditRow("cases", "delete", c, clone(c));
          cascadeCase(c.id);
        });
        ["appointments", "email_queue", "sms_queue", "case_emails", "fact_finds", "watch_alerts"].forEach(function (t) {
          DB[t] = DB[t].filter(function (r) { return r.client_id !== row.id; });
        });
      }
      if (table === "cases") cascadeCase(row.id);
      /* R44 — commission_lines.statement_id is ON DELETE CASCADE. The import's
         rollback depends on it: when a line-insert fails part way the app
         deletes the statement row and expects whatever landed to go with it. */
      if (table === "commission_statements") {
        DB.commission_lines = DB.commission_lines.filter(function (l) { return String(l.statement_id) !== String(row.id); });
      }
    });
    if (this._returning == null) return this._finish([], removed.length);
    var t = table, ret = this._returning;
    var dErr = embedError(t, ret);
    if (dErr) return { data: null, error: dErr, count: null, status: 300, statusText: "Multiple Choices" };
    return this._finish(projectRows(t, removed, ret), removed.length);
  };
  function cascadeCase(caseId) {
    ["case_tasks", "case_notes", "case_events", "email_queue", "sms_queue", "case_emails", "fact_finds", "watch_alerts", "appointments"].forEach(function (t) {
      DB[t] = DB[t].filter(function (r) { return r.case_id !== caseId; });
    });
    /* R44 — commission_lines.matched_case_id is ON DELETE SET NULL, not cascade:
       a deleted case must not take the network's record of the payment with it.
       The line survives, unmatched, which is the honest state. */
    DB.commission_lines.forEach(function (l) {
      if (String(l.matched_case_id) === String(caseId)) {
        l.matched_case_id = null;
        if (l.match_status === "confirmed" || l.match_status === "suggested") l.match_status = "unmatched";
      }
    });
  }

  BP._run = function () {
    var self = this;
    return new Promise(function (resolve) {
      var res;
      try {
        if (self._table === "error_events" && !errorEventsSupported) {
          /* R30 feature-gate — a DB without the table answers every op with 42P01. */
          res = { data: null, error: { message: 'relation "error_events" does not exist', code: "42P01", details: null, hint: null }, count: null, status: 404, statusText: "Not Found" };
        } else if (self._table === "saved_views" && !savedViewsSupported) {
          /* R43 feature-gate — the un-migrated deployment the app's localStorage fallback exists
             for. Every op, not just the read: the fallback has to hold for a save and a delete
             made in the same session as the failed read. */
          res = { data: null, error: pgError('relation "public.saved_views" does not exist', "42P01"), count: null, status: 404, statusText: "Not Found" };
        } else if ((!DB[self._table] && !VIEWS[self._table]) || tableIsMissing(self._table)) {
          res = { data: null, error: pgError('relation "public.' + self._table + '" does not exist', "42P01"), count: null, status: 404, statusText: "Not Found" };
        } else if (self._op === "insert") res = self._runInsert(false);
        else if (self._op === "upsert") res = self._runInsert(true);
        else if (self._op === "update") res = self._runUpdate();
        else if (self._op === "delete") res = self._runDelete();
        else res = self._runSelect();
      } catch (e) {
        res = { data: null, error: { message: String((e && e.message) || e), code: "MOCK", details: null, hint: null }, count: null, status: 500, statusText: "Mock error" };
      }
      /* a tick of latency, so the app's in-flight guards behave like production */
      setTimeout(function () { resolve(res); }, 0);
    });
  };
  BP.then = function (onFulfilled, onRejected) { return this._run().then(onFulfilled, onRejected); };
  BP["catch"] = function (fn) { return this._run()["catch"](fn); };
  BP["finally"] = function (fn) { return this._run()["finally"](fn); };

  /* =========================================================================
     RPCs — all computed over the fixtures above
     ======================================================================= */
  function clientName(id) {
    var c = DB.clients.filter(function (x) { return x.id === id; })[0];
    return c ? ([c.first_name, c.last_name].filter(Boolean).join(" ") || "(no name)") : "(unknown)";
  }
  function isLive(stage) { return ["completed", "not_proceeding"].indexOf(stage) === -1; }

  function rpc_my_role() { return myRole(); }

  function rpc_has_bank_details() {
    var g = function (k) { var r = DB.settings.filter(function (s) { return s.key === k; })[0]; return r ? String(r.value || "").trim() : ""; };
    return !!(g("bank_account_name") && g("bank_sort_code") && g("bank_account_number"));
  }

  /* r12b — mark_tour_seen(). SECURITY DEFINER in production, granted to
     authenticated: it may only ever touch the CALLING persona's own profiles
     row (never one named by an argument — it takes none), and only sets
     tour_seen_at the first time. A second call with it already set is a
     no-op, not a re-stamp — the first-run tour records the first run, not the
     most recent one. Returns void, exactly like the real function. */
  function rpc_mark_tour_seen() {
    var mine = DB.profiles.filter(function (p) { return p.id === CURRENT_UID; })[0];
    if (mine && mine.tour_seen_at == null) mine.tour_seen_at = iso(new Date());
    return null;
  }

  function rpc_get_briefing(args) {
    var scope = (args && args.p_scope) || "mine";
    var uid = CURRENT_UID;
    var items = [];
    var mineOk = function (owner) { return scope === "all" || owner == null || owner === uid; };

    DB.case_tasks.filter(function (t) { return !t.done_at && t.due_date; }).forEach(function (t) {
      var overdue = t.due_date < TODAY, today = t.due_date === TODAY;
      if (!overdue && !today) return;
      if (!mineOk(t.assigned_to)) return;
      var cs = DB.cases.filter(function (c) { return c.id === t.case_id; })[0];
      items.push({
        kind: overdue ? "task_overdue" : "task_today", pri: overdue ? 10 : 20,
        title: (cs ? clientName(cs.client_id) : "Task") + " — " + t.title,
        sub: overdue ? "Overdue since " + t.due_date : "Due today",
        task_id: t.id, case_id: t.case_id, client_id: cs ? cs.client_id : null, owner: t.assigned_to
      });
    });

    DB.leads.filter(function (l) { return l.status === "new"; }).forEach(function (l) {
      items.push({
        kind: "lead_new", pri: 12, title: "New website enquiry — " + l.name,
        sub: (l.enquiry_type || "general") + " · " + (l.email || l.phone || "no contact details"),
        lead_id: l.id, owner: null
      });
    });

    DB.case_emails.filter(function (e) { return e.triage_status === "new"; }).forEach(function (e) {
      var cs = DB.cases.filter(function (c) { return c.id === e.case_id; })[0];
      if (cs && !mineOk(cs.assigned_to)) return;
      items.push({
        kind: "email_new", pri: 25,
        title: "Email from " + (cs ? clientName(cs.client_id) : e.from_email),
        sub: e.subject || e.snippet || "", email_id: e.id, case_id: e.case_id,
        client_id: cs ? cs.client_id : null, owner: cs ? cs.assigned_to : null
      });
    });

    DB.appointments.filter(function (ap) { return String(ap.starts_at).slice(0, 10) === TODAY; }).forEach(function (ap) {
      if (!mineOk(ap.staff_id)) return;
      items.push({
        kind: "appt_today", pri: 15, title: ap.title,
        sub: new Date(ap.starts_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + (ap.location ? " · " + ap.location : ""),
        appt_id: ap.id, case_id: ap.case_id, client_id: ap.client_id, owner: ap.staff_id
      });
    });

    /* R43 · T1 — RATE ALERTS AND THE CASE THAT IS ALREADY THE ANSWER TO THEM.
       Production's rate_urgent block gained two rules this round (the reasoning is written out in
       full above app.js's retentionSuccessorSets — R35 §4; this is the same question asked of the
       briefing rather than of the feed, and it must answer the same way or the drawer and the
       Today briefing disagree about the same client):
         1. A SUCCESSOR case is silent while it is live. Starting a retention case copies the
            source case's rate_end_date onto the new one, so the successor is itself a case with a
            rate ending imminently — and nagging about it is nagging about the thing that is
            already being done. Once it completes it is an ordinary book case again and its own
            rate end alerts normally.
         2. A SOURCE case is silent while it HAS a live successor, for the same reason from the
            other end: the conversation is open, on a case, with an adviser.
       Prod: `(c.retention_source_case_id is null or c.stage = 'completed')` and `not exists (…
       rc.retention_source_case_id = c.id and rc.stage not in ('completed','not_proceeding'))`.
       A successor that has completed or fallen through is handling nothing and suppresses nothing.
       Also mirrored here: `stage <> 'not_proceeding'`. The mock never had it — a case the firm has
       lost was still being chased about its rate end in the briefing, which production has never
       done. */
    var liveSuccessorSourceIds = {};
    DB.cases.forEach(function (c) {
      if (!c.retention_source_case_id) return;
      if (["completed", "not_proceeding"].indexOf(c.stage) >= 0) return;
      liveSuccessorSourceIds[c.retention_source_case_id] = true;
    });
    DB.cases.forEach(function (c) {
      if (!mineOk(c.assigned_to)) return;
      if (c.rate_end_date && c.stage !== "not_proceeding"
        && (!c.retention_source_case_id || c.stage === "completed")
        && !liveSuccessorSourceIds[c.id]) {
        var days = Math.round((new Date(c.rate_end_date + "T12:00:00") - new Date(TODAY + "T12:00:00")) / DAY);
        // R47 Gate 0 — parity with the prod briefing: a rate ended more than ~18 months ago is
        // history, not a today-action, so it is not on My Day (the recovery book lives on Retention).
        if (days <= 60 && days >= -Math.round(18 * 30.44)) {
          items.push({
            kind: "rate_urgent", pri: days < 0 ? 8 : 30, days: days,
            title: clientName(c.client_id) + " — rate " + (days < 0 ? "ended " + Math.abs(days) + " days ago" : "ends in " + days + " days"),
            sub: (c.lender || "lender not set") + (c.rate_reminder_queued_at ? " · reminder sent" : " · not contacted"),
            case_id: c.id, client_id: c.client_id, owner: c.assigned_to
          });
        }
      }
      if (isLive(c.stage) && (NOW - new Date(c.updated_at)) / DAY > 45) {
        items.push({
          kind: "stalled", pri: 55, title: clientName(c.client_id) + " — nothing has happened for weeks",
          sub: "At " + c.stage + " since " + String(c.updated_at).slice(0, 10),
          case_id: c.id, client_id: c.client_id, owner: c.assigned_to
        });
      }
      if (c.stage === "completed" && c.broker_fee > 0 && ["not_requested", "requested"].indexOf(c.fee_status) >= 0) {
        items.push({
          kind: "fee_chase", pri: 40, title: clientName(c.client_id) + " — broker fee outstanding",
          sub: "£" + c.broker_fee + " · " + String(c.fee_status).replace(/_/g, " "),
          case_id: c.id, client_id: c.client_id, owner: c.assigned_to
        });
      }
      if (["application", "offer"].indexOf(c.stage) >= 0 && (c.protection_status || "not_discussed") === "not_discussed") {
        items.push({
          kind: "protection_hot", pri: 35, title: clientName(c.client_id) + " — protection not discussed",
          sub: "Case is at " + c.stage + " — record the conversation",
          case_id: c.id, client_id: c.client_id, owner: c.assigned_to
        });
      }
    });

    items.sort(function (a, b) { return a.pri - b.pri; });
    return items;
  }

  function rpc_get_reports() {
    var yr = NOW.getFullYear();
    /* M5 — fees_banked_ytd keys on the per-type broker cash date where the
       migration has landed, falling back to the legacy single date. Every other
       branch (and the role guard) is unchanged. */
    var cashDate = function (c) {
      return (MIGRATIONS.m2 && MIGRATIONS.m5 && c.broker_fee_paid_at) || c.fee_paid_at || null;
    };
    var advisers = DB.profiles.filter(function (p) { return ["owner", "admin", "adviser", "staff"].indexOf(p.role) >= 0; }).map(function (p) {
      return {
        staff_id: p.id, name: p.full_name,
        overdue_tasks: DB.case_tasks.filter(function (t) { return t.assigned_to === p.id && !t.done_at && t.due_date && t.due_date < TODAY; }).length,
        fees_banked_ytd: Math.round(DB.cases.filter(function (c) {
          var d = cashDate(c);
          return c.assigned_to === p.id && d && new Date(d).getFullYear() === yr;
        }).reduce(function (s, c) { return s + Number(c.broker_fee || 0); }, 0))
      };
    });
    var ltvMap = {};
    DB.cases.filter(function (c) { return c.stage === "completed"; }).forEach(function (c) {
      var v = ltvMap[c.client_id] || (ltvMap[c.client_id] = { client_id: c.client_id, name: clientName(c.client_id), cases: 0, ltv: 0 });
      v.cases++;
      v.ltv += Number(c.proc_fee || 0) + Number(c.broker_fee || 0) + Number(c.sols_fee || 0);
    });
    var ltv = Object.keys(ltvMap).map(function (k) { return ltvMap[k]; })
      .sort(function (a, b) { return b.ltv - a.ltv; }).slice(0, 20);
    return { advisers: advisers, client_ltv: ltv };
  }

  function rpc_get_data_quality() {
    var liveClientIds = {};
    DB.cases.forEach(function (c) { if (isLive(c.stage)) liveClientIds[c.client_id] = true; });
    var missingEmail = DB.clients.filter(function (c) { return !c.email && liveClientIds[c.id]; })
      .map(function (c) { return { id: c.id, name: clientName(c.id) }; });
    var liveUnassigned = DB.cases.filter(function (c) { return isLive(c.stage) && !c.assigned_to; })
      .map(function (c) { return { case_id: c.id, name: clientName(c.client_id), stage: c.stage }; });
    var noFee = DB.cases.filter(function (c) { return c.stage === "completed" && !(Number(c.broker_fee) > 0) && !(Number(c.proc_fee) > 0); })
      .map(function (c) { return { case_id: c.id, name: clientName(c.client_id) }; });
    var stuck = DB.email_queue.filter(function (e) { return e.status === "queued" && (NOW - new Date(e.created_at)) / DAY > 1; }).length;
    var sendingLive = DB.email_queue.some(function (e) { return e.status === "sent" && (NOW - new Date(e.sent_at || e.created_at)) / DAY < 7; });
    return {
      clients_total: DB.clients.length,
      missing_email: missingEmail.slice(0, 300),
      missing_email_count: DB.clients.filter(function (c) { return !c.email; }).length,
      missing_phone_count: DB.clients.filter(function (c) { return !c.phone; }).length,
      live_unassigned: liveUnassigned,
      completed_missing_fee: noFee,
      /* R45 — full parity with prod get_data_quality: tracker/variable deals have no fixed end;
         a retention successor inherits its source's date question; a record with no loan and no
         mortgage account number is not a mortgage; and a completed deal SUPERSEDED by a newer
         completed deal on the same property (same client) has had its rate-end cleared on
         purpose — the back-book import writes exactly that shape. */
      completed_missing_rate_end: DB.cases.filter(function (c) {
        if (c.stage !== "completed" || c.rate_end_date) return false;
        var rt = String(c.rate_type || "");
        if (rt === "tracker" || rt === "variable") return false;
        if (c.retention_source_case_id) return false;
        if (c.loan_amount == null && !c.mortgage_account_number) return false;
        var key = String(c.property_address || "").toLowerCase().replace(/[^a-z0-9]/g, "");
        /* Prod's `n.completed_at > c.completed_at` is NULL (not true) when c has no date — an
           undated completion is never treated as superseded. Guard it, or "" string-compares as
           older than everything. */
        if (key && c.completed_at && DB.cases.some(function (n) {
          return n.id !== c.id && n.client_id === c.client_id && n.stage === "completed" &&
            String(n.property_address || "").toLowerCase().replace(/[^a-z0-9]/g, "") === key &&
            String(n.completed_at || "") > String(c.completed_at || "");
        })) return false;
        return true;
      }).length,
      emails_failed: DB.email_queue.filter(function (e) { return e.status === "failed"; }).length,
      emails_stuck: stuck,
      emails_sending_live: sendingLive
    };
  }

  function rpc_get_protection_pipeline() {
    var avg = Number((DB.settings.filter(function (s) { return s.key === "protection_avg_commission"; })[0] || {}).value) || 850;
    return DB.cases.filter(function (c) {
      if (c.stage === "not_proceeding") return false;
      var p = c.protection_status || "not_discussed";
      /* R66 · M6a — `referred` is the fourth OPEN protection state (the case has been handed to a
         protection adviser; no policy, no decline), so the pipeline returns it alongside the other
         three. Production's get_protection_pipeline needs the identical one-value widening —
         without it a referred case would drop off the Protection page entirely the moment the
         status is set, which is the opposite of what recording the referral is for. */
      return ["not_discussed", "discussed", "quoted", "referred"].indexOf(p) >= 0;
    }).map(function (c) {
      var cl = DB.clients.filter(function (x) { return x.id === c.client_id; })[0] || {};
      var p = c.protection_status || "not_discussed";
      /* Weighted between discussed and quoted: a referral is more likely to end in a policy than a
         conversation nobody has quoted, and less likely than a quote already in the client's hands
         — and the commission, if it lands, is not wholly this firm's anyway. */
      var weight = p === "quoted" ? 0.7 : p === "referred" ? 0.5 : p === "discussed" ? 0.4 : 0.2;
      return {
        case_id: c.id, client_id: c.client_id, client_name: clientName(c.client_id),
        case_kind: c.case_kind, stage: c.stage, lender: c.lender,
        loan_amount: c.loan_amount, protection_status: p, gi_status: c.gi_status || "not_discussed",
        est_commission: Math.round(avg * weight), owner: c.assigned_to,
        live: isLive(c.stage), has_email: !!cl.email
      };
    }).sort(function (a, b) { return b.est_commission - a.est_commission; });
  }

  function rpc_find_duplicate_clients() {
    var pairs = [], seen = {};
    var push = function (a, b, reason, score) {
      var k = [a.id, b.id].sort().join("|");
      if (seen[k]) return;
      seen[k] = true;
      pairs.push({
        a_id: a.id, a_name: clientName(a.id), a_email: a.email,
        b_id: b.id, b_name: clientName(b.id), b_email: b.email,
        reason: reason, score: score
      });
    };
    var byEmail = {}, byPhone = {}, byName = {};
    DB.clients.forEach(function (c) {
      if (c.email) {
        var e = String(c.email).trim().toLowerCase();
        (byEmail[e] = byEmail[e] || []).push(c);
      }
      var p = normPhone(c.phone).replace(/\D/g, "");
      if (p.length >= 10) (byPhone[p] = byPhone[p] || []).push(c);
      var n = (String(c.first_name || "") + " " + String(c.last_name || "")).toLowerCase().replace(/[^a-z ]/g, "").split(/\s+/).filter(Boolean).sort().join(" ");
      if (n) (byName[n] = byName[n] || []).push(c);
    });
    Object.keys(byEmail).forEach(function (k) {
      var g = byEmail[k];
      for (var i = 0; i < g.length; i++) for (var j = i + 1; j < g.length; j++) push(g[i], g[j], "same email address", 0.95);
    });
    Object.keys(byPhone).forEach(function (k) {
      var g = byPhone[k];
      for (var i = 0; i < g.length; i++) for (var j = i + 1; j < g.length; j++) push(g[i], g[j], "same phone number", 0.72);
    });
    Object.keys(byName).forEach(function (k) {
      var g = byName[k];
      for (var i = 0; i < g.length; i++) for (var j = i + 1; j < g.length; j++) push(g[i], g[j], "same name", 0.8);
    });
    return pairs.sort(function (a, b) { return b.score - a.score; });
  }

  /* -------------------------------------------------------------------------
     R5-M6 · reassign_holdings(p_from, p_to) -> jsonb {cases, tasks, appointments}

     Production shape mirrored: SECURITY DEFINER, Owner-only via is_owner(), and
     ONE transaction that moves exactly the three scopes openDeactivate()'s
     pre-flight promises — LIVE cases (never completed / not_proceeding, because
     every report that reads assigned_to is a historical record), tasks that are
     still open, and appointments that have not happened yet. It returns a tally
     of what it moved, which the caller prints instead of its own estimate.

     "Atomic" here means: every precondition is checked and every row that will
     move is collected BEFORE a single row is written, and the writes cannot then
     fail part-way — so there is no half-done state for the caller to compensate
     for. A refusal or a bad argument writes nothing at all.                     */
  function rpc_reassign_holdings(args) {
    var from = (args && (args.p_from || args.from_id)) || null;
    var to = (args && (args.p_to || args.to_id)) || null;
    /* is_owner() — an Admin or an Adviser gets the same refusal production gives
       them. Deliberately NOT worded "does not exist": app.js treats that phrase
       as "the migration is missing" and would silently take the fallback. */
    if (!isOwner()) {
      throw pgErrorThrow('permission denied for function reassign_holdings', "42501");
    }
    if (!from || !to) throw pgErrorThrow("reassign_holdings: p_from and p_to are both required", "22004");
    if (from === to) throw pgErrorThrow("reassign_holdings: p_from and p_to must be different people", "P0001");
    var target = DB.profiles.filter(function (p) { return p.id === to; })[0];
    if (!target) {
      throw pgErrorThrow('insert or update on table "cases" violates foreign key constraint "cases_assigned_to_fkey"', "23503");
    }
    var nowIso = iso(new Date());
    /* collect first, write second — nothing is touched until every scope is known */
    var cases = DB.cases.filter(function (c) { return c.assigned_to === from && isLive(c.stage); });
    var tasks = DB.case_tasks.filter(function (t) { return t.assigned_to === from && !t.done_at; });
    var appts = DB.appointments.filter(function (a) { return a.staff_id === from && a.starts_at >= nowIso; });
    cases.forEach(function (c) {
      var before = clone(c);
      c.assigned_to = to;
      c.updated_at = nowIso;
      auditRow("cases", "update", c, { assigned_to: { old: from, new: to } });
      caseEventsForUpdate(before, c);
    });
    tasks.forEach(function (t) { t.assigned_to = to; });
    appts.forEach(function (a) { a.staff_id = to; });
    return { cases: cases.length, tasks: tasks.length, appointments: appts.length };
  }

  var RPCS = {
    my_role: rpc_my_role,
    /* R5-M6 — the atomic handover behind openDeactivate()'s RPC-first path */
    reassign_holdings: rpc_reassign_holdings,
    has_bank_details: rpc_has_bank_details,
    get_briefing: rpc_get_briefing,
    get_reports: rpc_get_reports,
    get_data_quality: rpc_get_data_quality,
    get_protection_pipeline: rpc_get_protection_pipeline,
    find_duplicate_clients: rpc_find_duplicate_clients,
    run_watchtower: runWatchtower,
    /* The two SECURITY DEFINER queueing functions process-emails calls before it flushes. They
       exist in production as public functions; exposing them here lets the Run-automation-now
       button queue FIRST and then ask permission for the real number (G1I-Q1), instead of naming
       the rows already in the queue and sending those plus everything the flush creates. */
    queue_automated_emails: function () { return queueAutomatedEmails(); },
    queue_comms_extras: function () { return queueCommsExtras(); },
    /* r12b — first-run tour ack. See rpc_mark_tour_seen() for the guard. */
    mark_tour_seen: function () { return rpc_mark_tour_seen(); }
  };

  function rpcCall(name, args) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var fn = RPCS[name];
        /* Either the function was never mocked, or its migration is switched off. */
        if (!fn || functionIsMissing(name)) {
          resolve({ data: null, error: pgError('function public.' + name + '() does not exist', "42883"), status: 404 });
          return;
        }
        try {
          resolve({ data: fn(args || {}), error: null, status: 200, count: null });
        } catch (e) {
          /* a raise inside the function body keeps its SQLSTATE (and rolls back —
             which costs nothing here, because a refusing RPC writes nothing) */
          if (e && e.__pg) { resolve({ data: null, error: e.__pg, status: 400 }); return; }
          resolve({ data: null, error: { message: String((e && e.message) || e), code: "MOCK" }, status: 500 });
        }
      }, 0);
    });
  }

  /* =========================================================================
     AUTH
     ======================================================================= */
  var authListeners = [];
  function session() {
    var p = me();
    if (!p) return null;
    return {
      access_token: "mock-access-token-" + p.id,
      refresh_token: "mock-refresh-" + p.id,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: {
        id: p.id, aud: "authenticated", role: "authenticated", email: p.email,
        email_confirmed_at: iso(shift(-300)), created_at: iso(shift(-400)),
        app_metadata: { provider: "email" },
        user_metadata: { full_name: p.full_name }
      }
    };
  }
  var SIGNED_OUT = false;
  var auth = {
    getSession: function () {
      return Promise.resolve({ data: { session: SIGNED_OUT ? null : session() }, error: null });
    },
    getUser: function () {
      var s = SIGNED_OUT ? null : session();
      return Promise.resolve({ data: { user: s ? s.user : null }, error: null });
    },
    onAuthStateChange: function (cb) {
      authListeners.push(cb);
      setTimeout(function () { try { cb("INITIAL_SESSION", SIGNED_OUT ? null : session()); } catch (e) { } }, 0);
      return { data: { subscription: { id: "mock-sub", unsubscribe: function () { authListeners = []; } } }, error: null };
    },
    signInWithPassword: function (creds) {
      var email = String((creds && creds.email) || "").toLowerCase();
      var p = DB.profiles.filter(function (x) { return String(x.email).toLowerCase() === email; })[0];
      if (!p) {
        return Promise.resolve({ data: { user: null, session: null }, error: { message: "Invalid login credentials", status: 400 } });
      }
      CURRENT_UID = p.id; SIGNED_OUT = false;
      var s = session();
      authListeners.forEach(function (cb) { try { cb("SIGNED_IN", s); } catch (e) { } });
      return Promise.resolve({ data: { user: s.user, session: s }, error: null });
    },
    signOut: function () {
      SIGNED_OUT = true;
      authListeners.forEach(function (cb) { try { cb("SIGNED_OUT", null); } catch (e) { } });
      return Promise.resolve({ error: null });
    },
    resetPasswordForEmail: function () { return Promise.resolve({ data: {}, error: null }); },
    updateUser: function () { return Promise.resolve({ data: { user: session() ? session().user : null }, error: null }); },
    refreshSession: function () { return Promise.resolve({ data: { session: session() }, error: null }); }
  };

  /* =========================================================================
     STORAGE — `offers` (offer-letter PDFs), `client-docs` (R12a·D8 / R13,
     the checklist files a client sends back through their upload link, and
     the case_files staff-uploaded blobs — see "R13 · case_files" below), and
     `web` (unused by anything the mock exercises).
     `storage.from(bucket)` below is bucket-name-agnostic by construction — it
     was written once for `offers` and never validates the bucket string — so
     no code change was needed to make a second/third bucket work; what WAS
     missing was any seeded content to open. See the fixture block (search
     "R12a·D8 — seed real storage content") for the checklist files that have
     a real entry in `storageFiles`, so `createSignedUrl` on them exercises
     the same path a genuine upload would have taken, not just an empty path
     string with nothing behind it. Semantics are identical across buckets:
     `createSignedUrl` does not check that the object exists (same looseness
     `offers` already had — not something this pass introduces or tightens),
     so a test asserting an open-link flow has to do it via the encoded
     fragment URL / `storageFiles` entry, not via actually fetching it.
     R13 · BUCKET CORRECTION — production's bucket is `client-docs`, not
     `case-documents` as R12a shipped it here. `storage.from()` itself needed
     no code change (it was always bucket-name-agnostic); what moved is every
     piece of fixture content keyed into `storageFiles`, and the doc-upload
     stub below, which now writes storage_path WITH the "client-docs/" prefix
     — see DOC_STORAGE_BUCKET and the file banner at the top of this file.
     ======================================================================= */
  var storage = {
    from: function (bucket) {
      return {
        upload: function (path, file, opts) {
          storageFiles[bucket + "/" + path] = { size: file && file.size, type: (opts && opts.contentType) || "application/pdf", at: iso(NOW) };
          return Promise.resolve({ data: { path: path, id: nid("ob"), fullPath: bucket + "/" + path }, error: null });
        },
        createSignedUrl: function (path, expires) {
          return Promise.resolve({
            data: { signedUrl: "about:blank#mock-signed-url/" + encodeURIComponent(bucket + "/" + path) + "?expires=" + expires },
            error: null
          });
        },
        download: function () { return Promise.resolve({ data: new Blob([""], { type: "application/pdf" }), error: null }); },
        remove: function (paths) {
          (paths || []).forEach(function (p) { delete storageFiles[bucket + "/" + p]; });
          return Promise.resolve({ data: [], error: null });
        },
        getPublicUrl: function (path) { return { data: { publicUrl: "about:blank#mock-public/" + encodeURIComponent(path) } }; },
        list: function () { return Promise.resolve({ data: [], error: null }); }
      };
    }
  };

  /* =========================================================================
     EDGE FUNCTIONS — window.fetch stub
     ======================================================================= */
  var SUPABASE_HOST_RE = /^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/([a-z0-9-]+)/i;
  function jsonResponse(body, status) {
    var text = JSON.stringify(body);
    return {
      ok: (status || 200) < 400,
      status: status || 200,
      statusText: (status || 200) < 400 ? "OK" : "Error",
      headers: { get: function (k) { return String(k).toLowerCase() === "content-type" ? "application/json" : null; } },
      json: function () { return Promise.resolve(JSON.parse(text)); },
      text: function () { return Promise.resolve(text); },
      clone: function () { return jsonResponse(body, status); }
    };
  }
  /* -------------------------------------------------------------------------
     process-emails v8 — PLAN-R5 Batch 1 + § Harness fixes 4

     Three things the old two-line stub did not model, and whose absence made
     round-4 findings unreadable:
       1. queue_automated_emails() — production calls this SECURITY DEFINER RPC
          on every unscoped run and it AUTO-CREATES retention successor cases.
          R5-6's "nothing creates these" was a harness illusion, not a backend
          gap. Mirrored here, including the real gap: a rate that has ALREADY
          ended is never picked up (that's what the manual button is for).
       2. queue_comms_extras() — review requests etc. Both queueing steps are
          SKIPPED when the caller scopes the run with queue_ids, which is what
          makes a per-case "Send reminder" stop flushing the firm's queue.
       3. compose() — per-adviser From/Reply-To/phone/sign-off, read from
          profiles. v7 filtered `profiles.role = 'staff'`, a pre-round-4 value
          that matches zero rows, so every email signed off with the firm-wide
          settings.adviser_name. Fixed here the same way v8 fixes it in prod.
     ----------------------------------------------------------------------- */
  function setting(k, dflt) {
    var r = DB.settings.filter(function (s) { return s.key === k; })[0];
    var v = r ? String(r.value == null ? "" : r.value).trim() : "";
    return v === "" ? (dflt === undefined ? "" : dflt) : v;
  }
  /* v8 staff lookup — owner/admin/adviser/staff, not the stale 'staff'-only filter */
  function staffProfile(id) {
    if (!id) return null;
    var p = DB.profiles.filter(function (x) { return x.id === id; })[0];
    if (!p || ["owner", "admin", "adviser", "staff"].indexOf(p.role) === -1) return null;
    return p;
  }
  /* R6.4 MOCK PARITY (b) — how each email type names the property, mirroring the
     templates production redeployed today.
       "sentence" — the address belongs INSIDE the first line, because the mail is
                    about that mortgage: "your mortgage on 63 Malvern Road…".
       "regarding" — the mail is about something adjacent (a protection quote, a
                    fee, a GI renewal), so a standalone "Regarding: <address>" line
                    identifies the case without bending the opening sentence.
     A type that is in neither list, and any case with no address at all, is left
     WORD-FOR-WORD as it was: this feature adds a mention, it does not reword the
     firm's existing emails. */
  var PROP_SENTENCE_TYPES = ["rate_end_reminder", "rate_end_chase", "submitted_update", "offer_update", "completion_congrats"];
  /* R12a·D3 — v12 adds "factfind" here: "Regarding: <property>" is the same
     mechanism every other adjacent-to-the-mortgage mail already uses, not a
     bespoke line of its own. */
  var PROP_REGARDING_TYPES = ["protection_offer", "fee_request", "gi_exchange", "factfind"];
  /* The opening line each type sends. "{M}" is the subject of the sentence: with
     an address it becomes "your mortgage on <full address>", without one it stays
     "your mortgage" — which is the wording every one of these emails has always
     had, unchanged, so a case with no address reads exactly as it did before. */
  var EMAIL_OPENING = {
    rate_end_reminder: "I'm getting in touch because the rate on {M} is coming to an end.",
    rate_end_chase: "Following up on my last message about {M} — the rate is still due to end shortly.",
    submitted_update: "A quick update: the application for {M} has now gone to the lender.",
    offer_update: "Good news — the mortgage offer for {M} has come through.",
    completion_congrats: "Congratulations — {M} has completed today.",
    protection_offer: "While we were arranging your mortgage we talked about protecting the payments.",
    fee_request: "Please find below the details for our advice fee.",
    gi_exchange: "Now that you are exchanging, this is the point at which buildings insurance needs to be in place.",
    /* R9 — the three types round 9 composes. The docs_request opening is the v10
       wording, WORD FOR WORD: a case with no checklist must read exactly as it
       did before this round, and only the list underneath it changes. */
    docs_request: "Before we can get your application moving we need a few documents from you.",
    docs_chase: "Just a quick reminder — we are still waiting on some documents before your application can move on.",
    review_reminder: "A little while ago I asked how we did. If you have a spare minute, a short review really does help us."
  };
  /* R9 — the document checklist as the email templates see it. Empty whenever
     the migration is not there, which is what makes "checklist-aware" degrade to
     "exactly the email we sent before" on an un-migrated database rather than to
     an email with an empty list in it. */
  var DOC_TYPES = ["docs_request", "docs_chase"];
  function caseChecklist(caseId) {
    if (!MIGRATIONS.m10 || !caseId) return [];
    return DB.case_documents.filter(function (d) { return d.case_id === caseId; });
  }
  function outstandingDocs(caseId) {
    return caseChecklist(caseId).filter(function (d) { return d.status === "requested"; });
  }
  /* ---- r9 · what the DEPLOYED doc-upload enforces on a file --------------
     Kept beside the checklist helpers rather than inside the handler so the
     limits are readable in one place and the test hooks below can reach them.
     The extension list is the contract's, in the contract's order. */
  /* R13 · BUCKET CORRECTION — the slug half of production's
     `<caseId>/<slug>-<ts>.<ext>` storage path. Lowercased, non-alphanumeric
     runs collapsed to one hyphen, leading/trailing hyphens trimmed. */
  function slugify(s) {
    return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "file";
  }
  var DOC_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
  var DOC_UPLOAD_EXT = ["pdf", "jpg", "jpeg", "png", "heic", "heif"];
  var DOC_UPLOAD_RATE_CAP = 20;          /* uploads per link per rolling minute */
  var DOC_UPLOAD_HITS = {};              /* token -> [timestamps] */
  var DOC_UPLOAD_FAIL_STORAGE = false;   /* armed by __mock.failDocStorageOnce() */
  /* The first bytes of the file, as a plain array. Files arrive from a real
     <input type=file> in the harness, so this is genuine content, not a
     declared type — which is the whole point of checking it. */
  function docUploadHead(file) {
    try {
      if (typeof file.slice === "function" && typeof Blob !== "undefined") {
        return Promise.resolve(file.slice(0, 16).arrayBuffer()).then(function (buf) {
          return Array.prototype.slice.call(new Uint8Array(buf));
        }).catch(function () { return []; });
      }
    } catch (e) { /* fall through */ }
    return Promise.resolve([]);
  }
  /* Magic bytes, per accepted extension. An extension is something the caller
     chooses; these are what is actually in the file. An empty head (a runtime
     that could not read the blob) is allowed through rather than refused —
     failing closed here would reject every upload on an older browser over a
     check that is a second line of defence, not the first. */
  function docBytesMatch(ext, h) {
    if (!h || !h.length) return true;
    var starts = function (sig) { return sig.every(function (b, i) { return h[i] === b; }); };
    if (ext === "pdf") return starts([0x25, 0x50, 0x44, 0x46]);                        /* %PDF */
    if (ext === "jpg" || ext === "jpeg") return starts([0xff, 0xd8, 0xff]);
    if (ext === "png") return starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (ext === "heic" || ext === "heif") {
      /* ISO-BMFF: a 4-byte box length, then "ftyp", then the brand. */
      return h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70;
    }
    return true;
  }
  /* The client's upload link. Built from site_url + the case's own token, so a
     case whose checklist predates the token (or a database without m10) gets the
     list of items and no link — which is the state the firm was in yesterday,
     and still has to read properly. */
  function docsLinkFor(cs) {
    var token = (MIGRATIONS.m10 && cs && cs.doc_token) ? String(cs.doc_token) : "";
    if (!token) return null;
    var base = setting("site_url", "https://www.nexmoney.co.uk").replace(/\/+$/, "");
    return base + "/docs.html?token=" + token;
  }
  /* The firm-wide list from Settings — the v10 behaviour, and still the right
     answer for a case nobody has built a checklist on. */
  function settingsDocsList() {
    return String(setting("docs_list", "")).split("|")
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
  }
  function emailBodyLines(type, addr, mention, cs) {
    var opening = EMAIL_OPENING[type];
    if (!opening) return null;                      // a type this stub does not compose
    var lines = [];
    if (mention === "regarding") lines.push("Regarding: " + addr);
    lines.push(opening.replace("{M}", mention === "sentence" ? "your mortgage on " + addr : "your mortgage"));
    /* R9 — THE CHECKLIST-AWARE HALF. With a checklist on the case the mail lists
       ONLY what is still missing: a client who has already sent their passport
       and is asked for it again a second time reasonably concludes we lost it.
       With no checklist it falls back to the firm's static docs_list, which is
       the wording (and the whole list, every time) that v10 sent. */
    if (DOC_TYPES.indexOf(type) >= 0) {
      var chk = caseChecklist(cs && cs.id);
      var items = chk.length
        ? outstandingDocs(cs.id).map(function (d) { return d.item; })
        : settingsDocsList();
      if (items.length) {
        lines.push(chk.length ? "Still outstanding:" : "Please send:");
        items.forEach(function (it) { lines.push("· " + it); });
      }
      var link = chk.length ? docsLinkFor(cs) : null;
      if (link) lines.push("You can upload them here: " + link);
    }
    return lines;
  }
  /* =========================================================================
     R12a·D3 — process-emails v12: the digital fact-find link as a real queued
     email ("factfind"), replacing the admin's own bare mailto. Mirrors the
     DEPLOYED v12 behaviour exactly — everything else about v12 is byte-
     identical to v11 (EMAIL_OPENING/DOC_TYPES/emailBodyLines above are
     untouched).

     A token generator for a fact_finds row created HERE, server-side (the
     service role, same as doc-upload) — analogous to app.js's own ffToken(),
     which only ever runs client-side and has no reason to exist in this file
     otherwise. */
  function ffTokenServerSide() {
    return "ff-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
  /* The case's newest fact_finds row (created_at desc, limit 1) — the same
     "active" row the admin's own factFind() reads and reuses. If none exists
     yet, ONE IS INSERTED here: {case_id, client_id (the queue row's, falling
     back to the case's — a service-role write has only the queue row and the
     case to go on), status: "created"}. status "created" is what pass B's
     client-side factFind() now inserts explicitly rather than relying on a
     column default, and fact_finds carries NO check constraint on status in
     production (verified against the real schema) or in this mock — nothing
     here or in writePolicy() rejects it. */
  function resolveFactFindForEmail(row, cs) {
    var caseId = row.case_id;
    if (!caseId) return null;
    var existing = DB.fact_finds.filter(function (f) { return f.case_id === caseId; })
      .slice()
      .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); });
    if (existing.length) return existing[0];
    var clientId = row.client_id || (cs && cs.client_id) || null;
    var created = applyInsertDefaults("fact_finds", {
      case_id: caseId, client_id: clientId, status: "created", token: ffTokenServerSide(),
      created_by: null /* the service role wrote it, not a member of staff */
    });
    DB.fact_finds.push(created);
    return created;
  }
  /* The CTA body. The leading "Regarding: <addr>" line follows the exact same
     rule emailBodyLines() applies to every other REGARDING type — `factfind`
     having joined PROP_REGARDING_TYPES above is what makes `mention` arrive
     here already resolved, not a second copy of that decision. */
  function factfindBodyLines(mention, addr, link) {
    var lines = [];
    if (mention === "regarding") lines.push("Regarding: " + addr);
    lines.push("Before we speak, please could you complete this short, secure fact-find? It takes about 5–10 minutes.");
    lines.push("Start your fact-find → " + link);
    lines.push("You can save as you go and come back to finish it later.");
    return lines;
  }
  /* THE THROW. No site_url configured means no link can be built at all — v12
     raises rather than send a mail with nothing to click, and
     "process-emails" below turns that into status='failed' with this EXACT
     message on the row, which is what a misconfigured install is meant to
     see, not have quietly swallowed. Deliberately no fallback default here
     (unlike docsLinkFor's, which is a pre-existing, unrelated convenience for
     the docs bucket) — v12's own rule is "not set = throw", and mirroring a
     default in would hide exactly the misconfiguration this exists to catch. */
  function composeFactfind(row, cs) {
    var ff = resolveFactFindForEmail(row, cs);
    var siteUrlRaw = String(setting("site_url", "")).trim();
    if (!ff || !siteUrlRaw) {
      throw new Error("site_url not set — cannot build the fact-find link");
    }
    var base = siteUrlRaw.replace(/\/+$/, "");
    var link = base + "/factfind?token=" + ff.token;
    var company = setting("company_name", "NexMoney");
    return {
      subject: company + " – your mortgage fact find (5–10 minutes)",
      link: link,
      fact_find_id: ff.id,
      fact_find_token: ff.token
    };
  }
  function composeEmail(row) {
    var cs = row.case_id ? DB.cases.filter(function (c) { return c.id === row.case_id; })[0] : null;
    var adv = staffProfile(cs && cs.assigned_to);
    var advPhone = (MIGRATIONS.m1 && adv && adv.phone) || null;
    var advSignoff = (MIGRATIONS.m1 && adv && adv.email_signoff) || null;
    var name = (adv && adv.full_name) || setting("adviser_name", "Daniel Potts");
    var phone = advPhone || setting("adviser_phone", "");
    /* R6.4 MOCK PARITY (b) — the property mention. `property_address` is the FULL
       address in both shapes; the app never shortens it in an email, because the
       client is being asked to recognise their own house. */
    var addr = (MIGRATIONS.m7 && cs && cs.property_address) ? String(cs.property_address).trim() : "";
    var t = row.email_type;
    var mention = "";
    if (addr && PROP_SENTENCE_TYPES.indexOf(t) >= 0) mention = "sentence";
    else if (addr && PROP_REGARDING_TYPES.indexOf(t) >= 0) mention = "regarding";
    /* R12a·D3 — factfind's subject/body/link come from a side read (and maybe
       a side WRITE) of fact_finds, not from EMAIL_OPENING. This runs BEFORE
       the object below is built, and can throw (composeFactfind's THROW
       comment) — deliberately, so that throw propagates out of composeEmail()
       untouched for "process-emails" to catch, exactly like a real function
       invocation failing before it returns anything. */
    var ffCompose = t === "factfind" ? composeFactfind(row, cs) : null;
    return {
      queue_id: row.id,
      to_email: row.to_email,
      email_type: row.email_type,
      /* Null on every type except factfind: those are display-only via the
         row's own `subject` column, set once at queue time — v12 is the only
         type where compose() itself decides the subject. */
      /* R66 · M8 — a `custom` row's subject is the ADVISER's, written at queue time and carried on
         the row's own column; v17 does not compose one. (factfind is the other exception, for the
         opposite reason: there compose() is the only thing that knows the subject.) */
      subject: ffCompose ? ffCompose.subject : (t === "custom" ? (row.subject || null) : null),
      /* R66 · M8 — and the body. v17 wraps this HTML in the house template and appends the sign-off
         below; it is passed through verbatim, never re-escaped and never reworded — the escaping
         happened once, in the app, before the row was written. Null on every other type, whose
         body is composed from body_lines above. */
      body_html: t === "custom" ? (row.body_html || null) : null,
      from: name + " <" + setting("from_email", "hello@nexmoney.co.uk") + ">",
      reply_to: (adv && adv.email) || setting("reply_to_email", "hello@nexmoney.co.uk"),
      adviser_id: adv ? adv.id : null,
      adviser_name: name,
      adviser_phone: phone || null,
      phone_line: phone ? " or call " + phone : "",
      /* Null, not "", where there is no address: "this email does not mention a
         property" and "it mentions an empty one" are different facts. */
      property_address: addr || null,
      property_mention: mention || null,
      /* The words that actually go out, so a test asserts the sentence a client
         reads rather than a flag about it. */
      property_line: mention === "regarding" ? "Regarding: " + addr : null,
      property_phrase: mention === "sentence" ? "your mortgage on " + addr : null,
      body_lines: ffCompose ? factfindBodyLines(mention, addr, ffCompose.link) : emailBodyLines(t, addr, mention, cs),
      /* R9 — what the document mails actually asked for, so a test can assert the
         list a client reads rather than a flag about it. Null on every type that
         is not about documents: "this mail carries no checklist" and "it carries
         an empty one" are different facts. */
      checklist_source: DOC_TYPES.indexOf(t) >= 0 ? (caseChecklist(cs && cs.id).length ? "case" : "settings") : null,
      checklist_items: DOC_TYPES.indexOf(t) >= 0
        ? (caseChecklist(cs && cs.id).length ? outstandingDocs(cs.id).map(function (d) { return d.item; }) : settingsDocsList())
        : null,
      docs_link: DOC_TYPES.indexOf(t) >= 0 && caseChecklist(cs && cs.id).length ? docsLinkFor(cs) : null,
      /* R12a·D3 — the fact-find row this send resolved (created if it did not
         already exist) and the link built from its token, so a test can
         assert the exact link a client would click, and process-emails below
         can advance that row's status after a successful send without
         re-deriving it. Null on every type but factfind. */
      fact_find_id: ffCompose ? ffCompose.fact_find_id : null,
      fact_find_link: ffCompose ? ffCompose.link : null,
      signoff: advSignoff ? String(advSignoff).split("\n") : [name, setting("company_name", "NexMoney")].concat(phone ? [phone] : []),
      signoff_source: advSignoff ? "profile" : (adv ? "adviser_name" : "settings")
    };
  }
  function hasRetentionSuccessor(caseId) {
    /* R58 — CYCLE-AWARE, mirroring production's new gate: only a successor whose rate_end_date
       matches the source's CURRENT rate_end_date blocks (a successor copies the date at creation,
       so same date = same product cycle). A source that was "renewed elsewhere" gets a new date
       and becomes eligible again even though an old-cycle successor exists. */
    var src = DB.cases.filter(function (x) { return x.id === caseId; })[0];
    var srcDate = src ? (src.rate_end_date || null) : null;
    return DB.cases.some(function (c) {
      return c.retention_source_case_id === caseId && (c.rate_end_date || null) === srcDate;
    });
  }
  function queueRow(o) {
    var row = applyInsertDefaults("email_queue", o);
    DB.email_queue.push(row);
    return row;
  }
  /* R6.4 MOCK PARITY (a) — the first line of a property address, which is what a
     task title has room for: "Flat 4, 27 Stourwood Avenue, Southbourne,
     Bournemouth BH6 3QP" → "Flat 4". Production splits on the first comma the
     same way. */
  function firstAddrLine(addr) {
    var s = String(addr == null ? "" : addr).trim();
    if (!s) return "";
    return s.split(",")[0].trim() || s;
  }
  /* public.queue_automated_emails() */
  function queueAutomatedEmails() {
    var out = { retention_cases_created: 0, rate_reminders_queued: 0, rate_end_chases_queued: 0, retention_tasks_created: 0, sms_queued: 0 };
    var months = Number(setting("rate_reminder_months", "6")) || 6;
    var windowEnd = dateOnly(new Date(NOW.getFullYear(), NOW.getMonth() + months, NOW.getDate()));
    DB.cases.filter(function (c) {
      return c.stage === "completed" && c.rate_end_date && !c.rate_reminder_queued_at &&
        /* the production gap, faithfully: an already-ended rate is out of window */
        c.rate_end_date >= TODAY && c.rate_end_date <= windowEnd && !hasRetentionSuccessor(c.id);
    }).slice().forEach(function (src) {
      var cl = DB.clients.filter(function (x) { return x.id === src.client_id; })[0] || {};
      var when = iso(new Date());
      /* R6.4 MOCK PARITY (a) — production's queue_automated_emails() was redeployed
         today to carry the security property across to the successor and to NAME it
         in the two artefacts a person actually reads (the call task and the origin
         note). The mock's successor was born property-less, so the harness was
         asserting the bug the backend had just stopped having. Gated on m7 because
         a database without the column has nothing to copy. */
      var srcAddr = (MIGRATIONS.m7 && src.property_address) ? String(src.property_address) : "";
      var succ = applyInsertDefaults("cases", {
        client_id: src.client_id,
        case_kind: src.case_kind === "buy_to_let" ? "buy_to_let" : "remortgage",
        stage: "enquiry",
        lender: src.lender, product_name: src.product_name,
        loan_amount: src.loan_amount, property_value: src.property_value,
        rate_percent: src.rate_percent, rate_type: src.rate_type,
        rate_end_date: src.rate_end_date, rate_end_estimated: !!src.rate_end_estimated,
        erc_end_date: src.erc_end_date, term_years: src.term_years,
        property_address: srcAddr || null,
        lead_source: "Repeat client", assigned_to: src.assigned_to,
        retention_source_case_id: src.id
      });
      DB.cases.push(succ);
      /* SECURITY DEFINER: the audit actor is the system, not the signed-in user */
      auditRow("cases", "insert", succ, clone(succ), when, null);
      caseEvent(succ.id, "case_created", "Stage: enquiry", when, null);
      /* R6.4 MOCK PARITY (a) — with an address the note is the property-aware
         sentence production now writes; with none, it is word-for-word what it
         always was (an un-migrated or address-less case must read exactly as
         before, which is the half of parity that is easy to lose). */
      DB.case_notes.push({
        id: nid("nt"), case_id: succ.id,
        body: srcAddr
          ? "Retention opportunity auto-created — current " + (src.lender || "lender") + " deal on " +
            srcAddr + " ends " + src.rate_end_date + "."
          : "Created automatically — " + ([cl.first_name, cl.last_name].filter(Boolean).join(" ") || "this client") +
            "'s rate on the previous case ends " + src.rate_end_date + ".",
        created_by: null, created_at: when
      });
      /* "Call client — rate ends …", due 3 months before the rate ends, never in the past.
         R6.4 — the first address line goes in the middle where there is one, so a
         landlord's four call tasks are four different titles in one list. */
      var due = new Date(src.rate_end_date + "T12:00:00");
      due.setMonth(due.getMonth() - 3);
      var tomorrow = shift(1);
      DB.case_tasks.push({
        id: nid("tk"), case_id: succ.id,
        title: srcAddr
          ? "Call client — rate on " + firstAddrLine(srcAddr) + " ends " + src.rate_end_date
          : "Call client — rate ends " + src.rate_end_date,
        due_date: dateOnly(due.getTime() < tomorrow.getTime() ? tomorrow : due),
        done_at: null, created_by: null,
        assigned_to: src.assigned_to || null, created_at: when
      });
      out.retention_tasks_created++;
      /* R13 · SUPPRESSION — the retention case, its note and the adviser's
         call task are all created regardless: those are staff-facing (or, for
         the case/note, just a record of what happened), not automated contact
         TO the client, and the exchange-chase-task precedent says a task is
         never what suppress_automation withholds. Only the two client emails
         below are gated on it — "a suppressed client must get NOTHING
         automated" means nothing sent to them, not nothing recorded about
         them. */
      if (cl.email && !cl.suppress_automation) {
        queueRow({
          case_id: succ.id, client_id: src.client_id, email_type: "rate_end_reminder",
          to_email: cl.email, subject: "Your rate is coming to an end",
          scheduled_for: when, created_at: when
        });
        out.rate_reminders_queued++;
        /* the scheduled chase — deliberately NOT due yet, so an unscoped run
           must leave it alone (it is the control row for "sends all DUE") */
        queueRow({
          case_id: succ.id, client_id: src.client_id, email_type: "rate_end_chase",
          to_email: cl.email, subject: "Your rate — a reminder",
          scheduled_for: iso(shift(14)), created_at: when
        });
        out.rate_end_chases_queued++;
      }
      if (setting("auto_sms_rate_end", "off") === "on" && cl.phone && !cl.sms_opt_out && !cl.suppress_automation) {
        DB.sms_queue.push({
          id: nid("sq"), case_id: succ.id, client_id: src.client_id, sms_type: "rate_end",
          to_phone: cl.phone, status: "queued", error: null, sent_at: null, created_at: when
        });
        out.sms_queued++;
      }
      src.rate_reminder_queued_at = when;
      src.updated_at = when;
      out.retention_cases_created++;
    });
    return out;
  }
  /* public.queue_comms_extras() — review requests on completed cases */
  /* r8_m1 — the annual review touch.
       ONE call task, on the anniversary of a completion that is at least a year
       old, due today, owned by the adviser whose case it is. Deliberately NOT an
       email: a year after completion the useful act is a conversation, and an
       automated "happy anniversary" from a mortgage broker is the kind of mail
       that gets a firm unsubscribed from. The title carries the two facts the
       adviser needs before dialling — when they completed and which property —
       because a task list is read out of context.
       Idempotency is an 11-month look-back over that case's own tasks matching
       'Annual review call — %', which is what makes the touch safe to run as
       often as you like: the app queues before every firm-wide flush, the cron
       queues nightly, and neither may write the same call twice. Eleven, not
       twelve, so a run a day or two either side of the anniversary can never
       double up, while last year's call — 12 months old — does not suppress
       this year's. */
  var ANNUAL_REVIEW_TITLE_PREFIX = "Annual review call — ";
  function queueAnnualReviewTasks() {
    var made = 0;
    if (setting("annual_review_enabled", "off") !== "on") return made;
    var todayMd = TODAY.slice(5);                                   /* MM-DD */
    var twelveMonthsAgo = new Date(NOW.getFullYear(), NOW.getMonth() - 12, NOW.getDate(), 23, 59, 59);
    var elevenMonthsAgo = new Date(NOW.getFullYear(), NOW.getMonth() - 11, NOW.getDate(), 0, 0, 0);
    DB.cases.filter(function (c) {
      if (c.stage !== "completed" || !c.completed_at) return false;
      var comp = new Date(c.completed_at);
      if (comp.getTime() > twelveMonthsAgo.getTime()) return false;  /* not yet a year old */
      if (dateOnly(comp).slice(5) !== todayMd) return false;         /* not their anniversary */
      /* already called (or already asked to call) within the last 11 months */
      return !DB.case_tasks.some(function (t) {
        return t.case_id === c.id &&
          String(t.title || "").indexOf(ANNUAL_REVIEW_TITLE_PREFIX) === 0 &&
          new Date(t.created_at).getTime() >= elevenMonthsAgo.getTime();
      });
    }).slice().forEach(function (c) {
      var when = iso(new Date());
      var addr = (MIGRATIONS.m7 && c.property_address) ? firstAddrLine(c.property_address) : "";
      DB.case_tasks.push({
        id: nid("tk"), case_id: c.id,
        title: ANNUAL_REVIEW_TITLE_PREFIX + clientName(c.client_id) +
          " (completed " + ukDate(c.completed_at) + (addr ? ", on " + addr : "") + ")",
        due_date: TODAY, done_at: null,
        /* SECURITY DEFINER: the system wrote it, not whoever happened to be
           signed in when the queueing ran */
        created_by: null,
        assigned_to: c.assigned_to || null,
        created_at: when
      });
      made++;
    });
    return made;
  }
  /* r8_m1 — at most five review requests per run. Before, one run asked every
     eligible client at once: a firm switching the feature on emailed its entire
     back book in a single evening, and a quiet month followed by a busy one sent
     a spike that reads as spam to both the client and the mail provider. Five a
     run, oldest completion first (the people who have been waiting longest go
     first, and nobody is skipped forever), and ONLY those five are stamped — the
     stamp is the queue's memory, so stamping a row that was not queued would
     silently drop it for good. */
  var REVIEW_REQUESTS_PER_RUN = 5;
  /* =========================================================================
     r9 — THE NIGHTLY DOCUMENT CHASE
     (WIDENED r12b/W-24 — see DOC_CHASE_STAGES below)

     A case sitting at a stage with items still outstanding is the single most
     common reason a mortgage application stops moving, and until now the only
     thing that chased it was an adviser remembering to.

     The rules, and why each one is where it is:
       · r9 shipped Fact Find / Application only. r12b/W-24 widens that to every
         stage from Enquiry to Exchange inclusive: a checklist can be opened as
         soon as ID is asked for at Enquiry, and the lender still wants the
         missing item right up to Exchange — narrowing the window to two stages
         was always an r9 launch simplification, not a rule about when
         documents matter. Completed and Not proceeding stay excluded either
         way: after completion the lender has what it needs and a chase is just
         noise, and a dead case has nothing left to chase.
       · Only cases with a CHECKLIST that still has requested items. A case with
         no checklist is not "fully documented", it is unknown — and inventing a
         chase for an unknown is how a client gets asked for a passport they
         handed over in person.
       · A quiet window (`doc_chase_days`, 3): if ANY document mail — the
         original request or an earlier chase — went to that client inside it,
         nothing goes tonight. This is what stops a run-twice-in-an-evening (the
         cron, plus an operator pressing Run now) turning into two chases.
       · THREE chases, then stop and tell a human. The fourth email would not be
         the one that works; a phone call might be. The adviser task is written
         instead of an email, once, and it is idempotent on its own title so a
         week of nightly runs leaves one task, not seven.
     Gated on `doc_chase_enabled`, seeded OFF — see the settings block. The
     WIDENED stage set applies identically to the chase-email branch and the
     overdue-task branch below — they are one filter feeding both, deliberately:
     production's chase CTE and overdue-task CTE both moved to the same six
     stages in the same migration, so a case that newly qualifies here
     qualifies for both outcomes exactly as before, just from a bigger set of
     stages. */
  var DOC_CHASE_STAGES = ["enquiry", "fact_find", "decision_in_principle", "application", "offer", "exchange"];
  var DOC_CHASE_MAX = 3;
  var DOC_OVERDUE_TITLE_PREFIX = "Documents overdue — call ";
  function docMailsFor(caseId, type) {
    return DB.email_queue.filter(function (e) {
      return e.case_id === caseId && (type ? e.email_type === type : DOC_TYPES.indexOf(e.email_type) >= 0);
    });
  }
  /* R63 · A2(a) — HOW MANY CHASES THIS CASE HAS HAD, the production way.
     There is NO `docs_chase` email type in production: queue_comms_extras chases by queuing a
     FURTHER `docs_request` row, so the first document email on a case is the request and every
     one after it is a chase. This mock queued a made-up `docs_chase` type and counted only those,
     which meant the harness could never reproduce the bug the real chaser has (and app.js's own
     counter had the same hole — see docChaseCount() there; the two must agree or the harness is
     testing a rule production does not have).
     Same rule both sides: legacy `docs_chase` rows are still counted (this file's own fixtures
     seed them, and a historic production row could exist), plus every `docs_request` row after
     the first. Cancelled rows never reached the client, so they never chased anybody. */
  function docChaseCountFor(caseId) {
    var live = docMailsFor(caseId).filter(function (e) { return e.status !== "cancelled"; });
    var legacy = live.filter(function (e) { return e.email_type === "docs_chase"; }).length;
    var requests = live.filter(function (e) { return e.email_type === "docs_request"; }).length;
    return legacy + Math.max(0, requests - 1);
  }
  /* =========================================================================
     R63 · A2(b) — TRIGGER PARITY: auto_stage_comms (prod) on cases.stage change

     Production carries an AFTER UPDATE trigger on `cases` that fires the moment a case's stage
     changes. This mock never had it — which is what the "honest gap" note further down used to
     record — and the cost was not academic: four real settings with real Settings-page UI
     (auto_docs_request / auto_submitted_update / auto_offer_update / auto_completion_email) and
     the whole "advance a case and a client hears about it" behaviour were invisible to the
     harness, so nothing could catch the app describing them wrongly.

     WHAT THE TRIGGER DOES, mirrored exactly:

     · ONE EMAIL PER ARRIVAL, keyed on the stage the case lands in:
         fact_find   → docs_request        (auto_docs_request)
         application → submitted_update    (auto_submitted_update)
         offer       → offer_update        (auto_offer_update)
         completed   → completion_congrats (auto_completion_email)
       Each is gated on its OWN setting, read with settingBool10On below: '1' AND 'on' both mean
       on, because the Settings form writes "1"/"0" while the seeded rows (and the production SQL)
       say 'on'/'off'. A switch whose two spellings disagree is a switch nobody can trust.
     · SKIPPED when the client has no email address (there is nothing to send to — Data health
       owns that gap) and when the client is `suppress_automation` — the same rule, checked the
       same way, as every other automated client email in this file.
     · IDEMPOTENT PER CASE + EMAIL TYPE. The existence of the row IS the memory, so a case dragged
       Offer → Application → Offer is not congratulated twice, and a case somebody advanced by
       accident and moved straight back leaves exactly one row behind, not two. Cancelled rows
       count as "already queued" for this purpose: somebody stopping the email is a decision, and
       re-entering the stage must not quietly re-send what they stopped.
     · THE SOLICITOR CHASE TASK at `exchange`: "Chase solicitors for completion date", due
       TODAY + solicitor_chase_days (7 when unset), assigned to the case's own adviser. Written
       only when the case has no OPEN task whose title starts "Chase solicitors" — the same
       LIKE-prefix idempotency production uses, so a task somebody retitled slightly is still
       recognised as the one that exists. NOT gated on suppression, and not on a client email
       address: it is work for staff, not a message to a client, exactly like the doc-overdue
       task below and the exchange alert in the watchtower fixtures.

     Fires only on a genuine stage CHANGE (before.stage !== after.stage), from the two write paths
     that can change one — the update builder and the upsert builder — so a save that touches
     anything else on the case queues nothing.
     ======================================================================= */
  function settingBool10On(k) {
    var v = String(setting(k, "off")).trim().toLowerCase();
    return v === "1" || v === "on";
  }
  var STAGE_COMMS = {
    fact_find: { setting: "auto_docs_request", type: "docs_request", subject: "Your document checklist" },
    application: { setting: "auto_submitted_update", type: "submitted_update", subject: "Your application has gone to the lender" },
    offer: { setting: "auto_offer_update", type: "offer_update", subject: "Your mortgage offer has come through" },
    completed: { setting: "auto_completion_email", type: "completion_congrats", subject: "Congratulations on your completion" }
  };
  var SOLICITOR_CHASE_TITLE = "Chase solicitors for completion date";
  function autoStageComms(before, after) {
    if (!after || !after.id) return;
    if (before && before.stage === after.stage) return;
    var when = iso(new Date());
    var spec = STAGE_COMMS[after.stage];
    if (spec && settingBool10On(spec.setting)) {
      var already = DB.email_queue.some(function (e) {
        return e.case_id === after.id && e.email_type === spec.type;
      });
      if (!already) {
        var cl = DB.clients.filter(function (x) { return x.id === after.client_id; })[0];
        /* No address, or automation suppressed for this person → nothing queued, silently, which
           is exactly what the production trigger's WHERE clause does. */
        if (cl && cl.email && !cl.suppress_automation) {
          queueRow({
            case_id: after.id, client_id: after.client_id, email_type: spec.type,
            to_email: cl.email, subject: spec.subject,
            scheduled_for: when, created_at: when
          });
        }
      }
    }
    if (after.stage === "exchange") {
      var open = DB.case_tasks.some(function (t) {
        return t.case_id === after.id && !t.done_at && /^Chase solicitors/.test(String(t.title || ""));
      });
      if (open) return;
      var days = Number(setting("solicitor_chase_days", "7"));
      if (!(days >= 0)) days = 7;
      DB.case_tasks.push({
        id: nid("tk"), case_id: after.id, title: SOLICITOR_CHASE_TITLE,
        due_date: dateOnly(new Date(NOW.getTime() + days * DAY)), done_at: null,
        created_by: null,                              /* SECURITY DEFINER — the system wrote it */
        assigned_to: after.assigned_to || null, created_at: when
      });
    }
  }
  function queueDocChases() {
    var out = { doc_chases_queued: 0, doc_overdue_tasks: 0 };
    if (setting("doc_chase_enabled", "off") !== "on") return out;
    if (!MIGRATIONS.m10) return out;                 /* no checklist table, nothing to chase from */
    var quiet = Number(setting("doc_chase_days", "3")) || 3;
    DB.cases.filter(function (c) {
      return DOC_CHASE_STAGES.indexOf(c.stage) >= 0 && outstandingDocs(c.id).length > 0;
    }).slice().forEach(function (c) {
      var chases = docChaseCountFor(c.id);          /* R63 · A2(a) — the production rule */
      var when = iso(new Date());
      if (chases >= DOC_CHASE_MAX) {
        /* Out of chases. A task, not a fourth email — and deliberately NOT
           subject to the quiet window: the window governs how often we mail a
           client, and this is the point at which we stop mailing them. */
        var title = DOC_OVERDUE_TITLE_PREFIX + clientName(c.client_id);
        var already = DB.case_tasks.some(function (t) {
          return t.case_id === c.id && t.title === title && !t.done_at;
        });
        if (already) return;
        DB.case_tasks.push({
          id: nid("tk"), case_id: c.id, title: title,
          due_date: TODAY, done_at: null,
          created_by: null,                          /* SECURITY DEFINER — the system wrote it */
          assigned_to: c.assigned_to || null, created_at: when
        });
        out.doc_overdue_tasks++;
        return;
      }
      var last = docMailsFor(c.id).map(function (e) { return e.sent_at || e.created_at; })
        .sort().slice(-1)[0];
      if (last && (NOW - new Date(last)) / DAY < quiet) return;      /* said something too recently */
      var cl = DB.clients.filter(function (x) { return x.id === c.client_id; })[0];
      if (!cl || !cl.email) return;                  /* nothing to send to — Data health owns that */
      /* R13 · SUPPRESSION — the chase EMAIL is withheld; the overdue-tasks
         branch above is NOT gated on it (a task for staff, same as the
         exchange-chase task), consistent everywhere suppression is checked
         in this file. */
      if (cl.suppress_automation) return;
      /* R63 · A2(a) — a chase IS a further `docs_request`. Production has no `docs_chase` type
         to write, and a harness that invents one is a harness in which the app's chase counter
         can never be wrong. The SUBJECT stays "Still waiting on your documents" — that is what
         distinguishes a chase from the first ask in the queue an operator reads, and it is what
         process-emails composes for a request that is not the first on its case. */
      queueRow({
        case_id: c.id, client_id: c.client_id, email_type: "docs_request",
        to_email: cl.email, subject: "Still waiting on your documents",
        scheduled_for: when, created_at: when
      });
      out.doc_chases_queued++;
    });
    return out;
  }
  /* =========================================================================
     r9 — THE REVIEW REMINDER

     One nudge, a week after a review request that was actually SENT and never
     answered. Keyed on the email_queue row rather than on
     `cases.review_requested_at`, deliberately: the stamp records that we decided
     to ask, the sent row records that the client was asked, and only the second
     of those is worth chasing. (It also means a back-book stamped as "already
     asked" during a migration is never nudged for a mail nobody ever received.)

     One reminder per case, ever — the existence of a `review_reminder` row is
     the memory, so no new column is needed and a re-run can never double up.
     It shares the review drip's budget of five a run, and takes what is left
     AFTER the new requests: someone who has never been asked comes before
     someone who is being asked twice.
     ======================================================================= */
  function queueReviewReminders(budget) {
    if (budget <= 0) return 0;
    var days = Number(setting("review_reminder_days", "7")) || 7;
    var sentAt = {};
    DB.email_queue.forEach(function (e) {
      if (e.email_type !== "review_request" || e.status !== "sent" || !e.sent_at || !e.case_id) return;
      if (!sentAt[e.case_id] || e.sent_at > sentAt[e.case_id]) sentAt[e.case_id] = e.sent_at;
    });
    var made = 0;
    Object.keys(sentAt).filter(function (cid) {
      if ((NOW - new Date(sentAt[cid])) / DAY < days) return false;          /* not a week yet */
      var c = DB.cases.filter(function (x) { return x.id === cid; })[0];
      if (!c || c.nps_score != null) return false;                           /* they answered */
      if (DB.email_queue.some(function (e) {
        return e.case_id === cid && e.email_type === "review_reminder";
      })) return false;                                                      /* already nudged */
      var cl = DB.clients.filter(function (x) { return x.id === c.client_id; })[0];
      /* R13 · SUPPRESSION */
      return !!(cl && cl.email && !cl.marketing_opt_out && !cl.suppress_automation);
    }).sort(function (a, b) {
      /* longest-unanswered first, then by id — stable, so the same run twice
         over picks the same people */
      return sentAt[a] < sentAt[b] ? -1 : (sentAt[a] > sentAt[b] ? 1 : (a < b ? -1 : 1));
    }).slice(0, budget).forEach(function (cid) {
      var c = DB.cases.filter(function (x) { return x.id === cid; })[0];
      var cl = DB.clients.filter(function (x) { return x.id === c.client_id; })[0];
      var when = iso(new Date());
      queueRow({
        case_id: c.id, client_id: c.client_id, email_type: "review_reminder",
        to_email: cl.email, subject: "How did we do? — a gentle reminder",
        scheduled_for: when, created_at: when
      });
      made++;
    });
    return made;
  }
  /* R13 · SUPPRESSION — HONEST GAP, STATED NOT GUESSED.
     The round-13 brief asks for suppress_automation to be enforced across
     "all 4 client-email branches: birthday, anniversary, doc chase, review
     reminders" of queue_comms_extras(). This mock's queueCommsExtras only
     ever HAD two of those four as actual queueing code — doc chase
     (queueDocChases, suppressed above) and review reminders
     (queueReviewReminders, suppressed above), plus review requests
     (suppressed above too, a close cousin of review reminders). `birthday`
     and `anniversary` are real settings (birthday_enabled, anniversary_enabled)
     with real Settings-panel UI and copy in app.js, but there has never been
     any code anywhere in this file that queues a birthday or completion-
     anniversary EMAIL — the only anniversary-shaped thing this mock sends is
     queueAnnualReviewTasks() above, which is a CALL TASK, gated on the
     separate annual_review_enabled setting, and explicitly documented in
     app.js as "Independent of the completion-anniversary email above, which
     is an email and creates no task". Suppression cannot be wired onto
     queueing code that was never written; inventing that feature from
     scratch was out of scope for this pass, so it stays exactly as absent as
     it was before this round, and is named here rather than left for the
     next person to rediscover by grepping for nothing. Same absence, same
     reason, for auto_sms_appointment (the settings key exists; nothing ever
     queues off it).
     R63 · A2(b) — THE STAGE-COMMS HALF OF THIS NOTE IS NO LONGER TRUE, and is
     corrected here rather than deleted, because the shape of the gap is worth
     keeping: auto_docs_request / auto_submitted_update / auto_offer_update /
     auto_completion_email were four settings with zero queueing code in this
     file, and they are now mirrored by autoStageComms() (search "TRIGGER
     PARITY: auto_stage_comms" above) — which is a TRIGGER on cases.stage, not
     part of queueCommsExtras at all, so nothing below this line queues them and
     nothing below this line should. The exchange solicitor-chase task lives
     there too, for the same reason. */
  function queueCommsExtras() {
    var out = { review_requests_queued: 0, annual_review_tasks: 0, review_reminders_queued: 0, doc_chases_queued: 0, doc_overdue_tasks: 0 };
    /* The annual review touch is a task, not an email, so it is NOT gated on the
       review link or the NPS switch — it has its own. */
    out.annual_review_tasks = queueAnnualReviewTasks();
    /* …and so is the document chase: it has nothing to do with reviews, and a
       firm with no review link still has clients who owe it payslips. */
    var docs = queueDocChases();
    out.doc_chases_queued = docs.doc_chases_queued;
    out.doc_overdue_tasks = docs.doc_overdue_tasks;
    var link = setting("google_review_link") || setting("review_platform_link");
    if (!link || setting("nps_enabled", "off") !== "on") return out;
    var delay = Number(setting("review_delay_days", "14")) || 14;
    DB.cases.filter(function (c) {
      if (c.stage !== "completed" || !c.completed_at || c.review_requested_at) return false;
      if ((NOW - new Date(c.completed_at)) / DAY < delay) return false;
      var cl = DB.clients.filter(function (x) { return x.id === c.client_id; })[0];
      /* R13 · SUPPRESSION */
      return !!(cl && cl.email && !cl.marketing_opt_out && !cl.suppress_automation);
    }).sort(function (a, b) {
      /* oldest completion first — a stable order, so the same run twice over
         picks the same five */
      return a.completed_at < b.completed_at ? -1 : (a.completed_at > b.completed_at ? 1 : (a.id < b.id ? -1 : 1));
    }).slice(0, REVIEW_REQUESTS_PER_RUN).forEach(function (c) {
      var cl = DB.clients.filter(function (x) { return x.id === c.client_id; })[0];
      var when = iso(new Date());
      queueRow({
        case_id: c.id, client_id: c.client_id, email_type: "review_request",
        to_email: cl.email, subject: "How did we do?", scheduled_for: when, created_at: when
      });
      c.review_requested_at = when;
      out.review_requests_queued++;
    });
    /* r9 — whatever is left of tonight's five goes on nudging the people who
       were asked a week ago and said nothing. */
    out.review_reminders_queued = queueReviewReminders(REVIEW_REQUESTS_PER_RUN - out.review_requests_queued);
    return out;
  }
  var LAST_EMAIL_RUN = null;

  /* -------------------------------------------------------------------------
     ai-import parser (PLAN-R5 § Harness fixes 2 / R5-45)
     ----------------------------------------------------------------------- */
  var AI_IMPORT_FALLBACK = [
    { client_name: "Neil Ashcombe", email: "neil.ashcombe@example.com", phone: "07700 900501", stage: "completed", lender: "Halifax", rate_percent: 4.29, rate_end_date: "01/02/2027", erc_end_date: "", completed_date: "14/03/2026", broker_fee: 495, case_kind: "remortgage" },
    { client_name: "Priti Raval", email: "priti.raval@example.com", phone: "07700 900502", stage: "completed", lender: "Nationwide", rate_percent: 4.55, rate_end_date: "2029-08-31", erc_end_date: "", completed_date: "", broker_fee: 0, case_kind: "purchase" },
    { client_name: "Bob Grimsdale", email: "", phone: "07700 900503", stage: "enquiry", lender: "", rate_percent: null, rate_end_date: "", erc_end_date: "", broker_fee: null, case_kind: "buy_to_let" },
    { client_name: "Wendy Cathcart", email: "wendy.cathcart@example.com", phone: "07700 900504", stage: "application", lender: "Skipton", rate_percent: 4.19, rate_end_date: "30/06/2031", erc_end_date: "30/06/2031", completed_date: "", broker_fee: 695, case_kind: "remortgage" }
  ];
  var IMPORT_STAGE_WORDS = {
    "enquiry": "enquiry", "enquiries": "enquiry", "lead": "enquiry", "new": "enquiry", "new enquiry": "enquiry",
    "fact find": "fact_find", "factfind": "fact_find", "fact_find": "fact_find", "fact-find": "fact_find",
    "dip": "decision_in_principle", "aip": "decision_in_principle", "decision in principle": "decision_in_principle",
    "decision_in_principle": "decision_in_principle",
    "application": "application", "applied": "application", "submitted": "application", "app submitted": "application",
    "offer": "offer", "offered": "offer", "offer received": "offer",
    "exchange": "exchange", "exchanged": "exchange",
    "completed": "completed", "complete": "completed", "completion": "completed",
    "not proceeding": "not_proceeding", "not_proceeding": "not_proceeding", "lost": "not_proceeding",
    "declined": "not_proceeding", "cancelled": "not_proceeding", "dead": "not_proceeding"
  };
  var IMPORT_KIND_WORDS = {
    "purchase": "purchase", "house purchase": "purchase", "home mover": "purchase", "mover": "purchase",
    "remortgage": "remortgage", "remo": "remortgage", "re-mortgage": "remortgage",
    "product transfer": "product_transfer", "product_transfer": "product_transfer", "pt": "product_transfer",
    "buy to let": "buy_to_let", "buy-to-let": "buy_to_let", "btl": "buy_to_let", "buy_to_let": "buy_to_let",
    "first time buyer": "first_time_buyer", "first-time-buyer": "first_time_buyer", "ftb": "first_time_buyer",
    "first_time_buyer": "first_time_buyer", "other": "other"
  };
  var IMPORT_HEADER_MAP = [
    [/^(client[_ ]?name|full[_ ]?name|name|client|customer)$/i, "client_name"],
    [/^(first[_ ]?name|forename|first)$/i, "first_name"],
    [/^(last[_ ]?name|surname|last)$/i, "last_name"],
    [/e-?mail/i, "email"],
    [/(phone|mobile|telephone|^tel$|contact number)/i, "phone"],
    [/(rate[_ ]?end|end of rate|deal[_ ]?end|fix(ed)?[_ ]?end|maturity)/i, "rate_end_date"],
    [/erc/i, "erc_end_date"],
    [/complet/i, "completed_date"],
    [/(rate[_ ]?%|rate[_ ]?percent|interest|^rate$)/i, "rate_percent"],
    [/(lender|bank|provider|product provider)/i, "lender"],
    [/(broker[_ ]?fee|^fee$|fee ?\(£\)|advice fee)/i, "broker_fee"],
    [/(case[_ ]?kind|case[_ ]?type|^type$|product type|enquiry type)/i, "case_kind"],
    [/(stage|status)/i, "stage"],
    [/(loan|borrowing|mortgage amount)/i, "loan_amount"],
    [/(property[_ ]?value|valuation|purchase price|^value$)/i, "property_value"],
    [/(product[_ ]?name|product$)/i, "product_name"],
    [/(term)/i, "term_years"],
    [/(note|comment)/i, "note"]
  ];
  var RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var RE_PHONE = /^\+?[\d][\d\s().-]{7,}$/;
  var RE_DATE = /^(\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})$/;
  var RE_PCT = /^\d{1,2}(\.\d{1,3})?\s*%?$/;
  var RE_MONEY = /^£?\s*\d{1,3}(,\d{3})*(\.\d{1,2})?$|^£\s*\d+(\.\d{1,2})?$/;
  function impNum(v) {
    var n = Number(String(v == null ? "" : v).replace(/[£,%\s]/g, ""));
    return isNaN(n) ? null : n;
  }
  function splitDelimited(line, delim) {
    if (delim !== ",") return line.split(delim).map(function (s) { return s.trim(); });
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
      } else if (ch === "," && !q) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }
  function emptyImportRow() {
    return {
      client_name: "", email: "", phone: "", stage: "", lender: "", product_name: null,
      rate_percent: null, rate_type: null, rate_end_date: "", rate_end_estimated: false,
      erc_end_date: "", completed_date: "", broker_fee: null, case_kind: "",
      loan_amount: null, property_value: null, note: null
    };
  }
  function finishImportRow(r) {
    if (!r.client_name && (r.first_name || r.last_name)) {
      r.client_name = [r.first_name, r.last_name].filter(Boolean).join(" ");
    }
    delete r.first_name; delete r.last_name;
    if (r.stage) r.stage = IMPORT_STAGE_WORDS[String(r.stage).trim().toLowerCase()] || "";
    if (r.case_kind) r.case_kind = IMPORT_KIND_WORDS[String(r.case_kind).trim().toLowerCase()] || "other";
    ["rate_percent", "broker_fee", "loan_amount", "property_value", "term_years"].forEach(function (f) {
      if (r[f] !== null && r[f] !== undefined && r[f] !== "") r[f] = impNum(r[f]);
      else if (r[f] === "") r[f] = null;
    });
    if (!r.client_name && !r.email && !r.phone) return null;
    return r;
  }
  function aiImportRows(content) {
    var text = String(content == null ? "" : content).replace(/\r/g, "").trim();
    if (!text) return null;                                  /* empty body → canned demo rows */
    var lines = text.split("\n").map(function (l) { return l.trim(); })
      .filter(function (l) { return l && !/^===\s*Sheet:/i.test(l) && !/^-{3,}$/.test(l); });
    if (!lines.length) return [];
    /* pick the delimiter that appears consistently across the most lines */
    var delim = null, best = 0;
    ["\t", ",", "|", ";"].forEach(function (d) {
      var n = lines.filter(function (l) { return l.indexOf(d) >= 0; }).length;
      if (n > best && n >= Math.max(1, Math.ceil(lines.length / 2))) { best = n; delim = d; }
    });
    /* a line that doesn't carry the majority delimiter still gets split on
       whatever separator it does use, so a mixed paste isn't silently lost */
    var cells = lines.map(function (l) {
      var d = (delim && l.indexOf(delim) >= 0)
        ? delim
        : ["\t", "|", ";", ","].filter(function (x) { return l.indexOf(x) >= 0; })[0];
      return d ? splitDelimited(l, d) : [l];
    });
    /* header row? — at least two cells map to a known column and none looks like data */
    var header = null;
    var first = cells[0] || [];
    if (first.length > 1) {
      var mapped = first.map(function (h) {
        var hit = null;
        IMPORT_HEADER_MAP.some(function (p) { if (p[0].test(h)) { hit = p[1]; return true; } return false; });
        return hit;
      });
      var named = mapped.filter(Boolean).length;
      var looksLikeData = first.some(function (h) { return RE_EMAIL.test(h) || RE_DATE.test(h); });
      if (named >= 2 && !looksLikeData) header = mapped;
    }
    var out = [];
    cells.forEach(function (cs, i) {
      if (header && i === 0) return;
      var r = emptyImportRow();
      if (header) {
        header.forEach(function (field, j) {
          if (!field) return;
          var v = (cs[j] == null ? "" : String(cs[j])).trim();
          if (v === "") return;
          r[field] = v;
        });
      } else {
        /* no header — classify each cell by shape, in a fixed order so the same
           paste always yields the same rows */
        var dates = [];
        cs.forEach(function (raw) {
          var v = String(raw == null ? "" : raw).trim();
          if (!v) return;
          var low = v.toLowerCase();
          if (RE_EMAIL.test(v)) { if (!r.email) r.email = v; return; }
          if (RE_DATE.test(v)) { dates.push(v); return; }
          if (RE_PCT.test(v) && /%|\./.test(v) && impNum(v) != null && impNum(v) < 25) { if (r.rate_percent == null) r.rate_percent = impNum(v); return; }
          if (IMPORT_STAGE_WORDS[low]) { if (!r.stage) r.stage = low; return; }
          if (IMPORT_KIND_WORDS[low]) { if (!r.case_kind) r.case_kind = low; return; }
          if (RE_PHONE.test(v) && normPhone(v).replace(/\D/g, "").length >= 10) { if (!r.phone) r.phone = v; return; }
          if (RE_MONEY.test(v)) {
            var n = impNum(v);
            if (n != null && n >= 20000) { if (r.loan_amount == null) r.loan_amount = n; else if (r.property_value == null) r.property_value = n; }
            else if (r.broker_fee == null) r.broker_fee = n;
            return;
          }
          if (!r.client_name && /[A-Za-z]/.test(v)) { r.client_name = v; return; }
          if (!r.lender && /[A-Za-z]/.test(v)) { r.lender = v; return; }
          if (r.note == null) r.note = v;
        });
        /* dates fill rate-end, then ERC, then completion (documented order) */
        if (dates[0]) r.rate_end_date = dates[0];
        if (dates[1]) r.erc_end_date = dates[1];
        if (dates[2]) r.completed_date = dates[2];
      }
      var done = finishImportRow(r);
      if (done) out.push(done);
    });
    return out;
  }

  var EDGE = {
    "process-emails": function (body) {
      /* v8 authorize() — was `role === 'staff'`, which refused every real
         interactive caller. owner/admin/adviser/staff all pass now. */
      if (!isStaff()) return { __status: 403, error: "forbidden — staff only" };
      var ids = body && Array.isArray(body.queue_ids) ? body.queue_ids.filter(Boolean) : null;
      /* ==================================================================
         R68 · M15 — THE SAFE PROBE.  {queue_ids: []} names ZERO rows, so in
         production v14 short-circuits before it queues, sends, fails or
         stamps anything and answers three questions instead: is a Resend key
         set on the server, is the hold on, and how many emails are due right
         now. It is a question, not an action — which is the whole reason the
         Settings "Email sending" strip may ask it on every page open.

         Mirrored EXACTLY here, and deliberately ABOVE everything below: the
         old code path would have fallen through to `due = []` and still
         rewritten LAST_EMAIL_RUN, so merely opening Settings would have
         clobbered what `__mock.lastEmailRun()` reports about the last real
         run. A probe that leaves a footprint is not a probe.

         `warning` carries the server's own words; app.js keys off the string
         "RESEND_API_KEY". Key present AND hold off returns no warning at all.
         ================================================================== */
      if (ids && !ids.length) {
        var nowProbe = iso(new Date());
        var holdRow = DB.settings.filter(function (s) { return s.key === "email_hold"; })[0];
        var holdVal = holdRow ? String(holdRow.value || "").trim().toLowerCase() : "on";
        var pending = DB.email_queue.filter(function (e) {
          return e.status === "queued" && (!e.scheduled_for || e.scheduled_for <= nowProbe);
        }).length;
        var out = { held: holdVal !== "off", pending: pending };
        if (!MOCK_RESEND_KEY) out.warning = "RESEND_API_KEY not set — nothing can be sent from this server.";
        return out;
      }
      var queued = { rate_reminders_queued: 0, review_requests_queued: 0, retention_cases_created: 0,
        review_reminders_queued: 0, doc_chases_queued: 0, doc_overdue_tasks: 0 };
      if (!ids) {
        var auto = queueAutomatedEmails();
        var extras = queueCommsExtras();
        queued.rate_reminders_queued = auto.rate_reminders_queued;
        queued.retention_cases_created = auto.retention_cases_created;
        queued.review_requests_queued = extras.review_requests_queued;
        /* r9 — the two new nightly touches, reported the same way, so "what did
           the cron actually do last night" is answerable from one object. */
        queued.review_reminders_queued = extras.review_reminders_queued;
        queued.doc_chases_queued = extras.doc_chases_queued;
        queued.doc_overdue_tasks = extras.doc_overdue_tasks;
        /* R13 · M-43 — v13 UPSERTs the cron heartbeat on every FULL (unscoped)
           run, never on a scoped one (a "Send reminder" on one case is not
           the 8am cron confirming it is alive). Mirrors the settings write
           pattern used elsewhere (find-or-push on `key`). */
        var heartbeatRow = DB.settings.filter(function (s) { return s.key === "last_cron_run_at"; })[0];
        var heartbeatAt = iso(new Date());
        if (heartbeatRow) { heartbeatRow.value = heartbeatAt; heartbeatRow.updated_at = heartbeatAt; }
        else DB.settings.push({ key: "last_cron_run_at", value: heartbeatAt, updated_at: heartbeatAt });
      }
      var nowIso = iso(new Date());
      var due = DB.email_queue.filter(function (e) {
        if (e.status !== "queued") return false;
        if (ids) return ids.indexOf(e.id) >= 0;           /* scoped: ONLY these rows */
        return !e.scheduled_for || e.scheduled_for <= nowIso;
      });
      var sent = 0, failed = 0, composed = [];
      due.forEach(function (e) {
        if (!e.to_email) {
          e.status = "failed";
          e.error = "No recipient address — the client record has no email on file";
          failed++;
          return;
        }
        /* R12a·D3 — v12: compose() can now throw (factfind, no site_url). A
           row whose compose blows up goes status='failed' with THAT error,
           the same as a bounce or a missing address — never quietly sent, and
           never left dangling in 'queued' either. Everything before this row
           in the loop is unaffected; the try/catch is per-row on purpose. */
        var composedRow;
        try {
          composedRow = composeEmail(e);
        } catch (composeErr) {
          e.status = "failed";
          e.error = (composeErr && composeErr.message) || String(composeErr);
          failed++;
          return;
        }
        composed.push(composedRow);
        e.status = "sent";
        e.sent_at = iso(new Date());
        e.error = null;
        sent++;
        /* R12a·D3 — AFTER a successful send only: advance that fact_finds row
           to 'sent'. Guarded to only move it on from 'created' or 'sent' —
           never regresses a row the client already moved on to 'started' or
           'submitted' themselves, which could easily be true by the time a
           chase/retry send lands. */
        if (e.email_type === "factfind" && composedRow.fact_find_id) {
          var ffRow = DB.fact_finds.filter(function (f) { return f.id === composedRow.fact_find_id; })[0];
          if (ffRow && ["created", "sent"].indexOf(ffRow.status) >= 0) ffRow.status = "sent";
        }
      });
      LAST_EMAIL_RUN = {
        at: nowIso, scoped: !!ids, queue_ids: ids, considered: due.length,
        sent: sent, failed: failed, queued: queued, composed: composed
      };
      return { ok: true, sent: sent, failed: failed, scoped: !!ids, skipped_queueing: !!ids, queued: queued };
    },
    /* R63 · A3 — PARITY NOTE, not a behaviour change. In production this function is ALSO on a
       schedule of its own: the `nexmoney-send-sms` cron invokes it daily at 08:05 UTC (09:05 while
       BST is in force), five minutes behind the email run. This mock has no clock, so — exactly
       like process-emails above — it only ever runs when something invokes it. Written down here
       because app.js's Emails page used to tell operators the opposite ("SMS is not on the 8am
       cron, so nothing goes until somebody presses Send SMS now"), and the harness is where that
       claim would otherwise keep looking true. */
    "send-sms": function () {
      var due = DB.sms_queue.filter(function (s) { return s.status === "queued" && s.to_phone; });
      due.forEach(function (s) { s.status = "sent"; s.sent_at = iso(new Date()); });
      return { ok: true, sent: due.length, failed: 0, appointment_queued: 0 };
    },
    "outlook-sync": function () { return { ok: true, fetched: 42, matched: 3, inserted: 0 }; },
    "owner-digest": function () {
      var to = (DB.settings.filter(function (s) { return s.key === "owner_digest_email"; })[0] || {}).value;
      return { sent: true, to: to || "daniel@nexmoney.co.uk" };
    },
    "invite-user": function (body) {
      if (!isOwner()) return { __status: 403, error: "forbidden — only an Owner may create logins" };
      var role = (body && body.role) || "adviser";
      if (["admin", "adviser", "introducer"].indexOf(role) === -1) {
        return { __status: 400, error: "role must be one of admin, adviser, introducer" };
      }
      if (role === "introducer" && !(body && body.introducer_id)) {
        return { __status: 400, error: "introducer_id is required for an introducer login" };
      }
      var p = {
        id: nid("pr"), full_name: (body && body.full_name) || "", email: (body && body.email) || "",
        role: role, introducer_id: (body && body.introducer_id) || null, created_at: iso(new Date())
      };
      DB.profiles.push(p);
      auditRow("profiles", "insert", p, clone(p));
      return { ok: true, user_id: p.id, email: p.email, role: role, temp_password: "Nx-" + Math.random().toString(36).slice(2, 10) + "!7" };
    },
    /* R5-45 (MOCK_ARTEFACT) — the stub used to ignore the request body entirely
       and hand back the same four strangers whatever was pasted, which made
       every import finding untestable (you could never see YOUR row in the
       preview). It now reads `content` and derives the rows from it: a header
       row is mapped by name; without one, each cell is sniffed by shape
       (email / phone / percent / date / money / stage / kind / name). The canned
       four survive only as the empty-body fallback, so the demo still has data.
       NOTE for Daniel: the real gap behind this is that production's `ai-import`
       needs ANTHROPIC_API_KEY set in the Supabase project — see PLAN-R5
       § Decisions 3. */
    "ai-import": function (body) {
      var rows = aiImportRows(body && body.content);
      if (!rows) return { ok: true, rows: clone(AI_IMPORT_FALLBACK), source: "fallback" };
      if (!rows.length) return { ok: true, rows: [], source: "parsed", note: "Nothing in that paste looked like a client row." };
      return { ok: true, rows: rows, source: "parsed" };
    },
    /* R6.4 MOCK PARITY (c) — production's parse-offer reads the security address off
       the offer letter and returns it, which is the one field on a mortgage offer
       that says WHICH property is being lent against. The stub omitted it, so the
       app's offer-diff had nothing to propose and the whole property-from-offer
       path was untestable end to end. Deliberately a full address with a postcode:
       the diff is what most often first puts an address on a case. */
    "parse-offer": function () {
      return {
        ok: true,
        offer: {
          property_address: "17 Talbot Avenue, Winton, Bournemouth BH3 7HU",
          lender: "Coventry Building Society", product_name: "5 Year Fixed 75% LTV",
          rate_percent: 4.24, rate_type: "fixed",
          rate_end_date: dateOnly(shift(1795)), erc_end_date: dateOnly(shift(1795)),
          offer_issued_date: dateOnly(shift(-3)), offer_expiry_date: dateOnly(shift(150)),
          loan_amount: 246000, current_balance: 241500, property_value: 328000, term_years: 27,
          /* R54 — the fuller reading production now pulls off the offer: the money the client will
             pay, the follow-on rate, how it is repaid, and the two references that identify it. */
          monthly_payment: 1187, reversion_rate: 8.49, repayment_method: "repayment",
          mortgage_account_number: "COV-88451207", lender_reference: "AP-2231190",
          erc_summary: "5%/4%/3%/2%/1% of the amount repaid, reducing annually",
          confidence_notes: "Property value read from the valuation section — check against the offer letter."
        }
      };
    },
    /* ---------------------------------------------------------------------
       r9 · doc-upload — the ONE part of this system a client without a login
       ever touches, mirroring the DEPLOYED v1 contract exactly.

       GET  ?token=…                      what is still outstanding, and who we
                                          think they are.
       POST multipart/form-data           one file has arrived.
              token    the case's uuid — IN THE BODY. Query params are ignored
                       on POST, deliberately: a token in a URL ends up in proxy
                       logs, browser history and referrer headers, and a POST
                       that accepted it there would quietly undo the reason the
                       body exists.
              item_id  the item's ID from the GET — never its NAME. Names are
                       free text an adviser can edit while the client has the
                       page open, so matching on one is a race with a typo.
              file     a real file part WITH a filename. The EXTENSION is
                       authoritative for the type, not the browser's Content-Type
                       header, which is guesswork on Android and empty for HEIC.
              website  a honeypot, normally absent. See below.

       WHY A JSON BODY IS A 400 BEFORE ANY LOGIC: the deployed function reads
       multipart and nothing else. A stub that quietly accepted JSON as well
       would let a page ship that works in the harness and 400s for every real
       client, which is the exact failure this mirror exists to prevent.

       THE HONEYPOT ANSWERS 200 AND DOES NOTHING. A bot that fills every field
       it finds gets {ok:true} and no more — no item, no outstanding count, and
       nothing written. Anything reading this response has to treat a bare
       {ok:true} as "not a real upload", because that is precisely what it is.

       ERRORS ARE STATUS CODES. The messages are for humans and contain
       em-dashes and wording that will change; the number is the contract:
         400 malformed — no token, no item_id, no file part, empty file
         404 the token resolves to nothing, or that item is not on this list
         409 that item is already received (carries `status`), or a claim race
         413 over 10MB
         415 extension not accepted, or the bytes disagree with the extension
         429 too many uploads on one link in one minute
         500 the storage write failed
       --------------------------------------------------------------------- */
    "doc-upload": async function (body, req) {
      var method = String((req && req.method) || "POST").toUpperCase();
      var err = function (code, msg, extra) {
        var o = { __status: code, error: msg };
        if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
        return o;
      };
      /* The one 404 a bad link ever gets — the same words whether the token is
         invented, expired or belonged to a case since cleared. An error that
         distinguishes "no such link" from "not your link" is an oracle for
         guessing tokens. */
      var notFound = err(404, "This document link is not valid — it may have expired.");
      var resolve = function (token) {
        if (!token) return null;
        /* Without m10 there is no doc_token column at all, so no link can
           resolve — the same 404, which is what an un-migrated database does. */
        if (!MIGRATIONS.m10) return null;
        return DB.cases.filter(function (c) { return c.doc_token && String(c.doc_token) === token; })[0] || null;
      };
      /* What the CLIENT is allowed to see: requested and received only. A
         waived item is a decision the firm made about its own file; showing it
         invites "why have you crossed that out" on a page with nobody to ask. */
      var visible = function (caseId) {
        return caseChecklist(caseId).filter(function (d) { return d.status !== "waived"; });
      };

      if (method === "GET") {
        var gToken = String(((req && req.query && req.query.token) || "")).trim();
        var gCase = resolve(gToken);
        if (!gCase) return notFound;
        var gcl = DB.clients.filter(function (x) { return x.id === gCase.client_id; })[0] || {};
        var items = visible(gCase.id).map(function (d) {
          return { id: d.id, item: d.item, status: d.status };
        });
        var out = items.filter(function (d) { return d.status === "requested"; });
        return {
          ok: true,
          company: setting("company_name", "NexMoney"),
          /* first name only — a document link gets forwarded and pasted into
             WhatsApp, so everything this returns is effectively public */
          first_name: gcl.first_name || null,
          greeting: "Hi " + (gcl.first_name || "there"),
          items: items,
          outstanding: out.length,
          complete: out.length === 0
        };
      }

      /* ---- POST ---------------------------------------------------------
         Multipart or nothing. `req.form` is only populated by the fetch stub
         when the request body was a FormData; a JSON string never produces
         one, which is how the 400 below happens "before any logic". */
      var form = req && req.form;
      if (!form) return err(400, "This upload was not sent as a file upload.");
      /* THE HONEYPOT, CHECKED FIRST. Before the token, before the item, before
         anything is looked up: a bot must not be able to use the error codes
         below as a probe. Answers 200 with nothing in it. */
      var pot = form.website;
      if (pot != null && String(pot.value != null ? pot.value : pot).trim() !== "") return { ok: true };

      var fToken = form.token ? String(form.token.value != null ? form.token.value : form.token).trim() : "";
      if (!fToken) return err(400, "This upload did not say which link it came from.");
      var cs = resolve(fToken);
      if (!cs) return notFound;

      /* Rate cap, per link, per rolling minute. A link with no login on it is a
         public endpoint; without a cap one leaked URL is a way to fill the
         firm's storage. Deliberately per TOKEN rather than per IP — the point
         is to bound what one link can do. */
      var nowMs = Date.now();
      var hits = (DOC_UPLOAD_HITS[fToken] || []).filter(function (t) { return nowMs - t < 60000; });
      if (hits.length >= DOC_UPLOAD_RATE_CAP) { DOC_UPLOAD_HITS[fToken] = hits; return err(429, "That is a lot of uploads at once — wait a minute and try again."); }
      hits.push(nowMs);
      DOC_UPLOAD_HITS[fToken] = hits;

      var itemId = form.item_id ? String(form.item_id.value != null ? form.item_id.value : form.item_id).trim() : "";
      if (!itemId) return err(400, "This upload did not say which document it is.");
      /* Matched on ID against the list the CLIENT can see. An id belonging to a
         waived row is "unknown" from here, because the GET never showed it. */
      var row = visible(cs.id).filter(function (d) { return d.id === itemId; })[0];
      if (!row) return err(404, "That document is not on this checklist.");
      if (row.status === "received") return err(409, "We already have that one — thank you.", { status: row.status });

      var file = form.file;
      if (!file || typeof file !== "object" || typeof file.size !== "number") return err(400, "No file was attached.");
      var filename = String(file.name || "").trim();
      if (!filename) return err(400, "That file arrived without a name.");
      if (!file.size) return err(400, "That file is empty.");
      if (file.size > DOC_UPLOAD_MAX_BYTES) return err(413, "That file is over the 10MB limit.");
      /* THE EXTENSION IS AUTHORITATIVE, not file.type — a browser reports
         application/octet-stream for HEIC and an empty string often enough that
         trusting it would refuse legitimate photographs from iPhones. */
      var ext = (filename.split(".").pop() || "").toLowerCase();
      if (DOC_UPLOAD_EXT.indexOf(ext) < 0) return err(415, "That file type is not accepted — send a PDF, JPG, PNG or HEIC.");
      /* …and then the bytes have to agree with it, because an extension is
         something a caller chooses. */
      var head = await docUploadHead(file);
      if (!docBytesMatch(ext, head)) return err(415, "That file does not look like a " + ext.toUpperCase() + " inside.");
      if (DOC_UPLOAD_FAIL_STORAGE) { DOC_UPLOAD_FAIL_STORAGE = false; return err(500, "The file could not be stored — please try again."); }

      /* The claim, and the race. Re-read the row: between the check above and
         here another request on the same link could have taken it. */
      var live = caseChecklist(cs.id).filter(function (d) { return d.id === itemId; })[0];
      if (!live || live.status !== "requested") return err(409, "We already have that one — thank you.", { status: live ? live.status : "unknown" });
      var when = iso(new Date());
      live.status = "received";
      live.received_at = when;
      /* R13 · BUCKET CORRECTION — the deployed function's real path shape:
         `<caseId>/<slug>-<ts>.<ext>` INSIDE the "client-docs" bucket, with
         `case_documents.storage_path` carrying the bucket prefix on it. A
         real storageFiles entry is registered too, the same shape
         `storage.upload()` writes, so the file this row points at actually
         exists in the mock's storage registry. */
      var pathInBucket = cs.id + "/" + slugify(live.item) + "-" + Date.now() + "." + ext;
      storageFiles[DOC_STORAGE_BUCKET + "/" + pathInBucket] = { size: file.size, type: file.type || "application/octet-stream", at: when };
      live.storage_path = DOC_STORAGE_BUCKET + "/" + pathInBucket;
      /* THE NOTE. A file arriving through a link is a real event on the case,
         because an adviser looking at the file next week must be able to see it
         happened without knowing this feature exists. created_by is null: the
         service role wrote it, not a member of staff. */
      DB.case_notes.push({
        id: nid("nt"), case_id: cs.id,
        body: "Document received via upload link: " + live.item,
        created_by: null, created_at: when
      });
      return {
        ok: true,
        item: live.item,
        outstanding: visible(cs.id).filter(function (d) { return d.status === "requested"; }).length
      };
    },
    /* ---------------------------------------------------------------------
       r9 · nps-capture v2 — the review form coming back.

       v1 recorded the score and stopped, which is the wrong way round: a 10 needs
       nothing from anybody, and a 4 is the most urgent thing in the firm's inbox
       that day. v2 keeps the score AND, for a detractor (6 or below):

         · writes the client's own words to the case, verbatim, prefixed with the
           score — "Review feedback (4/10): <text>". Verbatim on purpose: a
           summary of a complaint is a way of losing the complaint.
         · puts a CALL task on the case's adviser, due TOMORROW. Not today —
           an unhappy client submitting a form at 23:40 should not generate a
           task that is already overdue by the time anybody reads it; and not in
           a week either.

       No email goes anywhere. Nobody wants an automated reply to a complaint.

       THE TOKEN IS THE ONLY THING THAT RESOLVES A CASE, and the guard below runs
       before ANY write. This is stated at length because an earlier version of
       this stub got it wrong in a way the deployed function never did: it looked
       the case up by `case_id` FIRST and only fell back to the token, and it
       never checked the two agreed. Against that stub a POST carrying somebody
       else's case id and no token at all returned 200 and rewrote their score,
       wrote a note and raised a task on their file. The deployed v1 has always
       had `if (!kase || !kase.nps_token || kase.nps_token !== token) return 404`
       ahead of every write, so production was never open to it — but a mock that
       is more permissive than the thing it mirrors is worse than no mock, because
       it makes a page look safe on a property the harness is not actually
       testing. The rules, in the order the handler applies them:

         website present   200 {ok:true} and NOTHING else — the honeypot, first,
                           so the codes below cannot be used as a probe
         no token          400. A submission that names no link is malformed;
                           there is nothing to resolve and nothing to write
         unknown token     404, the same 404 an expired one gets
         case_id ≠ the token's case
                           404. `case_id` is an ASSERTION TO BE VERIFIED, never a
                           lookup key — this is the whole of the fix
         score             WRITE-ONCE. effective = stored ?? request: a case that
                           already holds a score keeps it, and the request's
                           number cannot move it. The band that decides whether a
                           call-back is raised is therefore the score the firm
                           actually captured, not one edited into a URL

       Every refusal above returns before a single row is touched.
       --------------------------------------------------------------------- */
    "nps-capture": function (body) {
      var notFound = { __status: 404, error: "This review link is not valid — it may have expired." };
      var bad = function (msg) { return { __status: 400, error: msg }; };
      /* THE HONEYPOT, CHECKED FIRST — before the token, before anything is looked
         up, for the same reason doc-upload checks its own first: a bot must not
         be able to read the codes below as a probe. Answers 200 with nothing in
         it and writes nothing at all. */
      var pot = body && body.website;
      if (pot != null && String(pot).trim() !== "") return { ok: true };

      var token = String((body && body.token) || "").trim();
      if (!token) return bad("This review link is not valid — it may have expired.");
      var cs = DB.cases.filter(function (c) { return c.nps_token && String(c.nps_token) === token; })[0];
      /* THE GUARD, spelled out the way the deployed function spells it. */
      if (!cs || !cs.nps_token || String(cs.nps_token) !== token) return notFound;
      /* …and the case id, if one came along, has to BE that case. */
      var caseId = String((body && body.case_id) || "").trim();
      if (caseId && caseId !== cs.id) return notFound;

      /* WRITE-ONCE. The stored score wins where there is one; the request's is
         accepted only to fill a blank. A client re-following their own link with
         a different number in it changes nothing. */
      var stored = (cs.nps_score == null || cs.nps_score === "") ? null : Number(cs.nps_score);
      var asked = (body && body.score != null && body.score !== "") ? Number(body.score) : null;
      var score = stored != null ? stored : asked;
      if (score == null || !isFinite(score) || score < 0 || score > 10) {
        return bad("A review score must be a whole number from 0 to 10.");
      }
      score = Math.round(score);
      var reason = String((body && (body.reason || body.comment)) || "").trim();
      var when = iso(new Date());
      if (stored == null) { cs.nps_score = score; cs.updated_at = when; }
      var out = { ok: true, score: score, detractor: score <= 6, note_created: false, task_created: false };
      if (score > 6) return out;
      if (reason) {
        DB.case_notes.push({
          id: nid("nt"), case_id: cs.id,
          body: "Review feedback (" + score + "/10): " + reason,
          created_by: null, created_at: when
        });
        out.note_created = true;
      }
      /* The call happens whether or not they typed anything — a bare 4 still
         needs a phone call. Idempotent on the title, so a client who submits the
         form twice does not create two. */
      var title = "Call " + clientName(cs.client_id) + " — review feedback needs attention";
      var dupe = DB.case_tasks.some(function (t) { return t.case_id === cs.id && t.title === title && !t.done_at; });
      if (!dupe) {
        DB.case_tasks.push({
          id: nid("tk"), case_id: cs.id, title: title,
          /* R12b flake fix — live request, compared by tests against a
             Europe/London "tomorrow"; see dateOnlyLondon() above. */
          due_date: dateOnlyLondon(shift(1)), done_at: null,
          created_by: null,                          /* SECURITY DEFINER — a public form wrote it */
          assigned_to: cs.assigned_to || null, created_at: when
        });
        out.task_created = true;
      }
      out.task_title = title;
      return out;
    },
    "assistant": function (body) {
      var last = "";
      try { var ms = (body && body.messages) || []; last = (ms[ms.length - 1] || {}).content || ""; } catch (e) { }
      return {
        ok: true,
        reply: "**Mock assistant** — I can see " + DB.cases.filter(function (c) { return isLive(c.stage); }).length +
          " live cases and " + DB.case_tasks.filter(function (t) { return !t.done_at; }).length +
          " open tasks.\n\nYou asked: " + (last ? "“" + String(last).slice(0, 140) + "”" : "(nothing yet)") +
          "\n\nThis is a sandbox stub — no model was called.",
        actions: []
      };
    }
  };
  /* r9 — the query string, parsed. doc-upload is the first edge function in this
     app that is reached with a GET and a `?token=`, because it is the only one a
     client without a login ever opens; everything else is a POST with a JSON
     body. The handler signature gains an optional second argument rather than
     changing, so every existing handler is untouched. */
  function parseQuery(url) {
    var q = {};
    var i = String(url).indexOf("?");
    if (i < 0) return q;
    String(url).slice(i + 1).split("&").forEach(function (pair) {
      if (!pair) return;
      var bits = pair.split("=");
      var k = decodeURIComponent(bits[0] || "").trim();
      if (!k) return;
      q[k] = decodeURIComponent((bits[1] || "").replace(/\+/g, " "));
    });
    return q;
  }
  /* r9 · MULTIPART. `doc-upload` is the only deployed function that takes a
     file, and it takes multipart/form-data and nothing else — a JSON body is a
     400 there before any logic runs. The stub therefore has to be able to tell
     the two apart, so a FormData body is unpacked into `req.form` (values kept
     as they are, File objects included) and `body` stays null. A JSON body
     never produces a `req.form`, which is exactly how that 400 happens.
     Every existing handler still reads `body` and is untouched. */
  function parseForm(b) {
    if (typeof FormData === "undefined" || !(b instanceof FormData)) return null;
    var form = {};
    b.forEach(function (v, k) { if (!(k in form)) form[k] = v; });
    return form;
  }
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var m = SUPABASE_HOST_RE.exec(url);
    if (!m) return realFetch ? realFetch(input, init) : Promise.reject(new Error("fetch unavailable"));
    var fnName = m[1];
    var handler = EDGE[fnName];
    var raw = init && init.body;
    var form = parseForm(raw);
    var body = null;
    if (!form) { try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; } }
    var req = {
      method: String((init && init.method) || (input && input.method) || "POST").toUpperCase(),
      url: url, query: parseQuery(url), form: form
    };
    if (!handler) return Promise.resolve(jsonResponse({ error: "Function not found: " + fnName }, 404));
    return new Promise(function (resolve) {
      setTimeout(function () {
        /* Handlers may be sync (all the originals) or async (doc-upload, which
           has to read the file's first bytes). Promise.resolve covers both, so
           adding one async handler did not touch the other fifteen. */
        Promise.resolve().then(function () { return handler(body, req); })
          .then(function (out) { return out || {}; })
          .catch(function (e) { return { error: String((e && e.message) || e) }; })
          .then(function (out) {
            var status = out.__status || 200;
            delete out.__status;
            resolve(jsonResponse(out, status));
          });
      }, 10);
    });
  };

  /* =========================================================================
     CLIENT
     ======================================================================= */
  function createClient(url, key, opts) {
    var client = {
      supabaseUrl: url,
      supabaseKey: key,
      auth: auth,
      storage: storage,
      from: function (table) { return new Builder(table); },
      rpc: function (name, args) { return rpcCall(name, args); },
      schema: function () { return client; },
      channel: function (name) {
        var ch = {
          topic: name,
          on: function () { return ch; },
          subscribe: function (cb) { if (typeof cb === "function") setTimeout(function () { cb("SUBSCRIBED"); }, 0); return ch; },
          unsubscribe: function () { return Promise.resolve("ok"); },
          send: function () { return Promise.resolve("ok"); }
        };
        return ch;
      },
      removeChannel: function () { return Promise.resolve("ok"); },
      removeAllChannels: function () { return Promise.resolve([]); },
      getChannels: function () { return []; },
      functions: {
        invoke: function (name, o) {
          return window.fetch("https://mock.supabase.co/functions/v1/" + name, {
            method: "POST", body: JSON.stringify((o && o.body) || {})
          }).then(function (r) { return r.json(); }).then(function (j) { return { data: j, error: null }; });
        }
      }
    };
    /* handles for the smoke harness / persona agents — never used by app.js */
    window.__mockDb = client;
    window.__mock = {
      db: DB, personas: PERSONAS, persona: ME_KEY,
      role: function () { return myRole(); },
      counts: function () {
        var o = {};
        Object.keys(DB).forEach(function (t) { o[t] = DB[t].length; });
        o.v_alerts = vAlerts().length;
        return o;
      },
      /* --- round-5 test hooks ------------------------------------------- */
      /* Migration state. All ON by default; turn one OFF to exercise the app's
         feature-detect fallback, e.g. __mock.setMigrations({m2:false}). */
      /* R68 · M15 — the server's Resend key, as a flag (see MOCK_RESEND_KEY). Returns the
         value it set, so a test can assert the flip took. */
      resendKey: function () { return MOCK_RESEND_KEY; },
      setResendKey: function (v) { MOCK_RESEND_KEY = !!v; return MOCK_RESEND_KEY; },
      migrations: MIGRATIONS,
      setMigrations: function (patch) {
        Object.keys(patch || {}).forEach(function (k) {
          if (Object.prototype.hasOwnProperty.call(MIGRATIONS, k)) MIGRATIONS[k] = !!patch[k];
        });
        return clone(MIGRATIONS);
      },
      /* What the last process-emails run actually did — including the composed
         per-adviser sign-off for every message it sent. */
      lastEmailRun: function () { return LAST_EMAIL_RUN ? clone(LAST_EMAIL_RUN) : null; },
      /* --- round-9 doc-upload hooks -------------------------------------
         The deployed function's 429 and 500 are real rules with no other way
         in: the rate cap needs twenty-one uploads to reach and the storage
         failure needs storage to fall over. Both are shrunk/armed from here
         rather than being softened in the handler, so what the tests exercise
         is the same code path a real client hits. */
      setDocUploadRateCap: function (n) {
        DOC_UPLOAD_RATE_CAP = Number(n) > 0 ? Number(n) : 20;
        DOC_UPLOAD_HITS = {};
        return DOC_UPLOAD_RATE_CAP;
      },
      resetDocUploadRate: function () { DOC_UPLOAD_HITS = {}; return true; },
      failDocStorageOnce: function () { DOC_UPLOAD_FAIL_STORAGE = true; return true; },
      /* Fast-forward a snooze so expiry can be tested without waiting. */
      expireSnooze: function (alertId) {
        var a = DB.watch_alerts.filter(function (x) { return x.id === alertId; })[0];
        if (!a) return null;
        a.snoozed_until = iso(shift(-1));
        return clone(a);
      },
      /* Run the production queueing RPCs on their own (no sending). */
      queueAutomatedEmails: function () { return queueAutomatedEmails(); },
      queueCommsExtras: function () { return queueCommsExtras(); },
      /* B6 (r5_batch4.js) — the harness has no real backend, so nothing survives a literal
         browser reload or a second browser tab (every table is page-local JS memory, by design —
         see the R5-5 "no sticky store" test in r5_batch1.js for the same constraint on leads).
         This proves the part that DOES matter for "sticks across users": the row lives in the
         shared table, gated only by the M4 RLS policy ("dup dismiss read staff" — any staff role),
         not by who inserted it. CURRENT_UID is restored immediately after. */
      readTableAs: function (personaKey, table) {
        var prev = CURRENT_UID;
        CURRENT_UID = personaKey;
        var rows = readFilter(table, DB[table] || []);
        CURRENT_UID = prev;
        return clone(rows);
      }
    };
    /* ------------------------------------------------------------------
       R8-REV fixture hook (APPEND-ONLY — nothing above this line changed).

       tests/r8_rev.js needs a book in which the Revolution sample file
       actually OVERLAPS what we hold: the sync's whole subject is the
       field-level difference between our case and the network's row, and
       the seeded cases deliberately do not line up with
       tests/fixtures/revolution_sample.csv (FIXTURES-R7.md § 4 says as
       much — only the names and the seven fixed DOBs are guaranteed).

       These two cases are therefore NOT part of the default fixture set:
       nothing is inserted until a test calls this, so no other suite's
       counts, segments, reports or alerts move by a single row.

         · James Whitfield — the same mortgage as row 1 of the sample
           (Halifax, same rate end), with the gaps a real book has: no
           ERC date, no protection outcome, no lead source, no fees. Every
           one of those is an UPDATE-into-blank.
         · Nigel Trewin — the same mortgage as row 11 (The Mortgage Works,
           rate end 59 days from the file's), still sitting at Application
           with a rate end that DISAGREES. That is the conflict row: KEEP
           by default, and an incoming "Completed" that must not move the
           stage on its own.

       Assigned to two different advisers on purpose, so the money rule
       (Owner always · adviser on their own case · Administrator never)
       has both sides to test.
       ------------------------------------------------------------------ */
    window.__mock.seedRevolutionCases = function () {
      var template = DB.cases[0] || {};
      var byName = function (n) {
        return DB.clients.filter(function (c) { return [c.first_name, c.last_name].filter(Boolean).join(" ") === n; })[0];
      };
      var SPEC = [
        ["James Whitfield", {
          lender: "Halifax", product_name: "2 Year Fixed 85% LTV", rate_type: "fixed", rate_percent: 4.44,
          rate_end_date: "2027-05-31", erc_end_date: null, loan_amount: 186000, property_value: 242000,
          term_years: 28, case_kind: "remortgage", stage: "completed", completed_at: iso("2024-03-22T12:00:00Z"),
          submitted_at: "2024-02-04", fee_status: "paid", proc_fee: null, broker_fee: null,
          protection_status: "not_discussed", protection_commission: null, gi_status: "not_discussed",
          lead_source: null, assigned_to: "p2"
        }],
        ["Nigel Trewin", {
          lender: "The Mortgage Works", product_name: "5 Year Fixed 75% LTV", rate_type: "fixed", rate_percent: 5.24,
          rate_end_date: "2031-01-31", erc_end_date: null, loan_amount: 212000, property_value: 298000,
          term_years: 19, case_kind: "buy_to_let", stage: "application", completed_at: null,
          submitted_at: "2025-06-09", fee_status: "paid", proc_fee: null, broker_fee: null,
          protection_status: "declined", protection_commission: null, gi_status: "not_discussed",
          lead_source: "Introducer", assigned_to: "p3"
        }]
      ];
      var made = [];
      SPEC.forEach(function (s) {
        var cl = byName(s[0]);
        if (!cl) return;
        var row = {};
        Object.keys(template).forEach(function (k) { row[k] = null; });
        row.id = nid("ca");
        row.client_id = cl.id;
        row.rate_end_estimated = false;
        row.created_at = iso(shift(-200));
        row.updated_at = iso(shift(-9));
        Object.keys(s[1]).forEach(function (k) { row[k] = s[1][k]; });
        DB.cases.push(row);
        made.push(row.id);
      });
      return made;
    };
    return client;
  }

  /* R30 — test hook: toggle whether error_events exists on this "database". Default true;
     set false to make every op on the table return a PostgREST 42P01, exercising the
     app's feature-gate/degrade path (errorEventsOff + the "isn't enabled" note). */
  window.__setErrorEventsSupported = function (b) { errorEventsSupported = !!b; return errorEventsSupported; };

  /* R43 — the same hook for saved_views: set false to make every op 42P01, which is the
     un-migrated database the app's localStorage fallback (viewsMode "local") exists for. */
  window.__setSavedViewsSupported = function (b) { savedViewsSupported = !!b; return savedViewsSupported; };

  window.supabase = { createClient: createClient, SupabaseClient: function () { }, __isMock: true };
})();
