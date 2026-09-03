# R81 · B — strict column mode: findings from the full battery

Context: the R79 code-health panel confirmed that `admin/mock-supabase.js`
threw on unknown TABLES (42P01) and unknown RPCs (42883) but silently forgave
ghost COLUMN names — a select naming a ghost column returned undefined fields,
a filter on one matched nothing, an insert/update writing one stored it —
while production PostgREST fails every one of those with 42703. R81 turned on
per-table column enforcement (default ON, `window.__mockStrict = false` the
only escape hatch, no per-call allowlist) and re-ran the ENTIRE battery under
it. Every violation was triaged into (a) real latent app bug, (b) registry
gap, or (c) a test's own ghost column.

## (a) Real latent bugs in app code — ghost columns app.js reads/writes

**NONE FOUND.** Two independent passes agree:

1. **Dynamic:** the full battery (`smoke.js` + all 84 pre-existing suites —
   every page for all four personas, plus the scale suites) ran to green under
   strict mode, with not one `MOCK STRICT` throw anywhere in the logs, let
   alone one attributable to `admin/app.js` / `admin/core.js`.
2. **Static:** every literal select string, filter/order column and `.or()`
   column in `app.js` + `core.js` was extracted and checked against the final
   registry — zero suspects. (The extractor was self-tested against a planted
   ghost select column, a planted ghost embed column, a planted ghost `.eq()`
   and a planted ghost `.order()`: it named all four, so "zero suspects" is a
   result, not a silent no-op. Dynamically-built selects — `DASH_CASE_COLS`,
   `CALLPACK_SELECT`, `BOARD_CASE_COLS`, `CARE_SELECT`, `AUDIT_COLS`,
   `R44_CASE_COLS`, the propOn-conditional strings — are all exercised by the
   battery and validated there.)

No CTO follow-ups arise from this class.

## (b) Registry gaps — prod genuinely has the column; the mock never seeded it

Fixed in the registry (`STRICT_EXTRA_COLUMNS` in `admin/mock-supabase.js`),
plus one parity default:

| Column | Evidence it is real | Fix |
|---|---|---|
| `email_queue.lead_id` | Production's AFTER-INSERT trigger on `leads` queues a `lead_ack` carrying `lead_id` and NO client_id; the Emails page reads `e.lead_id` to name the enquirer and open the enquiry (app.js "R7-5 — THE LEAD ACKNOWLEDGEMENTS"). The mock's row shape never carried the key — the R79 `nps_token` situation again. Surfaced by `tests/r79_send.js` seeding a lead-ack row by hand. | Registered AND nulled by `applyInsertDefaults` on the standing parity rule (select("*") always returns the key). |
| `case_emails.from_name` | The mock's own `run_watchtower` (mirrored from production's ten rules) reads `e.from_name || e.from_email`; `tests/r65_watchtower.js` seeds rows with it. No fixture row carries one. | Registered. |
| `email_queue.subject` / `body_html` / `attachment_path` | R66 · M8 columns — `applyInsertDefaults` already nulls all three on every app insert, but every LOAD-TIME fixture row is pushed raw without the keys, so the fixture-row union alone missed real columns. Surfaced by `tests/r66_comms.js`. | Registered. |
| `cases.protection_quoted_at` / `protection_quoted_by` | app.js writes both in one `.update()` when a case is marked "quoted" (r12a §D9); the watchtower's `protection_quote_stale` rule reads the first; the mock has never formally declared either (one fixture row gets `_at` by direct assignment; `_by` exists on no row). | Hand-listed. |
| Tables seeded EMPTY on purpose | `duplicate_dismissals` (surfaced by r5_batch4/r13/r14/r20 — the Data Health page selects `a_id,b_id`), `error_events`, `saved_views`, `proc_rates`, `commission_statements`, `commission_lines`, `referrals`, `audit_log` (no load-time rows — fixture seeding bypasses `auditRow`). | Hand lists transcribed from `applyInsertDefaults` + the schema comments. |

One structural fix in the same class: the registry is snapshotted **eagerly at
load** rather than lazily per table — `tests/r20.js` deletes every case (which
cascades `fact_finds` to zero rows) before `fact_finds` is first queried, and
a lazy registry computed after that wipe would have contained no fact_finds
columns at all.

## (c) Suites' own ghost columns — patched, commented R81

| Suite | Ghost column | Fix |
|---|---|---|
| `tests/r69_polish.js` (§D seed) | `email_queue.body` — prod's text column is `body_html` (R66 · M8) | Renamed to `body_html`; no assertion changed. |
| `tests/r78_hands.js` (§SMS bulk seeds, ×2) | `sms_queue.body` — no such column anywhere: send-sms composes the message from `sms_type`, app.js never writes a body | Key dropped from both seed inserts; no assertion changed. |

## The registry, measured

28 entries — the 27 fixture DB tables plus the `v_alerts` view — carrying 334
columns in total. Widest: `cases` (70), `commission_lines` (21), `clients`
(17), `v_alerts`/`watch_alerts` (16), `email_queue` (14). `tests/r81_strict.js`
§A2 enumerates `Object.keys(window.__mock.db)` and asserts every one of them
has a non-empty registry entry, so a table added in a later round cannot
quietly arrive with no schema behind it.

## Battery under strict mode

Full battery run end-to-end under strict mode from patched copies in
`/tmp/r81b` (REPO=/root/wt-b, PORT=8601, `node smoke.js` first):

- **`smoke.js` 152 checks, 0 failures** (and it regenerated `admin/mock.html`
  from `admin/index.html` byte-identically — no drift).
- **All 84 pre-existing battery suites: 0 failed**, 7,597 checks between them.
- **`tests/r81_strict.js` 40 passed, 0 failed.**
- Battery total: **85 suites, 7,637 checks, 0 failures.**
- **Zero `MOCK STRICT` throws anywhere in the battery logs** outside
  `r81_strict.js`'s own deliberate probes — which is the point: after the (b)
  registry fixes and the two (c) suite patches, nothing the app or the suites
  do names a column production does not have.

Run honesty: three suites (`r12b`, `r14`, `r63_docs`) hit the runner's 900 s
wall on the first pass — all three stalled on a `page.evaluate` immediately
after a fresh `newPage()`, with the box idle (load 0.01) and **no `MOCK
STRICT` string in any of their logs**. Re-run serially they are green
(`r12b` 157/0, `r14` 169/0, `r63_docs` 74/0); these are Playwright/2-core
flakes, not strict-mode failures. Their re-run counts are the ones in the
totals above.

The rule going forward: a strict throw means fix the CALLER or fix the
REGISTRY — never add an allowlist, and never flip `__mockStrict` off except
around a probe that deliberately needs the lenient pre-R81 mock.
