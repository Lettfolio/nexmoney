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
node tests/r17.js
node tests/r18.js
node tests/r19.js
node tests/r20.js
node tests/r23.js
node tests/r24.js
node tests/r25.js
node tests/r26.js
node tests/r27.js
node tests/r29_scale.js
```

Current green counts (end of round 23; r21/r22 were never committed to this
checkout and are excluded from the run list and the count below). r8_touch/
r8_rev/r11_ux still carry the 151/176/123 figures the R13 note below already
flagged (fixture-derived counts, unrelated to R15/R16/R17/R18/R19/R20/R23 —
see "compute test expectations from fixtures at runtime" in Standing rules);
every other pre-existing suite's count is unchanged by R18, R19, R20 or R23
— R20 needed exactly ONE existing-suite edit, a one-line selector fix in
`tests/r19.js` (see the R20 notes below for exactly why — a real, precise,
non-masking fix, not a work-around) — every other existing suite (through
R23, re-run in full: r18/r19/r20/r13/r12b regression-checked green with
unchanged counts) passed completely unedited (see the R18 and R19 notes for
why those needed none at all: R18 is scale/perf hardening behind selectors
nothing else asserted the old shape of, and R19 is new owner-gated Reports
content that no earlier suite reaches; R23 is the same story again — see the
R23 notes below).

**Full battery is 100% green (3,264/3,264), `tests/r9_docs.js` included
(255/0).** R28 is a small, already-built,
uncommitted change to R26's per-adviser fee targets (`admin/app.js` only —
see the "R28 notes" section below) that required updating `tests/r26.js`
in place: its check count rose from 36 to 38 (two new assertions proving the
editor's new advisingStaff()-only scoping — see the R28 notes). No other
suite needed any edit; the rest of the battery (`smoke.js` through
`tests/r27.js`) re-ran unedited at its exact pre-R28 counts. `admin/app.js`
was not touched by this test-maintenance pass.

R27 added `tests/r27.js` (43
checks) into a full re-run of every pre-existing suite. Two pre-existing
suites needed a fix, both DATE-FRAGILITY — the same class already documented
for R17's `r12b.js` B1/B5, not anything R27's own `admin/app.js` change
touched — and both fixed the same non-masking way (a real date chosen so it
can never coincide with the fixture, not a loosened assertion), with their
check COUNTS unchanged either side of the fix:
  - `tests/r12a.js` D11 booked its two probe appointments on `today + 10`
    days, which lands on day 28 of the month whenever that offset reaches or
    passes it — colliding with THREE pre-existing fixture appointments the
    `mock-supabase.js:2001` loop piles onto day 28 via its own `Math.min(28,
    …)` cap, pushing the day's total past the diary's month-cell 3-tile cap
    (`tests/r12b.js`'s own W-26) and hiding the probe row the assertion
    expected to find. Fixed by picking an ODD day-of-month (clamped ≤27) in
    the current month instead — the exact rule R17 already wrote down for
    this fixture, applied a second time (`tests/r12a.js` ~814). 113/1 → 114/0.
  - `tests/r5_batch9.js`'s Day-view §2 asserts "today has exactly 3
    appointments for p2" (the fixture's own deliberately-seeded Ruby/Duncan
    clash pair plus Marcus's plain-titled one). The SAME `mock-supabase.js`
    loop places 16 more appointments on absolute days 2–28 of the current
    month using real `Date.now()`, uncoordinated with those three — so on any
    day-of-month where that spread happens to land a `staff_id:"p2"` entry
    (days 2/10/18/26), "today" silently grows a 4th p2 appointment and the
    count assertion goes red. This is a fixture bug, not a test bug: the loop
    has no awareness of the dedicated "today" set seeded right after it, and
    the day it happened to hit this round (the 18th) is exactly as arbitrary
    as the next one will be. Fixed in `mock-supabase.js` itself — the loop
    now nudges that one day off `NOW.getDate()` by 1 when they'd otherwise
    coincide (always landing on an odd day the loop never otherwise uses, so
    it can't newly collide with another seeded day), leaving all 16
    appointments' hours/staff/titles/count untouched. 25/2 → 27/0. Every
    other test file was grepped for a hardcoded appointment count/id from
    this fixture (`APPT_TITLES`, the specific titles, `"appointments":20`)
    and none exists — this suite alone reads that spread's composition.
  Both fixes are pure test/harness maintenance, in `tests/r12a.js` and
  `admin/mock-supabase.js` — `admin/app.js` was not touched for either.
  Every OTHER suite passed at its EXACT pre-R27 count (see the table below).
  R24 also FIXED a 2-check regression
R23 had introduced in `tests/r11_ux.js`: R23's hidden `#dash-cap-notice` sits
between `#kpi-row` and `#briefing-panel`, which r11_ux's `R11-A` top-of-page
adjacency check didn't expect (R23's own regression run hadn't included r11_ux,
so origin briefly shipped it 2-red). The two `R11-A` asserts now skip the optional
hidden notice — the "numbers first" intent is preserved (kpi-row still immediately
follows the heading), non-masking. r11_ux is back to 123/0. R17 also made two long-standing
date-fragile checks in `r12b.js` deterministic (B1 "Earlier today" crossed
midnight when run just after 00:00; B5's month-cap date collided with the
even-day appointment seed at `mock-supabase.js:2001`) — see the R17 notes below.

| Suite | Checks |
|---|---|
| `smoke.js` | 144 |
| `tests/r5_batch1..9.js` (sum) | 557 (BATCH 9's day-collision fixed in R27 — see the R27 notes; sum unchanged) |
| `tests/r64.js` | 91 |
| `tests/r8_touch.js` | 151 |
| `tests/r8_rev.js` | 176 |
| `tests/r9_adv.js` | 169 |
| `tests/r9_docs.js` | 255 |
| `tests/r9_embed.js` | 104 |
| `tests/r11_ux.js` | 123 (R11-A adjacency asserts updated in R24 to skip R23's hidden `#dash-cap-notice`) |
| `tests/r12a.js` | 114 (D11's date-fragility fixed in R27 — see the R27 notes; count unchanged) |
| `tests/r12b.js` | 158 (date-fragile B1/B5 made deterministic in R17) |
| `tests/r13.js` | 142 |
| `tests/r14.js` | 167 |
| `tests/r15.js` | 160 |
| `tests/r16.js` | 81 |
| `tests/r17.js` | 112 |
| `tests/r18.js` | 43 |
| `tests/r19.js` | 39 (unchanged count — R20 fixed HOW one row is queried, not what it asserts) |
| `tests/r20.js` | 81 |
| `tests/r23.js` | 76 |
| `tests/r24.js` | 89 |
| `tests/r25.js` | 45 |
| `tests/r26.js` | 38 (R28 updated the basis/scoping assertions and added 2 new checks — see the R28 notes) |
| `tests/r27.js` | 43 |
| `tests/r29_scale.js` | 106 |
| **Total** | **3,264** |

R29 notes: started as a VERIFICATION round (no product-code changes) and
became a find-then-fix round within the same pass once the finding below was
confirmed. The brief was to prove the back office is robust at the
production scale it is heading for (R23's own comment on `OWNER_ROW_CAP`
already calls out "2,000+ ≫ Daniel's book") and leave a permanent regression
suite behind. `tests/r29_scale.js` (106 checks) seeds ~2,500 clients and
~2,500 cases DIRECTLY into the mock's in-memory store — one `Builder.insert()`
array-payload call per table (`window.__mockDb.from("clients"/"cases")
.insert([...2,500 rows...]).select("id")`), so `applyInsertDefaults()` still
runs (ids, timestamps, the M2/M7/M10/M11 null-default columns) exactly as any
other insert this harness makes, but in TWO round trips instead of 2,500 —
the fastest canonical path the mock exposes. The seed is realistic and
varied on purpose: all 8 stages (weighted 72% live / 18% completed / 10% not
proceeding), `assigned_to` spread across the team plus ~1/7 unassigned, a
genuine mix of past/future `rate_end_date` and `expected_completion_date`,
and clients/cases missing email/phone/`submitted_at`/`offer_issued_date` at
realistic minority rates. Because each Playwright `page` re-executes
`mock-supabase.js` from scratch (its `DB` is a fresh IIFE-scoped variable per
page load, not a shared/global store), the owner pass and the adviser pass
each carry their OWN seed — proven held via `window.__mock.counts()` and a
live `window.__mockDb` read (not a copy) before every page is driven.

Every owner page (Dashboard, Pipeline board, Clients, Reports incl. Pipeline
MI + adviser scoreboard, Monday money, Data health, Emails) and the lighter
adviser pass (Dashboard, Pipeline, Clients) render at this scale with ZERO
new console errors and ZERO new `window.__errorLog` entries. Every DOM render
cap that exists in `admin/app.js` holds exactly as documented and un-touched:
Clients' `CLIENT_LIST_CAP=100` (with `.client-list-cap-note` correctly
reading "Showing 100 of &lt;2,500+&gt;"), the board's `BOARD_COL_CAP=50`/column
(with a working "Show N more" control on every over-cap column, and the
column HEADER counts — deliberately uncapped — summing exactly to the true
case total), the dashboard's rate/ERC (15) and retention (12) panels,
Monday money's rate-ends (top 5) and cold-quotes (top 10) lists, and every
adviser scoreboard (team-sized, never case-sized). The R23 OWNER_ROW_CAP
notices (`#dash-cap-notice`/`#board-cap-notice`/`#clients-cap-notice`/
`#data-cap-notice`) all correctly stay HIDDEN at ~2,600 rows — OWNER_ROW_CAP
is 20,000, so this is R23's own "never fires for Daniel" claim, verified.
Every KPI/MI number checked renders as a real number — no `NaN`/`undefined`
in any kpi-row, MI panel or money strip touched.

**The finding — FOUND then FIXED, same round:** the original scale run found
Data health's per-issue list panels (`#dh-unassigned-panel`,
`#dh-nofee-panel`, `#dh-phone-panel`, `#dh-milestone-panel`,
`#dh-deadbook-panel`, `#dh-both-panel`, and siblings) had NO render cap at
all — unlike every other page (Clients 100, board 50/column, dashboard
15/12/15, Money top-5/top-10). `loadDataHealth()` was computing these lists
off the full OWNER_ROW_CAP-limited read and rendering one DOM row per match
with no CLIENT_LIST_CAP/BOARD_COL_CAP-style slice and no "Showing N of M"
note. At this round's realistic (not deliberately adversarial) seed,
`#dh-tile-deadbook` alone reached **1,021 rows** (live cases whose
`expected_completion_date` or `rate_end_date` had already passed — a 25%
past-date rate among live cases with a date), `#dh-tile-unassigned` reached
260 and `#dh-tile-milestone` reached 207, pushing `#data-content`'s total DOM
node count to 37,774. No crash, no console error, no `NaN` — but a
data-quality issue that is common at real scale (a bulk import, a quiet
quarter) would have grown an unbounded DOM tree on this one page.

That gap was FIXED in `admin/app.js`, same round: `const DH_PANEL_CAP = 200;`
plus a `dhMoreNote(n)` helper now slice every one of those list panels to
`.slice(0, DH_PANEL_CAP)` and append `<div class="empty">…and N more not
shown — clear the ones above first, or use the firm export to work the whole
list.</div>` whenever the true count exceeds 200 (`#dh-missing-panel`'s
`<table>` — already capped at 300 inside the `get_data_quality` RPC — gets
the same treatment via a `<tr><td colspan="2">…and N more not shown…</td></tr>`
row, since it is a table, not `.row-item`s). `tests/r29_scale.js` §G was
updated in place (the same file, no new test file — this is the round's own
fix being verified, not a separate feature) to prove the FIX: for every
panel, an independent ground-truth recompute off `window.__mockDb` is
checked against the KPI tile's own number (unchanged — tiles still report
the TRUE, un-sliced count), the panel's rendered row count (now exactly
`min(true count, 200)`), and the overflow note (present, naming the exact
remainder, iff the true count exceeds 200; asserted absent otherwise).
`#dh-deadbook-panel` — the panel that hit 1,021 raw rows — is pinned to
exactly 200 rendered rows plus its overflow note, the direct regression test
for the fix; a dedicated check also confirms deadBook's ground truth is
still well over 200 at this seed, so the fix is actually exercised, not
vacuously true. Post-fix, `#data-content`'s total DOM node count at the same
~2,600-row seed is 33,277 (down from 37,774, and — the point of the fix —
no longer proportional to the underlying book: the panels that were near or
past the cap are now flat at 200 regardless of how large the true count
grows). `tests/r29_scale.js` rose from 98 to 106 checks (the 8 new checks:
one "overflow note present/absent" assertion per panel-plus-the-deadbook
exercised-not-vacuous check). `tests/r25.js`/`tests/r27.js` (Data health's
other Data-health-touching suites, both re-run in the full battery below at
their exact pre-existing counts, 45/0 and 43/0) are unaffected — their
synthetic fixtures are single-digit/low-double-digit per tile, nowhere near
DH_PANEL_CAP=200, so the cap never engages for them; "below the cap,
byte-identical" (R23's own governing rule, extended here).

`tests/r9_docs.js`'s two pre-existing, R29-unrelated failures (its R9-8 "no
surname, email, address or money on /docs.html" check tripping on the
mandatory FCA `£375` fee-disclosure footer the "Compliance: Stonebridge
remedial review Aug 2026" commit added to `docs.html` before this round
started) were fixed separately, outside `tests/r29_scale.js`, by stripping
that one boilerplate sentence before the money check
(`bodyNoFeeBoilerplate`) rather than loosening the privacy guarantee itself
— re-run as part of this round's full battery and confirmed 255/0.
`tests/r29_scale.js` was not touched for that fix and did not need to be —
it never exercises `docs.html`.

R28 notes: a small, already-built, uncommitted refinement of R26's
per-adviser monthly fee targets — `admin/app.js` only, no schema, no
`index.html` change. Two changes, both test-visible:
  1. **Attainment basis refolded.** `mkAdvRow`'s row field was renamed
     `feeEarnedBroker` → `feeEarnedTotal`, and its formula now sums
     `proc_fee + broker_fee + sols_fee` over the adviser's completions in the
     selected report month (was `broker_fee` alone) — `advTargetCell` and the
     foot-row sum both read the renamed field. This makes the per-adviser
     Target column match the firm "Fees earned vs target" bar's basis
     EXACTLY (`earnedOnCompletion` = proc+broker+sols on the month's
     completions), where R26 measured broker fee only.
  2. **Editor scoped to advisers.** `renderAdviserTargetsEditor(owner)` now
     builds its `.adv-target-input[data-staff]` rows from `advisingStaff()`
     (app.js ~762, `TEAM.filter(isAdvisingStaff)`) instead of the whole
     `TEAM` STAFF_ROLES subset — an owner/admin who doesn't personally advise
     no longer gets a target input. (The Reports scoreboard itself is
     unchanged: `mkAdvRow`/`advRows` still iterate the whole `TEAM`, so a
     non-advising team member still gets a scoreboard row, just never a
     target — same "—" / `data-pct=""` treatment as any other untargeted
     row.)

`tests/r26.js` was updated in place (no new test file — this is a small
in-round refinement of the same feature, not a new one) to 38 checks (was
36): §A's editor-shape assertion now derives its expected input-id set from
`window.advisingStaff()` (confirmed exposed as a plain global — app.js is a
classic `<script>` tag, not a module) instead of `window.TEAM`, plus two new
checks (A1b/A2b) that a non-advising TEAM member (the admin persona, p1 Kim
— guaranteed never-advising regardless of fixture load, since `isAdvisingStaff`
only allows role `"adviser"` unconditionally or `"owner"`/`"staff"` when
carrying live cases, and `"admin"` is in neither list) gets no input at all.
§C's independent recompute (`earnedForMonth`) now sums `proc_fee +
broker_fee + sols_fee`, not `broker_fee` alone, and the seeded probe case
(assigned to p3, an adviser — always in `advisingStaff()`) now carries
distinctive `proc_fee`/`broker_fee`/`sols_fee` values so a regression that
dropped proc/sols back out of the fold would be caught (a broker-only seed
could not have told the difference). §B/§D/§F needed no changes: §B/§C's p2/
p3 are both role `"adviser"` so stay in `advisingStaff()` unconditionally,
and §D's/§F's assertions don't touch a specific non-advising id.

No product bug found — `admin/app.js` was not modified for this pass; the
change described above was already shipped/built before this session
started. Ran the WHOLE regression battery (`smoke.js` through `tests/
r27.js`) after updating `tests/r26.js`; every other suite passed unedited at
its exact pre-R28 count (see the table above and the "Full battery is 100%
green" paragraph). `node smoke.js` alone: 144/0.

R27 notes: Data health's new "dead-book" hygiene check — every LIVE case
(stage NOT `completed`, NOT `not_proceeding`) whose own forward date has
already elapsed, entirely `admin/app.js`, no schema and no `index.html`
change. `expected_completion_date` and `rate_end_date` both already ride the
page's main `caseRows` select (~app.js:20477) as plain columns — unlike
R25's `offer_issued_date`, neither needed a separate forward-dates-gated
read. Predicate `deadBook` (loadDataHealth()): for each live case, prefer
`expected_completion_date` when it is strictly in the past (`daysSince(...)
> 0`, reason `"expected completion N days ago"`); only when that date is
absent or not yet overdue does it fall back to `rate_end_date` (`"rate ended
N days ago"`). A case with BOTH dates in the past gets the expected-
completion reason, never the rate-end one — a deliberate preference, not an
either/or. Sorted most-overdue (largest N) first. `#dh-tile-deadbook` sits
right after `#dh-tile-milestone`, `.warn` when its count is >0, wired
through the same `wireTile` helper as every other list-panel tile;
`#dh-deadbook-panel`'s rows carry the stage label and reason in `.s`
("`<Stage> · <reason>`"), same shape as every other Data health list.

`tests/r27.js` (43 checks) proves this end to end on ONE continuing p4
(owner) page for §A–§C, the same shared-page pattern `tests/r25.js`'s A/B
and `tests/r26.js`'s B–E already use. §A confirms the tile/panel exist,
`.warn` tracks count, placement immediately after `#dh-tile-milestone`, and
clicking it reveals the panel. §B is the core: an independent recompute of
`deadBook` straight off `window.__mockDb` (STAGES' canonical list read off
the page as a fair-game shared ordering constant, the filtering/day-math
logic reimplemented from the round's own spec, not borrowed from app.js) is
compared against the panel's exact rendered case-id set — not merely the
same length. Seven purpose-built synthetic cases (the `insertCase` technique
`tests/r25.js` uses), independent of fixture composition, pin every named
boundary: ~90 days past `expected_completion_date` (flagged, exact day count
recomputed and cross-checked against an independent formula, sanity-checked
within 2 days of the ~90 seeded); `rate_end_date`-only overdue (flagged,
"rate ended", no "expected completion" wording); BOTH dates in the past
(flagged with the PREFERRED expected-completion reason, proving the
preference order rather than an accidental either/or); a FUTURE
`expected_completion_date` with no rate-end date (not flagged — `daysSince`
clamps negative diffs to 0, never negative, so this also proves the `> 0`
guard genuinely excludes it rather than merely not triggering by luck); a
COMPLETED case with a past `rate_end_date` (not flagged — that date is
legitimately historic for a closed case); a not_proceeding case with a past
date (not flagged — a dropped case owes no forward date); and two more live
overdue cases at deliberately different overdue amounts. §C confirms the
more-overdue of those last two renders ABOVE the less-overdue one in the
panel — sort order, not just membership. §D is a light regression check that
`#dh-tile-milestone`/`#dh-tile-nocompleted` and their panels still exist and
still open on click (r13.js/r25.js own full coverage of those two). §E
confirms zero console errors on Data health for both owner (p4) and admin
(p1), and that the tile also renders for admin.

No product bug found — `admin/app.js` was not modified for R27's own
feature. Ran the WHOLE regression battery (every suite `smoke.js` through
`tests/r26.js`) after adding `tests/r27.js`, unedited, and found two
PRE-EXISTING, date-fragile failures — both entirely unrelated to R27's own
`admin/app.js` change (confirmed by re-running each against the pre-R27,
committed `admin/app.js` via `git stash`, where they failed identically) —
and fixed both the same way R17 already established for this exact class of
bug: a real, non-masking date choice, never a loosened assertion. See the
"Full battery is 100% green" paragraph above for the two fixes
(`tests/r12a.js` D11, and the `mock-supabase.js:2001` appointment seed
itself) and exactly why each was needed.

R26 notes: per-adviser monthly fee targets, entirely `admin/app.js`, no
schema and no `index.html` change. Storage is ONE new settings row —
`key="adviser_fee_targets"`, `value=JSON.stringify({staffId:number})` —
parsed everywhere through one defensive `adviserTargets()` (a bad/missing/
non-object/array value degrades to `{}`, never throws). Two new pieces:
(1) `renderAdviserTargetsEditor(owner)`, an owner-only editor built in JS and
injected right after `#settings-saved` on every `renderSettings()` run
(`#adviser-targets-section`, one `.adv-target-input[data-staff]` per `TEAM`
member, `#adviser-targets-save`), removed outright for a non-owner — same
`isOwner()` gate every other owner-only Settings block already uses; (2) a
new "Target" column on the owner Reports scoreboard (`#report-advisers`,
inside the pre-existing `showMoney()`-gated `#report-scoreboard-panel`),
right after "Fees banked (paid)". The attainment basis is `feeEarnedBroker`
— broker fee EARNED (paid or not) on that adviser's completions in the
selected report month, the same basis as the firm "Fees earned vs target"
bar, deliberately not the cash "Fees banked" column beside it — against the
target set in Settings, `pct = Math.round(earned/target*100)`. No target (or
the Unassigned/off-team rows) renders "—" / `data-pct=""`, never `0%`. The
foot row sums earned/target only over advisers who have a target on both
sides.

`tests/r26.js` (36 checks) proves this end to end, on ONE continuing
page/session for §B–§E (mock-supabase.js's whole DB and `settings` live in
that page's own in-memory JS state, reinitialized fresh on every navigation
to `mock.html` — so state written in one section has to be read back within
the same page, not a fresh `newPage()`, exactly like `tests/r25.js`'s A/B
share one page). §A confirms the editor's shape against `window.TEAM` read
off the page, never hardcoded. §B saves a target through the real editor UI
and reads `settings.adviser_fee_targets` straight back off
`window.__mockDb`, exact JSON, then confirms a fresh Settings render
prefills it. §C is the critical arithmetic case the build agent flagged it
could not exercise off the stock fixture: a case is seeded (via the same
`insertCase` technique `tests/r25.js` uses) assigned to an adviser, with a
`broker_fee` and a `completed_at` inside the SAME month Reports defaults to
(`localMonthStr()`, read off the page). That adviser's true
`feeEarnedBroker` for the month is recomputed independently off
`window.__mockDb` (so the assertion holds regardless of what the fixture
already contributed that month, not merely off the one seeded case), a
target is set that does NOT divide the earned total evenly (so a truncation-
vs-rounding bug in the pct formula would actually be caught), and the
scoreboard's `data-pct` and cell text are asserted against that independent
recompute exactly. §D confirms a no-target adviser row and the Unassigned
row both render "—" / `data-pct=""`. §E confirms the header's `<th>`
colspan-sum (10) equals every body row's and the foot row's `<td>`
colspan-sum, so the new column didn't misalign any row. §F confirms a
non-owner (p2) gets neither the Settings editor nor a visible scoreboard
panel, with no console error on either page.

No bug found — the pct arithmetic (including the deliberately non-round
target case) matched an independent recompute exactly, the editor round-
trips through the real settings table with no schema, and the full
regression run above (every suite `smoke.js` through `tests/r25.js`, in
full) passed completely unedited at its exact pre-R26 count. `admin/app.js`
was not modified.

R24 notes: narrows the Pipeline board's `cases` read (`loadPipeline()`,
app.js ~7275 — the app's fattest read, up to `OWNER_ROW_CAP` rows on the
screen brokers keep open all day) from `select("*, clients!client_id
(first_name,last_name)")` to a named column list: a fixed `BOARD_CASE_COLS`
(22 always-present columns) plus three migration-gated columns appended only
when their own feature detector currently answers true —
`property_address` (`propAddrSupported()`, M7), `waiting_on,solicitor_firm`
(`docsSupported()`, m10) and `application_status` (`lenderTrackSupported()`,
a plain no-migration-toggle column, still probed defensively) — then the
pre-existing `clients!client_id(first_name,last_name)` embed and
`.order("updated_at",{ascending:false}).limit(OWNER_ROW_CAP)` (R23),
unchanged. Frontend-only, no schema, no other function touched.

`tests/r24.js` (89 checks) proves the narrowing two ways, not just by
reading the source: (1) monkeypatches `window.__mockDb.from` to wrap
`.select()` (same technique tests/r23.js's `installLimitRecorder` uses for
`.limit()`) and captures the literal string `loadPipeline()` passes —
confirmed NOT `"*"`, confirmed to start with `BOARD_CASE_COLS` verbatim,
confirmed to include the clients embed, and confirmed to exclude four
deliberately-dropped columns that ARE real schema used elsewhere in app.js
(`proc_fee`, `notes`, `offer_doc_path`, `property_value` — so the check is
meaningful, not just probing for typos); (2) a purpose-built "kitchen sink"
case carrying a real, non-null value in every field the board's select must
still provide is inserted independently for the owner (p4) and an adviser
(p2), and every field the round's own spec calls out — client name, stage,
adviser, lender, loan amount, rate, rate-end date, fee status, protection
status, property, the waiting/solicitor chip, and the submit-to-lender
status badge — is read back off the live board card AND the live table row,
never re-derived from app.js's own constants except the same handful of
pure DISPLAY formatters (`fmtM`/`fmtD`/`staffName`/`propLabel`/
`STAGE_LABEL`) r19/r20 already treat as fair game. `product_name` (selected
but never displayed directly — it only feeds the board search filter) is
proven live via an actual `#board-search` query on a token unique to the
seeded case, not just left unchecked because it has no visible field.

The un-migrated-safety path (§E) is the one part of the round's own spec
that isn't reachable through the mock's normal migration toggles:
`application_status` ships as a plain nullable column with no `m*` toggle in
`mock-supabase.js` (same rule as `mortgage_account_number`/the R16 BTL
trio), so `window.__mock.setMigrations({...})` cannot make it 42703 the way
`m7`/`m10` can for `property_address`/`waiting_on`. `tests/r24.js` instead
sets the three module-scope feature-detect caches app.js itself checks with
`!== null` (`PROP_ADDR_SUPPORTED`/`DOCS_SUPPORTED`/`LENDER_TRACK_SUPPORTED`)
directly to `false` from the test — reachable because these are top-level
`let`s in a classic (non-module) `<script>`, so a page-scoped global, not a
closure variable; verified this actually resolves to the same runtime state
a real un-migrated database produces, not a shortcut around it. With all
three forced false, the board reloads with zero console errors, zero
42703s, `#board` stays visible and rendered (not the `renderLoadError`
branch), and the captured select is proven to have OMITTED exactly
`property_address`/`waiting_on`/`solicitor_firm`/`application_status` while
still carrying the base list and the clients embed — the gated columns are
structurally impossible to 42703 because they are simply never asked for
when their detector says no, not because the mock happens to be forgiving.

No bug found: every field the board's named select is supposed to carry
renders with a real value on both the card and the table, for both the
owner and an adviser; the un-migrated path never 42703s; and the full
regression battery (`smoke.js`, `r8_rev.js`, `r13.js`, `r18.js`, `r23.js`)
passed unedited at its pre-R24 counts. The one regression R24's full run
surfaced — `tests/r11_ux.js`'s R23-era `#dash-cap-notice` ordering failure —
was FIXED in R24 (the two `R11-A` asserts now skip the hidden notice); r11_ux
is back to 123/0.

R25 notes: Data health's new "Missing application/offer date" check
(`loadDataHealth()`, app.js), a new `#dh-tile-milestone` tile (placed right
after `#dh-tile-nocompleted`, `.warn` when its count is >0) + `#dh-milestone-
panel`, wired through the pre-existing `wireTile` helper exactly like
`#dh-tile-nocompleted`. The `noMilestoneDate` predicate walks every case
outside `not_proceeding` stage, via STAGES' canonical rank: a case that has
reached >= application with `submitted_at` blank is flagged for the
application date; otherwise, if forward dates are supported, a case that has
reached >= offer with `offer_issued_date` blank is flagged for the offer
date — earliest-missing wins, so a case can only ever appear once. This is
deliberately independent of the pre-existing `#dh-tile-nocompleted` tile
(missing `completed_at`) — a completed case with both earlier dates present
but no `completed_at` must not appear here, and doesn't. `submitted_at`
joined the page's main (already-existing) `cases` select; `offer_issued_date`
is read in its own soft query behind `forwardDatesSupported()`, the same
pattern `dhExchangeBy` already uses for `exchange_date`, so an un-migrated
database is never asked for a column it doesn't have.

`tests/r25.js` (45 checks) proves this two ways: §B recomputes the whole
`noMilestoneDate` set independently off `window.__mockDb` (STAGES' order is
read directly off the page, the same fair-game shared-constant convention
r19/r20/r24 already use for `STAGE_LABEL`/`fmtM`/etc. — but the filtering
logic itself is reimplemented from the round's spec, not borrowed from
app.js) and asserts the panel's exact case-id set (parsed off each row's
`Open` button `onclick`) against it — not merely a matching count. Six
purpose-built synthetic cases, inserted independently of fixture composition
per the standing rule (the natural fixture happens not to contain a
completed case with a blank `completed_at` but both earlier dates present —
the one scenario that most directly tells this tile apart from
`#dh-tile-nocompleted`), pin down every boundary the round's spec names:
past-application-no-submitted_at (flagged), pre-application (not),
not_proceeding (not), both-dates-present (not), completed-missing-only-
completed_at (not — the key one), and a genuine offer-date miss (flagged).
§C checks the reason-text format for one app- and one offer-reason row,
picked programmatically off the recomputed ground truth. §D is a light
regression check that `#dh-tile-nocompleted`/`#dh-tile-rateend` still exist
and work (r13.js owns their full coverage). §E checks no console errors for
owner and admin. §F forces `FORWARD_SUPPORTED = false` directly (same
module-scope-`let` technique r24.js §E already uses) before Data health's
first load and confirms the offer half of the predicate is genuinely
skipped (not merely empty by chance — no row cites the offer-date reason)
with no console error and no 42703 anywhere on the page.

No bug found: the predicate matches its independent recompute exactly on
both the natural fixture and all six synthetic boundary cases, the reason
text is formatted exactly as specified, the forward-dates-off path never
42703s, and the full regression run below (`smoke.js`, `tests/r13.js`,
`tests/r18.js`, `tests/r23.js`, `tests/r24.js`) passed completely unedited
at its pre-R25 counts — R25 did not perturb `#dh-tile-nocompleted`/
`#dh-tile-rateend` or anything else on the page. (An earlier draft of this note
repeated a stale "r11_ux still failing" line from the R24 notes; in fact R24
FIXED r11_ux — it runs 123/0 on this HEAD, verified.)

R23 notes: defeats the silent 1,000-row PostgREST cap on the 19 OWNER-facing
full-table reads R18-P7's `REPORTS_ROW_CAP` fix never reached (that round
only bounded Reports/Monday money). One new shared ceiling,
`let OWNER_ROW_CAP = REPORTS_ROW_CAP;` (app.js, just after `renderCapNotice()`,
= 20,000), added to: `readDashboardCases` (all 3 branches), `loadPipeline`,
`loadClientData`, `loadDataHealth` (cases/clients primary reads + the
42703-retry + `case_documents` + `email_queue` + waiting-on cases +
`exchange_date` cases + care/vulnerability clients), `fetchMatchClients`,
`clientDobStats`, `openCase`'s `fetchClientPicker`, `openAppt`'s client read,
`revFetchClients`, `revFetchCases` — every one gets `.order(<pk>).limit
(OWNER_ROW_CAP)`. A truncation-disclosure notice mirrors Reports' own
`renderCapNotice`/`#report-cap-notice` pattern exactly but stays a fully
separate mechanism: `ownerCapHit(rows)` + `renderOwnerCapNotice(sel, hit)`,
four new hidden `.dq-notice` containers (`#dash-cap-notice`,
`#board-cap-notice`, `#clients-cap-notice`, `#data-cap-notice`), rendered
right after each page's relevant read. Reports (`REPORTS_ROW_CAP`) and
Monday money (which reads under `REPORTS_ROW_CAP`, not the new cap) are
deliberately untouched — two independent ceilings, proven independent in
`tests/r23.js` §E (moving one never moves the other, and each notice fires
only off its own cap). `window.__setOwnerRowCap(n)` (mock-only, guarded
behind `window.supabase.__isMock` exactly like the pre-existing
`window.__setReportsRowCap`) is what lets `tests/r23.js` make the cap bite
on this book's 69-case/50-client fixture without needing a 20,000-row seed.

`tests/r23.js` (76 checks, re-created from scratch this session — a prior
session's copy was written and green-lit but lost to a sandbox recycle
before being committed; this file both re-establishes the coverage and
independently verifies the round's hand-reconstruction) monkeypatches
`window.__mockDb.from` to wrap each returned builder's `.limit()` call,
recording the table name, the limit argument AND the row count the read
actually resolved with — so every assertion is proof a real `.limit()` call
fired and truncated real data, not just a source-level grep. §A confirms the
two constants and both test hooks. §B (the most important section — "zero
regression below the cap") loads Dashboard/Pipeline/Clients/Data health as
the owner with the cap at its 20,000 default and asserts each page's
cases/clients read resolves with the FULL fixture count (never merely
`<=` the cap), every page renders normally, and all four notices stay
hidden. §C spot-checks two of Data health's subsidiary capped reads
(`case_documents`, `email_queue`). §D sets `__setOwnerRowCap(10)` (below the
fixture), reloads all four pages, and confirms each read now resolves with
EXACTLY 10 rows, the matching notice becomes visible with the exact expected
text, and the page still renders on the truncated set (e.g. the client list
renders exactly 10 rows, not zero and not 50) — then resets the cap and
confirms every notice hides again and the client list is back to the full
50. §E proves Reports/Monday money independence as described above. §F is
the gating light-check: an adviser (p2) navigating to `#money` is bounced to
the dashboard with the hash rewritten off `#money` too, while Pipeline and
Clients stay reachable and render content for that same adviser; no console
errors anywhere in the file. To confirm the suite isn't trivially green, one
of the nineteen `.limit(OWNER_ROW_CAP)` call sites (`loadPipeline`'s cases
read) was temporarily reverted during this session and re-run — `tests/r23.js`
failed exactly the 6 checks that call site's own reads feed (§B2, §D2), then
passed 76/76 again once restored. No bug was found in the R23
reconstruction itself: every read named in the round's own spec carries its
`.limit`, every notice fires and clears correctly, and Reports/Monday money
are untouched, confirmed by the full regression run below.

R20 notes: "actionable" Pipeline MI — per-panel CSV export + click-through
drill-downs on top of R19's `#report-mi-section`, frontend + tests only, no
new DB schema. Everything filters the SAME in-memory `all`/`rows` array
`renderPipelineMI` (app.js ~18041) already reads for R19's panels — no new
query, no new `REPORTS_ROW_CAP` walk.

**CSV export.** Each of the four MI panels gets a small "⭳ CSV" button in
its header — `#report-mi-csv-funnel` / `#report-mi-csv-velocity` /
`#report-mi-csv-revenue` / `#report-mi-csv-scoreboard` (static markup in
`admin/index.html`, wired at the END of `renderPipelineMI`, app.js
~18258-18288) — plus the drill-down modal's own `#mi-drilldown-csv`
(app.js ~18339). All five emit through one shared `miCsv(filename, header,
rows)` (app.js ~18297), which is **NOT** exposed on `window` and reuses
`exportCsv`'s (app.js ~8735) EXACT serialization contract byte-for-byte —
same `q2()` quote-doubling, same `=+-@\t\r` formula-injection guard (prefix
a literal `'`), same UTF-8 BOM, same `Blob` + `<a download>` click — rather
than a second CSV library. Filenames `nexmoney-mi-<panel>-YYYY-MM-DD.csv`
(the panel CSVs' date is fixed at RENDER time inside the `dstr` closure
variable; the drill-down CSV's is computed fresh at CLICK time inside
`miDrilldown`'s own `csvBtn.onclick` — a real, if very low-probability,
UTC-midnight-crossing distinction `tests/r20.js` notes but doesn't chase).
Because the owner/admin gate (`isAdminOrOwner()`) is an early `return`
at the TOP of `renderPipelineMI`, before any of the panel content or CSV
wiring runs, an adviser's `#report-mi-csv-*` buttons exist in the DOM
(they're static HTML in the panel headers) but their `.onclick` is simply
never assigned — `tests/r20.js` §A asserts this directly
(`typeof btn.onclick === "function"`) rather than only checking the
section's `.hidden` class, which is the precise mechanical reason they
"aren't reachable" for an adviser.

**Drill-down modal.** `window.miDrilldown(title, cases)` (app.js ~18316,
window-exposed) renders `#mi-drilldown` (class `mi-drilldown`) inside the
pre-existing `#modal` / `openModal()` / `closeModal()` infra — no new modal
system. A titled table (`.mi-drill-table`): client (`clients.first_name` +
`last_name`, joined — the Reports `cases` select already embeds
`clients!client_id(first_name,last_name)`, present since before R19) ·
stage (`STAGE_LABEL`) · adviser (`staffName`, "Unassigned" when
`assigned_to` is null) · fee (`fmtM`, broker+proc) · an `Open` button
(`onclick="closeModal(); openCase('<id>')"` — verified live, not just by
reading the code: `tests/r20.js` §F clicks it and reads `#case-form`'s
`data-case-id`, since `openCase` renders `<form id="case-form"
data-case-id="...">`, app.js ~10380). A `.mi-drill-count` header chip
states the exact row count; `#mi-drilldown-csv` only renders when the list
is non-empty ("nothing to export" — `tests/r20.js` §G proves the empty
path: `window.miDrilldown('x', [])` → "No cases match.", count chip `0`,
`#mi-drilldown-csv` absent from the DOM entirely, not just hidden).
`#mi-drilldown-close` closes it the normal way (`closeModalGuarded`).

**Click-through figures, and their exact filters** (all real `<button>`s,
so Enter/Space work with no extra keydown handling — `tests/r20.js` §E
proves the Enter path end to end, not just the tag name):
- Funnel stage bars — `#report-mi-funnel .mi-bar-row[data-mi-stage]` → live
  cases where `c.stage === s`. **The bar's tag changed from a plain `<div>`
  to a real `<button class="mi-bar-row" data-mi-stage="…">`** (title/
  `aria-label` carry the click affordance and the count) — this is the ONE
  shared-markup change R20 made that an earlier suite's selector reached: see
  the `tests/r19.js` fix below. A zero-count bar (this round's fixture
  deliberately leaves "Fact Find" at 0 live cases to prove it) renders
  `disabled` — nothing to open behind it, and a disabled `<button>` is
  neither focusable nor clickable, so this is a real a11y guarantee, not
  just a visual dimming.
- Scoreboard adviser rows — `#report-mi-scoreboard .mi-adv-link[data-mi-adv]`
  → **ALL** of that adviser's cases, `(c.assigned_to || "__unassigned") ===
  key` — live AND terminal both, not scoped to the Reports month picker
  (unlike the scoreboard table's own `completedPeriod`/`feesPeriod`
  columns) — `tests/r20.js` §D3 proves this by seeding a p2 case with NO
  period-relevant dates and confirming it's still in the drill-down.
- Win-rate figure — `#report-mi-winrate-link` (only rendered at all once
  `terminal >= 5`, same thin-data guard as the headline text it replaces)
  → every terminal case, `c.stage === "completed" || c.stage ===
  "not_proceeding"`, unfiltered by adviser or month.
- Conversion steps and velocity rows are NOT click-through this round
  (SPEC20.md marked them optional/"do if cheap"; not done — noted here so a
  future agent doesn't go looking for a test that was never going to exist).

**The one existing-suite edit, and exactly why it was correct (not a
mask).** `tests/r19.js`'s own funnel assertion
(`#report-mi-funnel > div`, then `querySelectorAll("span")[0]`/`[1]` by
POSITION for label/count) broke against current `app.js` on two counts: (1)
the div→button change above, and (2) the funnel bar's progress-fill is
nested one level deeper than the r19 author's positional-span assumption
expected (`<span class="mi-bar-track"><span class="mi-bar-fill"
…></span></span>` — `querySelectorAll("span")` walks depth-first, so
`spans[1]` lands on the empty-text `.mi-bar-track` wrapper, not
`.mi-bar-n`). Both are genuine R20-era shared-markup changes to the same
funnel row R19 already asserted against, not new assertions and not a
pre-existing bug the fix happens to paper over — grepping `#report-mi-funnel`
confirms `tests/r19.js` was the ONLY other file that ever queried inside a
funnel row. The fix (`tests/r19.js`, Panel-1-funnel block) replaces both the
row selector (`#report-mi-funnel > .mi-bar-row`) and the label/count reads
(`.querySelector(".mi-bar-lbl")` / `.querySelector(".mi-bar-n")` by CLASS,
not position) — same two facts asserted (stage order + exact count per
stage), same expected values, zero change to what the test proves, only to
how it locates the DOM it's reading. Re-ran the full `tests/r19.js` suite
after the fix: 39/39, unchanged from its R19-era count. Every other R19
selector this round's `grep` checked (`#report-mi-winrate`,
`#report-mi-scoreboard table tr`, all four panel container ids, all four
jump-nav chip ids) reads via `.textContent`/`td` values that don't care
whether their ancestor is a `<div>` or a `<button>`, or was never touched by
R20 at all, and needed no change.

**Why the rest of the pre-existing battery needed zero edits for R20.**
Grepped every test file for `report-mi-`, `mi-bar`, `mi-adv-link`,
`mi-drill`, `openCase`, `exportCsv`, and `#modal`/`openModal`/`closeModal`
before writing anything new: no suite before r19/r20 reaches
`#report-mi-section` at all (owner-gated Reports content an adviser never
sees, same as R19), `exportCsv`'s own callers (`tests/r8_touch.js`'s CSV
export panel, `tests/r13.js`'s bulk client export) are untouched fixed-shape
CSVs with their own filenames/columns that `miCsv` doesn't touch, and
`openModal`/`closeModal`/`openCase` are called exactly the same way R20
calls them (no signature change) so every earlier modal-driving suite
(r5_batch1/2/4, r12b) kept passing unmodified. Ran the WHOLE battery in
HARNESS order after building `tests/r20.js` and fixing `tests/r19.js`: every
suite passed, confirming no other shared selector or count drifted.

R19 notes: owner/admin Pipeline MI on Reports — four panels, no new DB
schema, computed client-side in ONE O(n) pass over the same `cases` read
Reports already does (plus `submitted_at`/`offer_issued_date`, now added to
that select alongside the pre-existing `completed_at`/`created_at`).
**Everything is derived from milestone DATE columns, never from
`stage_changed` case_events** — the CTO spec called this out explicitly
because the DB carries only ~36 pre-launch stage-change events, nowhere near
enough to drive a funnel; date columns are populated on every real case and
only get richer as the book grows.

**Container + gate.** `#report-mi-section` (`renderPipelineMI`, app.js ~18041)
holds all four panels; gated as a whole with the same `classList.toggle
("hidden", !isAdminOrOwner())` mechanism the pre-existing money panels use —
NOT `isOwner()`, MI is explicitly owner-AND-admin per spec. The Reports jump
nav (`REPORT_JUMP_SECTIONS`) reads that same `.hidden` via `repJumpVisible()`,
so an adviser gets neither the section nor any of its four chips
(`#rep-nav-mi` / `-mivelocity` / `-mirevenue` / `-miboard`) — verified on
both personas, not just read from the source.

**Panel 1 — funnel & conversion** (`#report-mi-funnel-panel`,
bodies `#report-mi-funnel` / `#report-mi-conversion` / `#report-mi-winrate`).
Funnel = live-stage counts (`MI_LIVE_STAGES` = enquiry/fact_find/
decision_in_principle/application/offer/exchange) as horizontal bars.
Conversion walks `created → submitted_at set → offer_issued_date set →
completed_at set`, each step's % = `round(thisStageCount / previousStageCount
* 100)` — note this is **not clamped to 100%** anywhere in the code (a case
can have `completed_at` without `offer_issued_date`, since these are
independent date-presence checks, not a strict funnel), and `tests/r19.js`'s
own fixture deliberately keeps `reachedCompleted` comfortably below
`reachedOffer` to stay in the intuitive range while still proving the exact
un-clamped formula. Win rate = `completedN / (completedN + notProceedingN)`
among cases that reached a terminal stage, with a `< 5` terminal thin-data
guard ("not enough completed cases yet for a reliable rate (N terminal
case(s))") in place of a noisy %.

**Panel 2 — velocity** (`#report-mi-velocity-panel`, bodies
`#report-mi-velocity` / `#report-mi-bottleneck`). Four transitions —
created→application, application→offer, offer→completion, created→completion
(total) — each counted ONLY where both its endpoints exist and the gap is
`>= 0` days; median is the headline (`miMedian`: sorted-array middle, or the
rounded average of the two middles when even-length), average alongside
(`miMean`: rounded mean), `n=` shown per row. Bottleneck names the sub-step
(to application / underwriting / completion — the total-cycle row is
excluded from bottleneck candidacy) with the LARGEST median, or "Not enough
dated cases yet to identify a bottleneck." when none of the three have any
data at all.

**Panel 3 — revenue** (`#report-mi-revenue-panel`, bodies
`#report-mi-forecast-headline` / `#report-mi-runrate` / `-basis` /
`#report-mi-forecast`). Run-rate = `sum(broker_fee + proc_fee)` for cases
whose `completed_at` falls in each of the last 12 calendar months
(oldest→newest, host-local Y/M exactly like the existing 6-month completions
trend), rendered as bars with a `title="YYYY-MM: £X"` attribute per bar (the
easiest, least-brittle way for a test to read the exact bucketed figure) plus
a 12-month total in the basis line. Forecast = `Σ(live-stage fee × stage
weight)`; weight is `MI_STAGE_DEFAULT_WEIGHT` (enquiry .1 / fact_find .2 /
decision_in_principle .4 / application .6 / offer .85 / exchange .95) UNLESS
`reachedCompleted >= 5` (NOT thin) AND that specific stage's own reach count
is `>= 5`, in which case application/offer are individually replaced with
their historical `stageAndCompleted / stageReached` rate — enquiry/fact_find/
DIP/exchange never calibrate (no historical reach counted for them at all in
this round's formula), so the label reads "(application/offer weights
calibrated from history; other stages default likelihoods)" the moment
EITHER one calibrates, "(default likelihoods — will calibrate as cases
complete)" otherwise. `tests/r19.js` exercises BOTH branches on two separate,
fully-wiped-and-reseeded case books (Block B: 2 terminal cases, thin,
zero-value default-weight forecast; Block C: a larger known set with
`reachedCompleted/reachedApp/reachedOffer` all `>= 5`, calibrated).

**Panel 4 — scoreboard** (`#report-mi-scoreboard-panel`, body
`#report-mi-scoreboard`). Grouped by `cases.assigned_to` (`|| "__unassigned"`
→ an "Unassigned" row, name resolved via `staffName`/profiles); columns are
live count (now), completed + fees written (both scoped to the Reports
MONTH PICKER's selected month, `mv` — defaulting to the current month, same
variable `renderMonthReport` already uses), win rate + median cycle (BOTH
all-time, not period-scoped — `winPct` and `medCycle` read the FULL history
of `stage==='completed'`/`'not_proceeding'` regardless of when), sorted by
fees-written-(period)-descending. Win rate carries its own `< 5`-terminal
"weak" wrapper (`.stat-weak`) per adviser row, same threshold and same
textual shape as Panel 1's headline guard, just per-row instead of once;
`tests/r19.js`'s fixture deliberately puts one adviser exactly AT the
term-5 boundary (confident) and the Unassigned row at term=1 (weak) to prove
both branches render.

**Test design note for anyone extending `tests/r19.js`.** Every panel reads
the WHOLE `cases` table (bounded by `REPORTS_ROW_CAP`, not date-filtered to
the selected month — only the scoreboard's completed/fees columns are
period-scoped), so a meaningful precision test has to fully control that
table: each block starts `await window.__mockDb.from("cases").delete()`
(unconditional — Owner/Administrator only, which `p4` is) then reseeds a
fully-known row set, rather than trying to reason about fixture composition.
`computeExpectedMI()` in the test file is an independent re-implementation of
every formula above (never calls `renderPipelineMI`); the only app.js
functions it calls directly are pure DISPLAY formatters (`fmtM`,
`localMonthStr`) used purely to render the SAME already-independently-computed
number the same way the page would, exactly as `tests/r17.js` unit-tests
`fmtM`/`fmtM2` directly — never the feature logic itself. Velocity/conversion/
run-rate/forecast rows are built with deliberately DECOUPLED milestone dates
(e.g. a row testing `submitted_at → offer_issued_date` omits `created_at`
entirely, which defaults to "now" in the mock and therefore yields a NEGATIVE
`created_at → submitted_at` gap that the `>= 0` guard excludes) so one fixture
row never silently pollutes an arithmetic array it isn't meant to be part of.

R18 notes: scale/speed hardening — five fixes (P1 perf-only, no behaviour to
test) plus P2/P3/P4/P6/D1/P7, frontend + mock only, no new DB columns.

**P2 — `debounce()`** (app.js ~224), a plain trailing-edge wrapper (default
250ms) around `#client-search` and `#board-search`'s `input` listeners, and
the client-row bulk-select checkbox handler is now ONE delegated listener on
`#client-list` instead of one per row (perf only — the existing bulk-bar
suites already cover its behaviour, nothing new to assert). **RULE FOR
FUTURE TESTS: never assert on a search/filter box's result within ~250ms of
the last keystroke** — `tests/r18.js` §D checks the list is UNCHANGED at
~50ms and HAS updated by ~450ms, the same margin `tests/r17.js`'s snooze
waits already use, comfortably clear of the 250ms boundary in either
direction.

**P3 — the unactioned radar's 90-day activity read** (app.js ~7154, inside
the existing `loadUnactioned()` from R17 §2). MEMBERSHIP is still the 7-day
`UNACTIONED_DAYS` rule (a case with any note/event inside the last 7 days is
never quiet); what changed is the LABEL's basis — `lastActivity` is now read
from a 90-day window (previously it only ever saw what the 7-day query
returned, i.e. nothing for a genuinely quiet case, so the label ALWAYS fell
back to `created_at`). A note 8–90 days old now shows its TRUE age ("quiet N
days"); a note beyond 90 days is invisible to the read and the label still
falls back to `created_at`, exactly as before this round.
`tests/r18.js` §F proves all three bands on fresh `mkQuietCase()` fixtures
(30-day note → true age shown; 3-day note → excluded from the radar
entirely, membership unchanged; 100-day note on a case with a KNOWN
`created_at` → falls back to that date, not the invisible note).

**P4 — render caps.** `BOARD_COL_CAP` (50, app.js ~7211) per pipeline-board
column: `boardExpandedStages` (a `Set` of stage keys) plus `window.
boardShowMore(stage)` and a `.board-show-more` "Show N more" button reveal
the rest; the column's `<h4><span>` count is always the TRUE total, never the
capped render count, and the Set persists across re-renders (a search/filter
change, or any other `loadPipeline()` call) so an expanded column stays
expanded with no re-click. `CLIENT_LIST_CAP` (100, app.js ~12112) on the
client list works the same way but has no expand control — a
`.client-list-cap-note` ("Showing 100 of N — refine your search to narrow the
list.") is the only way past it, and BOTH the segment chip counts
(`renderClientSegments`, reads the full `searched` array) and the bulk bar's
"Select all N shown" (`renderClientBulkBar`, reads the full `list`) describe
the uncapped total throughout. `tests/r18.js` §B/§C seed fresh rows ON TOP OF
whatever the fixture book already has and read the BASELINE count off the
app's own rendered header/total before seeding — no test in this file
assumes fixture composition, exactly the "compute from fixtures at runtime"
standing rule.

**D1 — client-save optimistic-concurrency guard** (app.js ~13376), mirroring
the case-save guard from an earlier round exactly: `openedClientUpdatedAt` is
captured the moment `openClient(id)` loads the row (`null` for a brand-new
client — an INSERT is never guarded) and the save is `.update(row).eq("id",
id).eq("updated_at", openedClientUpdatedAt)`. Zero rows back means the row
changed since it was opened; a `confirm()` offers OK (reload — discards the
on-screen edit and re-opens showing the CONCURRENT value) or Cancel (keep
editing — `refreshOpenedClientStamp(id)` re-baselines the stamp to the
current row and returns WITHOUT writing, so a second Save then succeeds and
applies the operator's edit on top of the concurrent one). `tests/r18.js` §E
drives all three paths for real (happy path / Cancel-then-retry / OK-reload)
against `window.__mockDb`-mutated rows, checking the database state at each
intermediate step so a silent overwrite would be caught even if the dialog
handling looked right.

**P6 — client-picker cache.** `clientPickerCache` (app.js ~9676) holds the
case modal's `#case-client-select` option list for the session;
`invalidateClientPicker()` drops it and is called from every client-INSERT
path (`openClient`'s own Save, the case modal's inline "+ New client…" flow,
the Revolution importer). A case already open on a client absent from the
cache self-heals with one refetch (`if (id && c.client_id && !clients.some
(...)) clients = await fetchClientPicker()`), for a path that forgot to
invalidate or a race — this affects only an EXISTING case being reopened, not
a brand-new one. `tests/r18.js` §G drives the real UI (not a direct DB
insert) — clicks "+ New client…", saves, then opens a brand-new case in the
SAME session with no reload — and confirms the client is in the select.

**P7 — `REPORTS_ROW_CAP`** raised 5000 → 20000 (app.js ~18242): at current
scale `stage_changed` case_events alone already exceed 5000, so the old cap
was silently truncating Reports/MI reads. `tests/r18.js` §A reads the live
constant directly (`page.evaluate(() => REPORTS_ROW_CAP)`, the same top-level-
lexical-scope trick `tests/r17.js` already uses for `localDateStr()`) —
checked FIRST in the file, before anything could call the test hook
`window.__setReportsRowCap(n)` and mutate it away.

**Server-side note (not testable in this harness, carried here for the
record):** the CTO spec's index recommendations for the newly-hot `cases`
(`assigned_to`, `stage`), `case_notes`/`case_events` (`case_id, created_at`)
columns are a production-database concern with no mock-Supabase equivalent —
`mock-supabase.js` has no query planner to regress, so there is nothing for
a harness test to assert here; noted so a future agent doesn't go looking
for a test that was never going to exist.

**Why the pre-existing battery needed zero edits for R18 or R19.** Grepped
every test file for the touched symbols/selectors before writing anything
new — `BOARD_COL_CAP`/`.board-show-more`/`boardExpandedStages`,
`CLIENT_LIST_CAP`/`.client-list-cap-note`, `debounce`, `openedClientUpdatedAt`
/`refreshOpenedClientStamp`, `UNACTIONED_DAYS`/the radar's old 7-day activity
read, `clientPickerCache`/`invalidateClientPicker`, `REPORTS_ROW_CAP`, and
every R19 MI id/selector — and nothing in the pre-R18 battery asserted the
OLD (uncapped / undebounced / unguarded / 7-day-only) shape of any of them,
nor does any earlier suite reach `#report-mi-section` or its chips (R19 is
new, additively-gated content an adviser never sees and the jump nav only
draws for owner/admin). Ran the WHOLE battery (smoke + r5_batch1..9 + r64 +
r8_touch + r8_rev + r9_adv + r9_docs + r9_embed + r11_ux + r12a + r12b + r13
+ r14 + r15 + r16 + r17) after building both rounds: every suite passed
UNCHANGED, confirming no shared selector or count drifted.

R17 notes: proactive workflow (three features) + six papercut fixes, frontend
+ tests only, no new DB columns — every task write in this round uses the
existing `case_tasks` table.

**§1 Stage playbooks.** `CASE_STAGE_PLAYBOOK` (app.js) maps each stage to an
array of `{title, dueOffsetDays, notKinds?, onlyKinds?}` suggested tasks —
enquiry(2) / fact_find(3) / decision_in_principle(2) / application(4,
one BTL-only) / offer(3, one non-PT) / exchange(2) / completed(3);
not_proceeding has no entry on purpose. `caseStageChecklistHtml(c, tasks)`
renders it as a "Stage checklist" panel for the case's CURRENT stage only —
`#case-stage-checklist` wraps `#stage-checklist-items`, each row either a
`.playbook-add` button (`aria-label="Add task: <title>"`) or, once an OPEN
(`done_at` null) `case_tasks` row with a matching title exists, a disabled
`.playbook-done` "✓ added" marker — the map returns `""` (no panel at all)
when the stage has no entry, which is how not_proceeding stays clean.
`window.playbookAdd(caseId, stage, kind, idx)` RE-READS the case's open tasks
at click time before inserting, so a double-click (or a second tab) can never
write a duplicate — it just repaints to the ✓ state. `#playbook-add-all` /
`window.playbookAddAll` inserts every not-yet-open step in ONE call and only
renders while at least one step is outstanding. Kind-gating: "Instruct
valuation" and "Confirm solicitor instructed" carry `notKinds:
["product_transfer"]`; "Confirm ICR / rental income" (application stage)
carries `onlyKinds: ["buy_to_let"]` — verified live (not just by reading the
code) by opening a fresh buy_to_let application case and a fresh
product_transfer application/offer case through the mock and reading the
rendered checklist for both.

**§2 Unactioned-cases radar.** `#unactioned-panel` / `#unactioned-list` on the
dashboard, `loadUnactioned()` (app.js). Predicate: stage NOT IN
(completed, not_proceeding) AND zero OPEN `case_tasks` AND no `case_notes` /
`case_events` row in the last `UNACTIONED_DAYS` (7) days. Adviser-scoped
exactly like the rest of Today: `mine = !!(ME && ME.id) && !isAdminOrOwner()`
— an adviser sees only cases whose `assigned_to` is them, owner/admin see the
whole firm. The panel is a `dash-drawer` that starts `class="collapsed"`;
`autoDrawer("unactioned", quiet.length > 0)` auto-opens it whenever there is
something to show (same pattern as the Watchtower and Leads drawers) —
content is always in the DOM and readable via `$eval` regardless of the
collapsed state, only a real click needs the drawer opened first.
**MOCK BEHAVIOUR THAT MATTERS FOR TESTING THIS**: every `cases` insert
auto-logs a `case_created` `case_events` row stamped "now"
(`mock-supabase.js`'s `_runInsert`: `if (table === "cases") caseEvent(row.id,
"case_created", …)`), so a case fresh out of `mkClientCase` is NEVER quiet on
its own — it always has activity inside the 7-day window. `tests/r17.js`'s
`mkQuietCase()` helper creates the case and then deletes its `case_events` (and
`case_notes`, belt-and-braces) to reach the same end-state a real case reaches
only once its creation-day activity has aged out — this is a TEST-SETUP
technique, not a mock or app change. No mock table/column gaps were found —
`case_tasks`, `case_notes` and `case_events` already supported everything the
radar reads and the playbook/dedupe writes (a generic `.not(col, op, val)`
filter already existed in the query builder for the `stage NOT IN (...)`
read).

**§3 Task snooze.** `taskSnoozeControlsHtml(taskId, ctx)` renders
`#snooze-1d-<ctx>-<taskId>` / `-3d-` / `-1wk-` (buttons, each with its own
`aria-label`) and `#snooze-pick-<ctx>-<taskId>` (a labelled date input),
`ctx` is `"tasks"` (Tasks-due panel) or `"brief"` (My Day) — the same task can
carry both simultaneously since it can appear on both lists.
`window.snoozeTask(id, days)` moves `due_date` FORWARD by `days` from
`max(today, current due_date)` — an overdue or undated task snoozes from
today, a task already due in the future snoozes from its OWN due date, so
+1d on a task due in 5 days lands on +6, never pulls it earlier.
`window.snoozeTaskTo(id, value)` sets an exact date outright. Both call
`snoozeRepaintAll()` (`loadTasks(); loadBriefing();`), repainting both lists
regardless of which one the click came from. **TEST-HARNESS NOTE**: `#tasks-panel`
is a `dash-drawer` that starts `class="collapsed"` and — unlike Watchtower/
Leads/the radar — has NO `autoDrawer()` call, so it never auto-opens; a real
click on a snooze button needs the drawer opened first
(`tests/r17.js`'s `openDrawer()`, same pattern `tests/r12b.js` already uses).
My Day (`#briefing-panel`) is a plain panel, not a drawer, always visible.

**§4-9 Papercut fixes**, each confirmed at the line the CTO spec named:
1. GI badge (Protection page, ~8888) — `caseGiApplies(r.case_kind)`
   (`GI_KINDS` = purchase/first_time_buyer/buy_to_let/remortgage) replaces the
   old `["purchase","first_time_buyer"].includes(...)`. **No existing suite
   needed updating** — grepped every test file for `gi_status`/`GI_BADGE`/
   `loadProtectionPage` assertions and none asserted the old (buggy)
   behaviour for a BTL/remortgage case; `tests/r17.js` §E is the first
   coverage of this path, on fresh cases.
2. Singular "1 day ago" — both sites (~5478 dashboard rate chip, ~19190
   Reports rate-end recovery) already carry the `=== 1 ? "day" : "days"`
   branch.
3. `fmtM`/`fmtM2` (~399-401) — both now read
   `n == null || n === "" || isNaN(Number(n)) ? "—" : …`; `fmtM(0)` still
   formats as a real currency figure (0 is a valid number, not "missing").
4. `admin/index.html` — `aria-label` confirmed present on `#board-search`,
   `#board-adviser`, `#prot-filter`, `#client-search`, `#report-month`.
5. Tour — `tourRender()` focuses `#tour-next` after rendering (~4140).
6. `.more-actions-menu` (~7633) no longer carries `role="menu"`.

**Why no existing suite needed a fixture/assertion edit.** Grepped every test
file for the six fixed symbols/behaviours (GI badge, "1 day"/"day ago",
`fmtM`/`fmtM2`, the five aria-label ids, `#tour-next`, `role="menu"`) —
nothing in the pre-R17 battery asserted the OLD buggy shape of any of them,
so nothing needed correcting. **Ran the WHOLE battery** (smoke +
r5_batch1..9 + r64 + r8_touch + r8_rev + r9_adv + r9_docs + r9_embed + r11_ux
+ r12a + r12b + r13 + r14 + r15 + r16) after the R17 build. Two `r12b.js`
checks were failing on a date/wall-clock artifact (the session had rolled past
UTC midnight); Fable made them DETERMINISTIC in R17 rather than leave the
battery amber (a trustworthy battery is the loop's safety net):
  - **B1** constructed an "earlier today" appointment as `Date.now() - 3h`,
    which lands on the PREVIOUS calendar day when the run is within ~3h of
    local midnight. Fixed: clamp the timestamp to no earlier than the start of
    today, so it is always same-day (`tests/r12b.js` ~529).
  - **B5** booked its 4th appointment on `today + 12`, which collided with the
    even-day appointment seed (`mock-supabase.js:2001` seeds days 2..28) whenever
    `today+12` was even. Fixed: pick an ODD day-of-month (clamped ≤27) in the
    current month, which the seed never touches (`tests/r12b.js` ~716).
  RULE for future date-sensitive fixtures: never key a fixture date off raw
  `Date.now()` near a day boundary, and never reuse the even-day appt-seed days
  (2..28) — choose odd days in the current month.

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
