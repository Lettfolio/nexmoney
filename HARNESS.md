# HARNESS.md — NexMoney admin test harness runbook

For any future agent session picking this up cold. Read this before touching
`admin/mock-supabase.js`, `smoke.js`, or anything in `tests/`.

## What this is

A sandbox-only mock of the supabase-js v2 surface that `admin/app.js` actually
uses, so the whole admin app can be smoke- and regression-tested headlessly
with Playwright, with no real Supabase project involved.

- **`admin/mock-supabase.js`** — the mock. Implements every table, view, RPC,
  edge function, auth call and storage call `app.js` calls, backed by an
  in-memory fixture DB (seeded deterministically, not from real data). Fixtures
  include multi-property clients (several cases across distinct UK addresses,
  one property with two cases from the same client at different times, one
  address shared by two clients who bought/sold between them) — this exists
  because Round 6 added property-address-aware behaviour that only shows up
  when a client has more than one property.
- **`admin/mock.html`** — a byte-identical copy of `admin/index.html` except
  the Supabase CDN `<script>` tag is swapped for `<script
  src="mock-supabase.js"></script>`. **It is generated, not hand-edited.**
  `smoke.js` regenerates it from `admin/index.html` on every run
  (`generateMockHtml()`) and throws if the two files differ by anything other
  than that one script tag — so it can never silently drift from the real
  admin page. If you edit `admin/index.html`, just run `smoke.js` again; do
  not touch `mock.html` by hand.
- **Personas** — selected via `?as=` query param on `admin/mock.html`:
  - `?as=p1` Kim Martin, **admin** (default if `as` is omitted or unrecognised)
  - `?as=p2` Wayne Kellow, adviser
  - `?as=p3` Luke Richards, adviser
  - `?as=p4` Daniel Potts, owner
  - `?as=p5` Rachel Foyle, introducer — deliberately fails the staff login
    gate; used to test that the gate actually rejects non-staff, not iterated
    by the smoke page-load loop

## How to run it

```
cd /root/nx                       # repo root — index.html/style.css etc. live here
python3 -m http.server 8099       # serves the repo root; admin/*.js are referenced
                                   # as absolute /admin/... paths from index.html
```

Then either open `http://localhost:8099/admin/mock.html` (add `?as=p2` etc. to
switch persona) in a browser, or just run the automated battery below — each
test file will spawn its own server on 8099 if one isn't already listening, so
running `python3 -m http.server 8099` first is a convenience, not a strict
requirement.

## The battery

Run in this order (smoke first — it's what regenerates `mock.html`):

```
node smoke.js
node tests/r5_batch1.js
node tests/r5_batch2.js
node tests/r5_batch3.js
node tests/r5_batch4.js
node tests/r5_batch5.js
node tests/r5_batch6.js
node tests/r5_batch7.js
node tests/r5_batch8.js
node tests/r5_batch9.js
node tests/r64.js
node tests/r8_touch.js
node tests/r8_rev.js
node tests/r9_adv.js
node tests/r9_docs.js
node tests/r9_embed.js
node tests/r11_ux.js
node tests/r12a.js
node tests/r12b.js
node tests/r13.js
node tests/r14.js
node tests/r15.js
node tests/r16.js
```

Current green counts (end of round 16). r8_touch/r8_rev/r11_ux still carry the
151/176/123 figures the R13 note below already flagged (fixture-derived
counts, unrelated to R15/R16 — see "compute test expectations from fixtures
at runtime" in Standing rules); every other suite's count is unchanged by R16
except the new r16.js row itself — R16 needed NO existing-suite edits (see the
R16 notes below for why):

| Suite | Checks |
|---|---|
| `smoke.js` | 144 |
| `tests/r5_batch1..9.js` (sum) | 557 |
| `tests/r64.js` | 91 |
| `tests/r8_touch.js` | 151 |
| `tests/r8_rev.js` | 176 |
| `tests/r9_adv.js` | 169 |
| `tests/r9_docs.js` | 255 |
| `tests/r9_embed.js` | 104 |
| `tests/r11_ux.js` | 123 |
| `tests/r12a.js` | 114 |
| `tests/r12b.js` | 158 |
| `tests/r13.js` | 142 |
| `tests/r14.js` | 167 |
| `tests/r15.js` | 160 |
| `tests/r16.js` | 81 |
| **Total** | **2,592** |

R16 notes: BTL rental + ICR affordability, and a submit-to-lender tracker.
Six new plain nullable `cases` columns, mirrored into the mock with NO
migration toggle — same precedent as R14b's `mortgage_account_number`: they
just exist on every row (null until written), defaulted in both `mkCase()`
and `applyInsertDefaults()`, so `btlIcrSupported()`/`lenderTrackSupported()`'s
`hasOwnProperty` probe always sees them and the block/tracker always render in
this harness. The BTL trio — `monthly_rent`, `icr_stress_rate` (defaults to
5.5 when null/0/NaN), `icr_required_pct` (defaults to 145) — feeds ONE
canonical helper, `btlIcr(c)` in app.js: `icrPct = round(annualRent /
stressInterest * 100)` (integer, null with no loan), `pass = icrPct >=
required`, `yieldPct = round(annualRent / propertyValue * 1000) / 10` (1dp).
The chip (`#btl-icr-chip`, echoed at `#cs-btl-icr` in the case header) is red
on fail, green on pass, grey ("ICR — add loan amount") when there is rent but
no loan, and renders nothing at all when there is no rent — the block itself
(`#case-btl-block`) is kind-gated to `case_kind === 'buy_to_let'` and re-gates
LIVE on the Type `<select>` via `kindSel.onchange`, no reopen needed; the chip
recomputes live too, on a form-level `input` listener, independent of Save.
The tracker trio — `lender_reference`, `application_status`
(submitted/underwriting/valuation/offer_issued/null), `application_status_at`
— drives a header chip (`#cs-lender-status`) and a board-card badge
(`lenderStatusBadgeHtml`), both gated to `LENDER_TRACK_STAGES`
(decision_in_principle/application/offer/exchange — the same R15 relevance
window), and a chase nudge (`#cs-lender-chase`,
`⏰ In {Status} {N} days — chase the lender`) that fires only for
submitted/underwriting/valuation whose `application_status_at` (falling back
to `submitted_at`) is `>= LENDER_CHASE_DAYS` (10) days old — never for
offer_issued or a null status, however old. **The board's `📤 sub {date}`
badge was NOT deleted** — `lenderStatusBadgeHtml` falls back to that exact
markup whenever `application_status` is null (or the stage is outside the
tracker window), so it only supersedes the old badge on a case that actually
has a tracked status; `tests/r16.js` §F asserts both shapes on two fresh
cases. On Save: `application_status_at` is (re)stamped only when
`application_status` actually CHANGES on that save (an unrelated edit to a
case that already has a status/stamp leaves the stamp untouched — the chase
clock does not reset on every edit); a `submitted_at` set for the FIRST time
(the case had none before) with the status left blank defaults
`application_status` to `'submitted'` and stamps it too; a case that already
carried a `submitted_at` before this round does NOT get a status invented for
it retroactively. Grepped app.js to confirm no existing test asserted the old
board badge text/emoji before touching anything — **none did**, so the whole
pre-existing battery (smoke + every suite through r15) needed ZERO edits; only
`admin/mock-supabase.js` (the six columns, `mkCase()`, `applyInsertDefaults()`,
and a light fixture pass on four already-existing cases — Gareth Pollard's
application/offer-stage BTL cases for a live ICR fail/pass example, Harold
Mainwaring's exchange case and the Fairweathers' BTL offer case for a
chaseable/not-chaseable lender-tracker example — chosen to avoid Melanie
Underhill's `ca061`, which R13's own fixture pass already uses for the
`app_not_submitted` watchtower rule) and the new `tests/r16.js` changed.
`tests/r16.js` mints every one of its own exact-scenario cases fresh via
`mkClientCase`, on ONE shared page for the whole file, exactly like
`tests/r15.js` — and needed the same `.case-details` collapsed-by-default fix
r13.js already carries (`<details class="case-details" ${id ? "" : "open"}>`
starts CLOSED on an existing case, which hides every field inside it —
including Type, the BTL block and the lender-tracker fields — from
Playwright's actionability checks even though `$eval` can still read their
text; `openCase()` now force-opens it after every call). Not tested (no
harness path exists for it, same as `mortgage_account_number`): the
"database without the migration" degrade branch — neither R16 column trio was
wired into `MIGRATION_COLUMNS`, on purpose, matching the R14b precedent.

R15 notes: the case modal's action bar is now stage/kind-reactive.
`CASE_ACTION_RULES` (app.js) maps each of the eight ORIGINAL action ids —
act-factfind, act-appt, act-offer, act-fee, act-paid, act-review,
act-reminder, act-evidence — to the stages where it belongs in the PRIMARY
row; everywhere else it renders into `#case-more-actions`, an overflow menu
that starts `class="hidden"` and is opened by `#case-more-actions-toggle`
(click flips the class, nothing more). **Every id keeps its handler and stays
in the DOM at every stage** — gating only decides which row paints it, never
whether it exists — so `page.click("#act-XXX")` on a non-primary action now
needs the toggle opened first. One brand-NEW id, `#act-record-reason`, is
different: it exists in the DOM ONLY at `not_proceeding` (primary/hero
there), everywhere else it is genuinely absent, not just overflowed —
`caseActionBarHtml`'s `onlyStage` guard. `act-offer`/`act-view-offer` also
carry a kind override (`notKinds: ["product_transfer"]`) that drops them to
overflow even at a stage (offer/exchange/completed) where they would
otherwise be primary. Sections: the security card (`#case-sec-wrap`) and
Files (`#case-files`) are wrapped and hidden via `class="hidden"` at
enquiry/fact_find, shown DIP→terminal (`CASE_SECTION_RULES`); Documents
renders as a plain `<div>` up to Exchange and collapses into a `<details>` at
completed/not_proceeding (`#case-docs-body` exists identically in both).
Type reactivity (`c.case_kind`): a product_transfer case hides
`#case-solicitor-field`, drops the "Solicitor" option from the waiting-on
`<select>`, hides `#case-exchange-field` even at a stage that would normally
show it, and `nextStageFor()` skips `exchange` in the Advance stepper (offer
→ completed directly) — the manual stage `<select>` is untouched, this only
narrows the one-click hero button. `GI_KINDS` (buildings-insurance field)
widened to purchase/first_time_buyer/buy_to_let/remortgage, never
product_transfer. Wording: the Documents and History section intros were CUT
outright (bare `<h3>` + a `title=` tooltip on a `?` span, no `<p>` left) —
Files, by contrast, kept a shortened one-line `<p>`, so "no intro paragraph"
is NOT true of every section, only Documents/History.

Existing suites fixed for the overflow relocation (all via the same
`clickAction(page, id)` helper — checks visibility, opens the toggle first if
needed, then clicks): `tests/r5_batch1.js` (#act-reminder), `r5_batch2.js`
(#act-reminder, #act-paid ×2), `r9_adv.js` (read `#case-referrer-field`'s
`title` attr instead of the now-removed `#case-referrer-hint` element — the
hint moved to a tooltip, not overflow), `r12a.js` (#act-factfind ×2),
`r13.js` (#act-review ×2, #act-evidence ×3 via a sibling `ensureActionOpen`
that opens the menu without also clicking, for call sites already wrapped in
their own `Promise.all([waitForEvent, click])`), `r12b.js` (#act-appt).
`tests/r5_batch3/4/5/6/7/8/9.js`, `r8_touch.js`, `r8_rev.js`, `r9_docs.js`,
`r9_embed.js`, `r11_ux.js`, `r64.js` needed no change — none of them click an
action id that R15 moved for the stage/kind their fixture case happens to be
at. No mock-fixture gap: R15 reads only `stage`/`case_kind`, both already
represented at every value the fixture book needs (product_transfer cases
exist at enquiry/application/completed already); `tests/r15.js` creates every
stage/kind combination it needs fresh via `mkClientCase`, including the one
combination (product_transfer AT the offer stage) nothing else in the
harness had exercised, so no fixture edit was required either. One process
note for anyone extending this suite: `mock-supabase.js`'s whole in-memory
DB is rebuilt by the IIFE that runs when `mock.html` loads, so it is
PER-PAGE — a case id minted on one `page` is meaningless to a different
`newPage()` instance. r15.js therefore runs its entire battery on one shared
page for the whole file, not a fresh page per section like most suites here.

R14 notes: `vault_entries` (company password safe) added — RLS staff read (gated by
visible_to text[]: null/empty = all staff), staff insert/update, OWNER/ADMIN delete
only; a dedicated audit path masks every secret field VALUE to "(hidden)" while
keeping non-secret fields + labels. Mock fixtures are DELIBERATELY FAKE (test-pass-N,
bluecar) — never seed real credentials. Production holds 203 REAL entries imported
from Passwords MASTER.xlsx (not in the mock, not in the repo). vault_entries is
EXCLUDED from EXPORT_TABLES (the firm export) on purpose — never add it. The case
modal gained a "Client — security check" strip (securityCardHtml) at the top: name,
DOB, home address, property, loan, lender, product, rate, LTV — real columns only,
each copyable. R14 follow-up: the card now starts COLLAPSED by default
(`#case-sec-card.sec-collapsed`, `#sec-toggle` expands, `.sec-who` shows the name
while collapsed, `#sec-grid` holds the expanded grid) and gained a
`cases.mortgage_account_number` row (nullable text, editable via `#case-mortgage-acct`,
mirrored in the mock). Mock `sameValue()` fix: array/object-valued
columns now diff by JSON.stringify, not String() — needed so vault `fields` edits
actually write + audit.

(Several suites derive check counts from fixture data — r11_ux now reports 123,
r8_touch 151, r8_rev 176 after the R13 fixture/mirror changes. The table above
reflects what the suites actually print today.)

R13 notes: the mock's run_watchtower now mirrors production's TEN rules
(offer_stale, app_not_submitted, exchange_no_chase, lead_slow, email_unanswered,
fee_aging, workload, retention_gap, fee_aging_60, protection_quote_stale) plus
the auto-resolve sweep — the old 7-rule stub had drifted and produced a false
"offer expiry unwatched" panel finding. THE STORAGE BUCKET IS **client-docs**
(production has web/offers/client-docs; "case-documents" never existed — an
R12a mock invention, since hotfixed in app.js). storage_path values carry the
"client-docs/" prefix, exactly as the deployed doc-upload writes them.
suppress_automation is enforced in every mock queueing path, mirroring the
r13_m2/m3 production migrations. process-emails stub stamps last_cron_run_at on
full runs only (v13 mirror). New tables staff_absences + case_files carry the
production RLS in writePolicy. Fixture flags: cl012 vulnerable+suppressed,
cl021 suppressed; p3 Luke absent today; last_cron_run_at seeded stale (-3d).

R12b notes: leads default to the lightest-loaded ADVISING staff member (never the
admin) — r5_batch1's R5-5 block asserts the rule, not a name. Advisers see no
fee-chase My Day rows while bank details are absent (r5_batch3 R5-28 updated).
Doc chasing covers every live stage (r9_docs:569 copy check updated; the
`checklistCases` lock is now `>= 4` protecting the four named chase-state
fixtures, and a DIP-stage checklist case exists). Three midnight-London flakes
(r5_batch1 R5-13, r5_batch2 R5-12, r9_docs feedback-tomorrow) were fixed at the
source with Europe/London date derivations — never widen tolerances for these.
The mock mirrors r12b prod migrations: cases call-pack columns
(current_balance/reversion_rate/monthly_payment/erc_amount),
profiles.tour_seen_at + mark_tour_seen() RPC, appointments.outcome, widened
queue_comms_extras. The first-run tour fires only for a profile with null
tour_seen_at (fixture: p3 Luke); tests can suppress it via window.__NEX_SKIP_TOUR.

R12a notes: the mock's process-emails stub mirrors the DEPLOYED v12, which added
the `factfind` email type (per-row fact_finds resolution, site_url-required
failure path, status advance to 'sent' on real send only). The `case-documents`
storage bucket is now exercised (signed URLs, same semantics as `offers`).
`tests/r12a.js` regression-locks the 12 broker-panel defects (D1–D12).

R11 notes: the three conveyancer-average literal anchors in `tests/r9_docs.js`
used to flake with the time of day the battery ran — the cause was fixture
inconsistency (date-only `submitted_at` paired with load-time `completed_at`,
and two "calendar months ago" derivations), fixed in the fixtures via
`shiftNoon()` + fixed day offsets, NOT by widening tolerance. The mock `leads`
table now carries `discard_reason` and `first_contact_at` to mirror the r7/r11
production migrations — the Lead response panel's real path renders in the
harness now; keep new prod columns mirrored here or `hasOwnProperty`-style
feature detection in app.js will silently take the degraded branch in tests.

`tests/r9_docs.js` is the only file in the battery that drives pages OUTSIDE
`/admin`: the two client-facing pages `/docs` and `/feedback`. It loads them
with `admin/mock-supabase.js` injected via `page.addInitScript` (which runs
before the page's own script, so `window.fetch` is already stubbed) and sets
`window.__NEX_FN_BASE` to the mock's function host. Both pages read that
variable and otherwise have no idea they are being tested — do not add
test-only branches to them.

Its `newPublicPage(..., {record:true})` wraps the mock's `window.fetch` a
second time and records what the PAGE built — method, headers, whether the body
was a `FormData`, and each part. That exists because the mock stub being happy
with a request proves nothing about the deployed function: the first version of
`docs.html` posted JSON, passed a lenient stub, and would have 400'd for every
real client. `doc-upload`'s stub now mirrors the deployed v1 contract strictly
(multipart only, `token` in the body, `item_id` not the item name, extension-
authoritative typing plus a magic-byte check, a honeypot that answers a bare
`{ok:true}`, and status-code semantics), so **keep the stub strict** — loosening
it to make a test pass is how a page ships broken.

**A stub can also be too LAX, and that is the harder bug to see.** The round-9
verification pass found `nps-capture`'s stub resolving a submission by `case_id`
first and only falling back to the token, with no check that the two agreed —
so a forged POST carrying somebody else's case id and no token at all "worked"
in the harness. The deployed function has always had
`if (!kase || !kase.nps_token || kase.nps_token !== token) return 404` ahead of
every write, so production was never open to it; the mock was simply wrong, and
a mock that is more permissive than the thing it mirrors makes a page look safe
on a property nothing is actually testing. The stub now carries the identical
unconditional guard, the score is write-once (`effective = stored ?? request`),
and `tests/r9_docs.js` § **R9-8b** asserts the whole forged-path matrix — every
refusal checked for zero writes as well as for its status code. Two consequences
for anyone writing tests here:

- **A feedback link has to be MINTED on the case** (`cases.nps_token`) before it
  will do anything. No fixture seeds one, so an invented token is a 404. The
  R9-8 block mints its own after page load; copy that, do not relax the guard.
- **A stored score outranks the one in the URL.** Clear `nps_score` on the case
  first if the band under test is meant to come from the request.

**The embed resolver is strict, and that is deliberate.** Round 9's m11
migration gave `cases` and `clients` TWO foreign keys
(`cases_client_id_fkey` and `cases_referrer_client_id_fkey`), so real PostgREST
refuses every unhinted embed between them — in both directions, at every
nesting depth — with HTTP 300 / `PGRST201`. The mock's resolver used to take the
first FK column it found, which is why 1,528 checks watched the deployed
Pipeline 300 without noticing. `relationCandidates()` / `resolveRelation()` in
`mock-supabase.js` now enumerate EVERY relationship between a pair, return the
exact PostgREST error when more than one matches with no hint, and honour the
`!column_name` and `!constraint_name` hints (plus `!inner`). `FK_COLUMNS` is the
relationship map: a target lists every FK column that reaches it. Two rules
follow:

- **Write app and test queries in the hinted form** — `clients!client_id(...)`,
  `cases!client_id(...)`, `clients!referrer_client_id(...)`. An unhinted
  cases↔clients embed is now a failing query here, exactly as in production.
- **Do not loosen the resolver to make a query pass.** The permissive version is
  the bug. If a new pair becomes ambiguous, add its columns to `FK_COLUMNS` and
  hint the call sites.

Every run should end 0 failures. Playwright's chromium browser is preinstalled
in this environment — no `npx playwright install` needed.

## Test hooks

Exposed on `window` by `admin/mock-supabase.js` (and one by `app.js`) for the
test scripts to reach into the mock without going through the UI:

- `window.__mock.setMigrations({m2: false, ...})` — flips one or more of the
  M1–M7 migration flags off (all default ON) so a test can exercise the app's
  feature-detect fallback path (Postgres 42703 undefined-column / 42P01
  missing-relation / 42883 undefined-function) for an "unmigrated database".
- `window.__mock.lastEmailRun()` — what the last `process-emails` invocation
  actually sent, including the composed per-adviser sign-off text for every
  message.
- `window.__mock.setDocUploadRateCap(n)` / `resetDocUploadRate()` /
  `failDocStorageOnce()` — the deployed `doc-upload` returns 429 on a per-link
  rate cap and 500 when storage fails. Both are real rules with no other way
  in (the cap needs twenty-one uploads to reach; the failure needs storage to
  fall over), so these shrink/arm them rather than the handler softening them —
  what the tests exercise is the same code path a real client hits.
- `window.__mock.expireSnooze(alertId)` — fast-forwards a watch_alerts row's
  `snoozed_until` into the past so snooze-expiry behaviour can be tested
  without waiting.
- `window.__mock.queueAutomatedEmails()` / `queueCommsExtras()` — run the
  production queueing RPCs directly, without sending.
- `window.__mock.readTableAs(personaKey, table)` — read a table as if logged
  in as a different persona, for RLS-style visibility checks, without
  disturbing the actual current session.
- `window.__mockDb` — the mock's live supabase client handle (same object
  `app.js` uses); tests call `.from(...)`, `.rpc(...)` etc. directly on it to
  read ground truth out of the fixture DB.
- `window.__setReportsRowCap(n)` — defined in `admin/app.js` (not the mock),
  lets a test shrink the reports row cap (default 5000) to prove the "showing
  first N — truncated" notice actually appears without needing 5000 rows of
  fixtures.

## Standing rules

- **Compute test expectations from fixtures at runtime, never hardcode
  date-relative values.** The mock's fixture dates are generated relative to
  "now" at load time (`shift(-N)` etc.), so a hardcoded date or day-count in a
  test will quietly go stale. Read the real state back out via
  `window.__mockDb.from(...)` / `window.__mock.counts()` inside `page.evaluate`
  and assert against *that*, the same way the existing batches do.
- **Never commit fixtures with real client data.** Everything in
  `admin/mock-supabase.js` is synthetic (deterministic PRNG seed), and it must
  stay that way — no real NexMoney client names, emails, phone numbers or
  addresses, ever.
- **Mock files are excluded from the live deploy.** `admin/mock.html` and
  `admin/mock-supabase.js` (and now `tests/`, `smoke.js`, `HARNESS.md`,
  `shots/`) are listed in `.vercelignore` so none of the harness ships to the
  real site. If you add a new harness file, add it to `.vercelignore` too.

## Recovery rule

**`origin/main` is the only durable store for this harness.** This sandbox is
ephemeral — nothing here survives except what's pushed. As soon as the full
battery above is green, deploy/push immediately. Do not sit on a green run;
treat "battery passed" and "pushed to origin/main" as one atomic step.
