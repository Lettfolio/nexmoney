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
node tests/r30.js
node tests/r31.js
node tests/r33.js
node tests/r34.js
node tests/r35.js
node tests/r36.js
node tests/r37.js
node tests/r38.js
node tests/r40.js
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

**Full battery is 100% green (3,893/3,893), `tests/r9_docs.js` included
(255/0), `smoke.js` 152/0.** R40 added `tests/r40.js` (63 checks, §1–§7) — see
the "R40 notes" section below — and required three genuine, non-masking
repairs to pre-existing suites whose own selectors R40's product change
(`#notes-list` deleted; the case modal's notes now render inside the SAME
unified `#case-events-list` timeline the client record already used) moved
out from under them, none of them loosening what the suite was proving —
every repair swaps a stale selector/markup assumption for the new one and
reads back exactly the same fact:
`tests/r33.js` C1b now checks the typed note landed in `#case-events-list`
rather than the deleted `#notes-list` (55/0, count unchanged);
`tests/r64.js`'s H-01 re-file block (the happy path, the escaping check and
the in-flight-failure retry check) now finds a note's row by its
`.note-refile-btn[data-note-id]` / by its struck `<s class="tl-refiled">`
text inside `#case-events-list`, in place of the deleted `#notes-list
.note[data-note-id]`/`.note-body` markup — the same strike/badge/escaping
facts, read off the new markup (91/0, count unchanged); `tests/r9_adv.js`
R9-3(a) now finds the review-feedback row by its ⭐ icon and
`.review-score-chip` inside `#case-events-list` rather than the deleted
`#notes-list .note-review` class, and reads the comment text by cloning
`.tl-title` and stripping the chip/author-chip/Re-file-button children
rather than reading a separate `.note-body` element that no longer exists
(169/0, count unchanged). Every OTHER pre-existing suite (`smoke.js` through
`tests/r38.js`) re-ran unedited at its exact pre-R40 count — see the R40
notes below for what the new suite covers and why the three repairs above
are faithful to what R40 actually shipped (`admin/app.js`'s R40 commits,
09832e2 included).

**Full battery is 100% green (3,830/3,830), `tests/r9_docs.js` included
(255/0), `smoke.js` 152/0.** R38 added `tests/r38.js` (95 checks, §A–§G) — see
the "R38 notes" section below — and required one genuine, non-masking repair
to a pre-existing suite whose own ground truth R38's product change moved
out from under it: `tests/r33.js` A5c (plus its surrounding prose) now
asserts 13 `button[data-page]`s, not 12, because R38 added the Retention
button to the Book group — the assertion's PURPOSE (every nav destination
still lives inside `#topnav`, none orphaned by the grouping) is unchanged,
only the true count changed (55/0, count unchanged — this was a wording fix,
not a new assertion). Every OTHER pre-existing suite (`smoke.js` through
`tests/r37.js`) re-ran unedited at its exact pre-R38 count. `smoke.js` itself
was already updated by the build agent before this session started (152
checks, up from 144 — the new page and its rows) and needed no further
change. R37 added `tests/r37.js` (123 checks, §1–§12) — see the "R37 notes"
section below — and required three genuine, non-masking repairs to
pre-existing suites whose own ground truth R37's product change moved out
from under them (none of the three loosened what the suite was proving):
`tests/r31.js` B1/B2 pre-seed `nx_views_v1` with a PRESENT-but-empty store
before their "starts from nothing" assertions, because R37's starter-views
feature now seeds 1-3 views into a genuinely ABSENT key and every `newPage()`
call is a fresh, isolated browser context (so the key was always absent
there, regardless of the suite's own `clearViews()`) — a present-but-empty
key is the R31-era ground truth those blocks were written against, and
seedStarterViews() treats "present" as "leave it alone" by design, so this
restores the exact original assertions rather than relaxing them (55/0,
count unchanged); `tests/r5_batch5.js` §S3c now fills `#prot-comm-input` and
clicks `#prot-comm-save`/`-skip` instead of answering a `prompt()`, because
R37 moved the required-commission capture onto its own overlay — the
downstream `confirm()` and its wording are untouched, so only the STEPS
between the bulk-status pick and the confirm changed (79/0, count unchanged);
`tests/r24.js` D4/D5/E4 now assert the board's clients embed reads
`clients!client_id(first_name,last_name,email)` rather than the pre-R37
string, because R37's board duplicate-hint (W9) widened it to carry `email`
— the assertion's PURPOSE (a named, non-`"*"` embed, appended last) is
unchanged, only the new true string (89/0, count unchanged). `tests/r26.js`
§F (`p2`, non-owner) still holds verbatim — R37's admin read-only targets
section is additive for `MY_ROLE === "admin"` only, and p2 is an adviser —
so it needed no edit at all; `tests/r37.js` itself adds the admin-side
coverage §F never had (§11a-d). Every OTHER pre-existing suite (`smoke.js`
through `tests/r36.js`) re-ran unedited at its exact pre-R37 count. R36 added
`tests/r36.js` (83 checks, §A–§D) — see the "R36 notes"
section below — and required one genuine, non-masking fix to a pre-existing
suite whose own flow R36's product change now interrupts (`tests/r8_touch.js`
R8-2's bulk-task block — see the R36 notes for exactly why: 151/0, count
unchanged, only the steps between the click and the confirm changed); every
other pre-existing suite (`smoke.js` through `tests/r35.js`) re-ran unedited at
its exact pre-R36 count. R35 added `tests/r35.js` (43 checks) — see the "R35 notes" section
below — and required one genuine, non-masking fix to a pre-existing suite whose
own assertion R35's product change directly inverted (`tests/r16.js` A4 — see
the R35 notes for exactly why: 81 → 83), plus one deliberate strengthening of
`tests/r5_batch3.js`'s existing retention flow (66 → 68, two new assertions,
see the R35 notes); every other pre-existing suite re-ran unedited at its
exact pre-R35 count. R34 added `tests/r34.js` (60 checks) — see the "R34 notes" section
below — and required two genuine, non-masking fixes to pre-existing suites
whose seeded fixtures collided with R34's new adviser-scoped `#board-adviser`
default (`tests/r18.js` §B and `tests/r24.js` §C — see the R34 notes for
exactly why and how), plus a third to `tests/r5_batch9.js` where R34's diary
default change altered the very state the check's PRE-condition assumed (see
the R34 notes); every other pre-existing suite re-ran unedited at its exact
pre-R34 count. R33 added `tests/r33.js` (55 checks) — see the "R33 notes" section
below — and re-pointed three pre-existing suites at their new homes/fixed a
genuine cross-suite selector collision (see those notes for the exact,
non-masking fixes and why each was needed); every other pre-existing suite
re-ran unedited at its exact pre-R33 count. R31 added `tests/r31.js` (55
checks) — see the "R31 notes" section below — and every pre-existing suite
(`smoke.js` through `tests/r30.js`) re-ran unedited at its exact pre-R31
count; `admin/app.js`/`admin/index.html`/`admin/mock-supabase.js` were not
touched by this test-writing pass (R31's product code was already
built/uncommitted before this session started).
R30 added `tests/r30.js` (37 checks) — see the "R30 notes" section
below — and every pre-existing suite (`smoke.js` through `tests/r29_scale.js`)
re-ran unedited at its exact pre-R30 count; `admin/app.js`/`admin/mock-supabase.js`
were not touched by this test-writing pass (R30's product code was already
built/uncommitted before this session started). R28 is a small, already-built,
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
| `smoke.js` | 152 (R38 — up from 144: the new Retention page and its rows, see the R38 notes) |
| `tests/r5_batch1..9.js` (sum) | 559 (BATCH 9's day-collision fixed in R27 — see the R27 notes; R33 re-pointed a nav click in BATCH 1 and BATCH 8's `gotoSettings()` at the collapsed Firm group — see the R33 notes; R34 pre-seeded BATCH 9's Month/Day scenario with `nx_diary_staff="all"` so its Month-vs-Day memory check still guards what it always guarded — see the R34 notes; R35 added two assertions to BATCH 3's retention flow proving the live successor doesn't renag its own Rate & ERC row — see the R35 notes; R37 re-pointed BATCH 5 §S3c at the new `#prot-comm-box` overlay in place of the retired commission `prompt()` — see the R37 notes; sum 557 → 559, unchanged by R37) |
| `tests/r64.js` | 91 (R40 re-pointed the H-01 re-file block at `#case-events-list`/`.note-refile-btn[data-note-id]`/`s.tl-refiled` in place of the deleted `#notes-list` markup — see the R40 notes; count unchanged) |
| `tests/r8_touch.js` | 151 (R36 resolved the new bulk-task case-picker overlay before its confirm-dialog assertions — see the R36 notes; count unchanged) |
| `tests/r8_rev.js` | 176 |
| `tests/r9_adv.js` | 169 (R33 re-scoped a `.case-details` reveal to `#modal .case-details` — see the R33 notes; R40 re-pointed R9-3(a) at the ⭐/`.review-score-chip` row inside `#case-events-list` in place of the deleted `#notes-list .note-review` — see the R40 notes; count unchanged) |
| `tests/r9_docs.js` | 255 (same R33 `#modal .case-details` re-scope; count unchanged) |
| `tests/r9_embed.js` | 104 |
| `tests/r11_ux.js` | 123 (R11-A adjacency asserts updated in R24 to skip R23's hidden `#dash-cap-notice`) |
| `tests/r12a.js` | 114 (D11's date-fragility fixed in R27 — see the R27 notes; count unchanged) |
| `tests/r12b.js` | 158 (date-fragile B1/B5 made deterministic in R17) |
| `tests/r13.js` | 142 |
| `tests/r14.js` | 167 |
| `tests/r15.js` | 160 |
| `tests/r16.js` | 83 (R33 re-scoped its `openCase()` details-opener to `#modal .case-details` — see the R33 notes; R35's own §A4 was intentionally inverted by the round's own affordability-never-vanishes change — see the R35 notes; count rose from 81) |
| `tests/r17.js` | 112 (same R33 `#modal .case-details` re-scope; count unchanged) |
| `tests/r18.js` | 43 (same R33 `#modal .case-details` re-scope; R34 pinned `#board-adviser` to "all" before its board-cap seed of unassigned cases — see the R34 notes; count unchanged) |
| `tests/r19.js` | 39 (unchanged count — R20 fixed HOW one row is queried, not what it asserts) |
| `tests/r20.js` | 81 |
| `tests/r23.js` | 76 |
| `tests/r24.js` | 89 (R34 pinned `#board-adviser` to "all" before §C's p3-assigned kitchen-sink seed, viewed as p2 — see the R34 notes; R37 re-pointed D4/D5/E4 at the board's `email`-widened clients embed — see the R37 notes; count unchanged) |
| `tests/r25.js` | 45 |
| `tests/r26.js` | 38 (R28 updated the basis/scoping assertions and added 2 new checks — see the R28 notes) |
| `tests/r27.js` | 43 |
| `tests/r29_scale.js` | 106 |
| `tests/r30.js` | 40 (R33 re-pointed §C/§D4/§E from Reports to Settings' `#diag-details` and added 3 assertions proving the wrapper itself gates correctly — see the R33 notes; count rose from 37) |
| `tests/r31.js` | 55 (R37 pre-seeds a present-but-empty `nx_views_v1` before B1/B2 so the new starter-views seeding doesn't fire ahead of their "starts from nothing" assertions — see the R37 notes; count unchanged) |
| `tests/r33.js` | 55 (R38 bumped A5c's 12→13 `data-page` buttons — the new Retention button in the Book group — see the R38 notes; R40 re-pointed C1b at `#case-events-list` in place of the deleted `#notes-list` — see the R40 notes; count unchanged, prose-only fixes) |
| `tests/r34.js` | 60 |
| `tests/r35.js` | 43 |
| `tests/r36.js` | 83 |
| `tests/r37.js` | 123 (new — §1–§12, see the R37 notes) |
| `tests/r38.js` | 95 (new — §A–§G, see the R38 notes) |
| `tests/r40.js` | 63 (new — §1–§7, see the R40 notes) |
| **Total** | **3,893** |

R40 notes: the unified client timeline moved into the case modal
(`admin/app.js`, commits `9ba8e4b` + CTO follow-up `09832e2`).

**`#notes-list` is gone.** The case modal's notes used to render in their own
list, painted by a now-deleted `noteRowHtml()`. They now render inside the
SAME shared timeline the client record has used since SP3b — `#case-events-list`,
built by `buildClientTimeline()` and painted by `renderTimelineList()` /
`timelineRowHtml()`, scoped to the one open case. `#tl-more`'s single
hardcoded id is gone too (the case modal can be open over the client record,
so two `.tl-more` buttons can exist on screen at once) — each caller now
wires its own by class, through its own container: `#tl-list .tl-more` on
the client record, `#case-events-list .tl-more` in the case modal.

**Eight sources, one of them new.** `buildClientTimeline()` already read
notes, sent/failed emails, sent/failed SMS, appointments (by `client_id`,
so a client-level appointment with no `case_id` still lands on the right
client), inbound client emails and fact-finds; R40 adds a ninth
client-record filter chip and an eighth builder source for completed
`case_tasks` (`done_at` truthy) → `cat:"task"`, icon ✅, title
`"Task done: {title}"` (escaped, same as every other free-text source here).
The client record's `#tl-filters` grew its 9th chip, `[data-cat="task"]`
("Tasks done"), deliberately left OUT of `CONTACT_TL_CATS` — ticking a task
off is work done ON the case, not a conversation, so it cannot freshen the
"Last contact" line (`tests/r40.js` §7).

**The case modal has its own, smaller filter set and cap.** `#case-tl-filters`
carries just two chips — "All" (default) and "Activity" — because inside one
case's own history the stage-change rows ARE the history, not cross-case
noise the client record needs to default away from. `CASE_TL_CAP = 30` past
rows before "Show more" (+100 from there), against the client record's 100.
Every row (both surfaces) now carries `data-case` — the case it belongs to,
or `""` for a client-level row — because the case modal has to answer
"which case is this row on?" without re-parsing a chip (`tests/r40.js` §1/§2).

**CTO fix (`09832e2`): the case modal strips the per-row case tag.** Every
row `buildClientTimeline()` builds carries a `caseChip`/`caseLabel` (the
`.tl-prop` property chip or the `.tl-case` kind·lender label); inside a
single case's own modal every row already belongs to the case the header
names, so `window.openCase()` maps the scoped `tlItems` to blank those two
fields before render — no `.tl-prop`, no `.tl-case`, anywhere inside
`#case-events-list`, address or no address. The client record's own
`#tl-list` is a different call site and is untouched — the same case's
property chip still renders there (`tests/r40.js` §1l/§1m/§1w).

**`eventTimelineHtml()`/`noteRowHtml()` are deleted outright** — the former
painted the case modal's old stage-only event list, the latter its old
notes list; both jobs are now done by the one shared builder/renderer pair.
Any `page.evaluate` calling either by name now throws — none of the
repaired suites did.

`tests/r40.js` covers: multi-source rendering (note/email/SMS/appointment/
fact-find/system stage-change/task-done) inside the case modal, `data-case`
population including the empty-string client-level case, another case's
appointment excluded while a null-case one is included, the two-chip
default/Activity toggle, the `CASE_TL_CAP=30`/Show-more cap, the composer's
in-place insert (visible under both chips, call-prefix → `data-cat="call"`,
no reopen needed), a re-file surviving a modal reopen (read back off the
mock db, not just the optimistic repaint), XSS escaping of a task title and
a note body (`0 <img>` nodes), the CTO chip/label strip vs. the client
record's unchanged `.tl-prop`, the client record's 9 chips/Tasks-done
filter/Upcoming block/100-row cap, and the completed-task-is-not-contact
rule.

R38 notes: a new Retention page, already-built and uncommitted before this
session started (`admin/app.js` + `admin/index.html` only — no schema, no
`admin.css` change beyond what already existed for `.seg-btn`/`.panel`/
`.row-item`).

**The page.** A 13th nav destination, `data-page="retention"` (🔁), added to
the BOOK group (Clients/Protection/Retention) rather than hidden inside the
collapsible Firm group R33 introduced — every staff role sees it without
opening anything, the same reasoning the Vault nav item already used. No
`PAGE_ROLE_GATE` entry, so it is reachable by every role and by hash
deep-link (`#retention`). `#page-retention` holds three panels behind ONE
scope control, `#ret-scope-mine`/`#ret-scope-all` (persisted
`localStorage.nx_ret_scope`), defaulting Mine for an adviser and All for
admin/owner — `retScopeResolved()`, the same pattern `wtScope`/`rateScope`/
`#board-adviser` already use.

**Shared-builder extraction, not a second implementation.** The three panels
are the SAME data the dashboard drawers already render, reached through
builders now shared rather than duplicated:
  - `#ret-rates-panel` reads `buildRateErcFeed()`/renders with
    `renderRateErcRow()` — the exact functions `loadDashboard()`'s Rate & ERC
    drawer now also calls (both were pulled out of what used to be
    drawer-only code). The page groups the SAME rows into "Ended" and
    "Ending soon" (`.ret-group-h`) and shows up to `RET_LIST_CAP` (100)
    rather than the drawer's 15 — un-truncated is the whole reason the page
    exists.
  - `#ret-pipeline-panel` reads `readRetentionPipeline()`/
    `retentionPipelineStats()`/`renderRetentionRows()` — again the same
    functions the dashboard's Retention drawer now shares, scoped by the
    retention CASE's own `assigned_to` (not the source case's — a hand-off
    via "assign to me" moves the pipeline row's ownership, and Mine has to
    follow that, not the client's original adviser).
  - `#ret-cold-panel` reads the Clients page's own cold segment, factored out
    as `coldClients()` = `clientHasAdviser()` + `clientInSegment(..,"cold")`
    over the existing `clientDataCached()` read — re-deriving "cold" here
    with a different query would give this panel and the Clients segment two
    different answers to the same question, which is the whole reason it
    isn't done that way. `#ret-cold-goto` hands off to Clients via
    `gotoClientSegment("cold", adviser)` — R38's one addition to that
    function (an optional `adviser` argument, defaulting to the pre-R38
    firm-wide behaviour) — so "work this list on Clients" keeps the page's
    own Mine/All choice instead of silently widening to the whole firm.

**One source of truth, said out loud.** Before this round the drawer's
15-row Rate & ERC slice and 12-row retention-pipeline slice were the ONLY
view of either list — an adviser with 20 rates ending inside the window
could not see the last 5 short of scrolling to the case list itself and
re-deriving them by hand, and "won/lost/conversion" existed nowhere outside
the drawer's own one-line summary. Pulling `buildRateErcFeed`/
`renderRateErcRow`/`readRetentionPipeline`/`retentionPipelineStats`/
`renderRetentionRows`/`coldClients` out from under the drawers and sharing
them with the page means the drawer and the page can never quietly disagree
about which alerts count, whose they are, or what a row looks like — the
page's h3 badges and the drawer's report the SAME scoped count for the SAME
scope, proven in `tests/r38.js` §C2. The drawers themselves are otherwise
UNCHANGED (same 15/12 caps, same rows) — each only gained a link to the new
page: the Rate & ERC drawer's header grew `#rate-erc-open-retention`
(`.ret-page-link`), and both drawers' "…and N more" overflow tails now read
"…see the Retention page" instead of dead-ending on a number with nowhere to
go.

**`smoke.js`.** Already updated by the build agent before this session
started (144 → 152 checks — the new page, its default-scope render for each
persona, and its row counts) and needed no further change from this pass.

**The one non-masking repair.** `tests/r33.js` A5c ("owner: `#topnav` still
has all 12 `data-page` buttons") and its surrounding prose (the §A summary
and the A5 `console.log` header) now say 13, because R38 genuinely added a
13th nav button to the group R33's own suite is proving the SHAPE of (every
`data-page` button lives inside `#topnav`, none orphaned by the grouping
machinery). The assertion's PURPOSE — that the sidebar regrouping never
drops or duplicates a nav destination — is unchanged; only the true count
of destinations changed under it, exactly the same class of fix R30/R31/R34/
R37 each made to a pre-existing suite whose own ground truth a later round's
product change moved out from under it (see those notes above). 55/0, count
unchanged (a prose/expected-value fix, not a new assertion). No other
pre-existing suite needed any repair — grepped for `12` alongside
`data-page`/`button`/`nav` across the whole `tests/` tree and `r33.js` was
the only hit; every other suite either doesn't count nav buttons at all or
counts a different, unaffected set (e.g. `r5_batch1.js`'s/`r5_batch8.js`'s
Firm-group-toggle clicks, already re-pointed for R33 itself and untouched by
where Retention sits).

**No product bug found.** `admin/app.js`/`admin/index.html` were not
modified for this pass — R38's product code (the page, the shared-builder
extraction, the drawers' links) was already built/uncommitted before this
session started, and every behaviour `tests/r38.js` set out to prove held on
first run: the scope default/persistence/clear-key-reverts cycle, the
Ended-before-Ending-soon grouping, the page/drawer count parity, the sort
toggle, `startRetentionCase()` repainting the page it was pressed from, the
pipeline stats matching the mock db independently, the cold segment's
last-contact ages matching `lastContactAgeLabel()` read live off the page,
and `gotoClientSegment`'s new adviser argument. Ran the WHOLE regression
battery (`smoke.js` through `tests/r37.js`) alongside the new suite; every
pre-existing suite other than `tests/r33.js` passed unedited at its exact
pre-R38 count (see the table above). `node smoke.js` alone: 152/0.

R37 notes: 12 polish items off the R32 panel, plus one CTO follow-up, all
already-built and uncommitted before this session started (`admin/app.js`/
`admin/index.html`/`admin/admin.css` only — no schema, no
`admin/mock-supabase.js` changes; `admin/mock.html` is smoke.js's own
regenerated copy).

  1. **K2 — doc deep-link.** `openCase(id, {scrollTo:"docs"})`: Data health's
     "Waiting on documents" row's Open button now opens the case scrolled (and,
     at completed/not_proceeding, expanded) onto `#modal #case-docs` — the
     block the row is ABOUT. `openCase(id)` with no second argument is
     unchanged, which matters because it is window-exposed and called from
     inline handlers and tests all over the app.
  2. **P-settings — Settings jump nav.** The same device Reports has had since
     R11-4 (`REPORT_JUMP_SECTIONS`/`buildReportsJumpNav`), applied to
     Settings: `#settings-jump` (built `hidden`) + `#settings-jump-chips` with
     `#settings-nav-<key>` chips. The chip list is READ off the rendered page
     at the end of `renderSettings()`, never declared, so a role only ever
     sees a chip for a section it genuinely has — an adviser is never offered
     a chip for a panel with no panel behind it. New anchors: `#set-sec-*` on
     the General/Advanced headings, plus `#introducers-panel`. A chip whose
     target sits inside a collapsed `<details>` opens every disclosure the
     target sits inside, outermost first, before scrolling.
  3. **P1-corrected — funnel scope labels.** Two funnels on Reports read as
     duplicates and are not: Pipeline MI's "Funnel & conversion" is a LIVE
     snapshot of the whole book by stage, unaffected by the month picker;
     "Pipeline funnel" further down is the selected month's COHORT (cases
     created that month). Both scopes are now said outright, with a pointer
     from each to the other — the Pipeline-MI-ward pointer on
     `#report-funnel-scope` only for admin/owner, since Pipeline MI is
     `isAdminOrOwner()`-gated and pointing an adviser at a panel they cannot
     see would be worse than saying nothing.
  4. **L7 — starter saved views.** R31 shipped the saved-views MECHANISM and
     an empty cupboard — both dropdowns read "Saved views…" and nothing else
     until somebody worked out the Save button captures the current filters.
     `seedStarterViews()` now seeds 1-3 views (role-appropriate names/adviser
     pinning) the FIRST time it is called with a known identity (`ME`) against
     a genuinely ABSENT `nx_views_v1` key — never against a present-but-empty
     one, which is exactly what a user who deleted every starter would be
     left holding, and re-seeding that would be the app arguing with them.
     Storage-blocked (throwing `getItem`) degrades to no seeding, the same way
     R31's save/delete already degrade to no-ops.
  5. **W9 — board duplicate hint (`.card-dupe-hint`), + the CTO follow-up.**
     Data health finds duplicate clients; the board — where an adviser
     actually works — gave no hint at all. A card now carries an amber
     "dupe?" badge when its client shares a normalised EMAIL or an exact
     sorted-tokens NAME key with another `client_id`, computed over the
     board's FULL read (never the filtered/searched one, so narrowing the
     board never hides a real duplicate). The CTO follow-up: the fixture's
     real duplicate pair (Debbie/Deborah Ashworth) share an EMAIL under
     different forenames, invisible to any name key — so the board's clients
     embed widened from `clients!client_id(first_name,last_name)` to
     `...(first_name,last_name,email)` to make the email signal possible at
     all. This is the one product change that reached across into another
     round's suite (`tests/r24.js`, which asserts that embed string verbatim
     — see the non-masking repair above).
  6. **W10 — protection commission capture, as an overlay.** R7-3 made a
     commission figure required for "policy taken" and implemented "required"
     as a `prompt()` in a three-try loop with no honest way to say "the policy
     IS taken and I don't know the number yet." It is now the app's own
     second-layer overlay (`openOverlay` — the same host the lost-reason and
     fee-date captures use): `#prot-comm-box`/`-input`/`-err`/`-save`/`-skip`/
     `-cancel`, prefilled from the case's existing commission or
     `settings.protection_avg_commission`. Save writes a number above zero;
     Skip writes the status with the commission column OMITTED from the patch
     (an existing figure survives — it is not overwritten with a guess or a
     null); Cancel/Escape/backdrop write nothing. Invalid input shows
     `#prot-comm-err` next to the box and the overlay stays open — no re-nag
     toast, no lost attempt. Both `setProtStatus` and `bulkSetProtStatus` call
     through it now (the bulk path's own confirm(), naming the count and
     whether a commission will be written, is unchanged — see the non-masking
     repair to `tests/r5_batch5.js` §S3c above).
  7. **W11 — appointment title quick-picks.** `#appt-title-chips` (5 titles
     this back office actually books) sit above the still-free-text `#appt-title`
     field. A click only WRITES the field and dispatches a real `input` event
     (so the unsaved-changes guard and the clash notice see it exactly as
     typing) — nothing is stored as a category, and "Ring Deborah back re: the
     survey" is exactly as valid a title as it always was.
  8. **K4 — vault login token (`.vault-user`).** Three "Test Bank A" vault
     entries share a name and differed only by a small owner pill; the one
     fact that actually told them apart (the login the entry is FOR) was four
     lines down inside the fields block. `vaultUserToken()` lifts it into the
     card's title row — but ONLY from a field the entry itself marked
     non-secret, and prints no value `vaultFieldHtml` would not already print
     in plain form. The three rows now read daniel.p / luke.r / wayne.k.
  9. **K5 — one canonical stuck-emails warning, not three.** Today's banner,
     Data health, and the Emails page were all independently arguing the same
     fact. Today (most-seen, first place anyone would find out) keeps the
     full sentence; Emails (where it's actually fixed) keeps everything; Data
     health now keeps only a POINTER — `#dh-stuck-notice` (one line, the
     count + live/not-live verdict) + `#dh-stuck-link` → `dhGotoEmails(false)`.
     The id, container and click-through are unchanged, so nothing that
     looked for `#dh-stuck-notice` lost it — it just says less.
 10. **L10 — rate-end sort tail.** The "(+N more)" tail already existed
     inside "Rate ends YYYY" segments; the plain "Next rate end" SORT view had
     no count at all, because `clientNextRateEnd` always returned `n: 0`. It
     now counts properly and the same `.client-rateend-more` tail renders
     there too ("(+N more)", no year qualifier — the population being counted
     is "rate ends still ahead", not "rate ends in this year").
 11. **P3 — admin sees per-adviser targets, read-only.** Admin already reads
     the scoreboard these targets feed (the Target column, the over/under)
     with no way to look up what a target actually WAS. `renderAdviserTargetsEditor`
     now also renders for `MY_ROLE === "admin"`, every `.adv-target-input`
     disabled, an `#adviser-targets-readonly` lock note in place of the Save
     button. Owner's view is untouched (editable + Save); an adviser still
     gets no section at all — `tests/r26.js` §F already proved that half and
     needed no edit (see the non-masking note above); `tests/r37.js` §11
     covers the admin half R26 never tested.
 12. **item 22 — admin money note.** `#report-money-note` already told an
     adviser which money panels are Owner-only; an admin's page simply
     stopped where those panels begin, with nothing saying the stop was
     deliberate. The sentence now grows one admin-only clause naming exactly
     which panels are Owner-only and pointing at the Pipeline MI run-rate as
     "the admin view of the firm's money." Owner sees no note at all
     (unchanged); adviser sees the pre-R37 base note with no admin clause
     (unchanged) — the clause is appended only when `MY_ROLE === "admin"`.

R36 notes: three parallel, already-built, uncommitted branches merged into one
round (`admin/app.js`/`admin/admin.css` only — `admin/index.html` gained
exactly one input, `#prot-search`, for build A; no schema, no
`admin/mock-supabase.js` changes anywhere in the round).

  - **A — protection on the client record + client-row extras + protection
    search.** Every case row on a client's drawer (grouped or not) now carries
    a `.cl-prot-chip` (`data-prot="<status>"`, grey None/Declined, amber
    Discussed/Quoted, green Policy) reading straight off `protection_status` —
    nowhere on the client record answered "is any of this protected?" before.
    The client LIST gained `.client-prop-n` (a grey "N properties" badge,
    shown only when a client's cases sit on more than one distinct building,
    fed by a `propAddrSupported()`-gated `,property_address` widening of the
    clients embed) and `.client-lc-age` (a muted last-contact age on EVERY
    row, from the existing 210-day comms window) — the Cold segment keeps its
    own richer "last contact 12 Mar (note)" line instead, never both on one
    row. The Protection page gained `#prot-search` (debounced 250ms, same
    contract as `#board-search`): it composes scope → search → status, the
    KPI tiles re-read against it, and the empty state names the term when a
    search produced it.
  - **B — searchable client/referrer/appointment pickers + a slim new-case
    form.** `upgradeSelectToCombobox` progressively enhances
    `#case-client-select`, `#case-referrer-select` and `#appt-client`: the
    native `<select>` stays in the DOM (hidden, `.combo-native`) as the real
    value carrier — every `.value` read, every `change` listener and FormData
    itself are untouched — while a `.combo-input` + `.combo-list` sit beside
    it, filtering by token-AND across the option's whole text (so a FIRST name
    finds a "Last, First" option, which a native select's own type-ahead never
    could), with pinned sentinels (`__new__` "+ New client…") that survive a
    zero-match search. The NEW-case form is now a `.case-core-grid` (client,
    property, kind, stage, assigned-to) above the fold, with the other ~39
    fields folded into the SAME `<details class="case-details">` accordion the
    EDIT form has always used — one `<form id="case-form">` throughout, so an
    unopened accordion still writes its markup's defaults on save. The EDIT
    form is byte-identical to before: no `.case-core-grid`, everything in the
    accordion.
  - **C — bulk-task property picker for multi-case clients.** `clientTaskTarget`'s
    `many_live` refusal now carries the live cases it refused to choose between
    (`{why:"many_live", choices}`) instead of only naming the refusal. The bulk
    "＋ Add task…" flow resolves this BEFORE the confirm dialog: one
    `.bulk-task-case-pick` select per ambiguous client in `#btaskc-pick-rows`
    (their own live cases, property · lender · stage, plus "Skip this one"),
    `#btaskc-pick-ok` disabled until every select has a value, and
    `#btaskc-pick-cancel`/Escape aborts the WHOLE batch — nothing is written.
    An unambiguous-only selection never sees the overlay. Chosen clients join
    the SAME target list and write loop as single-case clients, and a new
    title-dedupe (matched by `playbookTitleKey` against each target case's OPEN
    tasks) means running the same batch twice adds nothing the second time —
    "N already had that task open".

`tests/r36.js` (83 checks, §A–§D) seeds every client/case it needs directly
against `window.__mockDb`, exactly like `tests/r35.js`/`r34.js` before it —
never relying on the fixture's current, shifting composition. §A1 forces the
GROUPED drawer render path on purpose (two cases sharing one property among
three) so the chip assertion covers `clientCaseRowHtml`'s `opts.grouped`
branch, not just the flat one. §C mirrors real user gestures throughout
(clicking the actual `.bulk-task-case-pick` select, the actual
`#btaskc-pick-ok`/`#btaskc-pick-cancel` buttons, actual Escape) rather than
writing to the mock db directly, because the thing under test IS the overlay
sequencing.

One genuine, NON-MASKING fix to a pre-existing suite: `tests/r8_touch.js`'s
R8-2 bulk-task block (§3, the block that proves a many_live client is REFUSED
a task rather than guessed at) selects, among others, two `many_live` clients
and then goes straight from clicking `#client-bulk-task` to filling
`#btaskc-title` — which R36-C's new case-resolution overlay now intercepts:
that click no longer opens the confirm dialog directly when the selection
holds an ambiguous client, it opens `#btaskc-pick-rows` first. The fix adds
exactly one resolution step in between, driven the same way a real operator
would drive it: if `#btaskc-pick-rows` is present, set every
`.bulk-task-case-pick` to `"__skip"` (dispatching a real `change` so the
picker's own Continue-gating logic runs) and click `#btaskc-pick-ok`, THEN
continue into the confirm dialog exactly as before. `"__skip"` is not an
arbitrary choice: this block's whole point is that a many_live client is
skipped, not guessed at, and R36-C's picker offers precisely that as one of
its two paths — choosing it for every many_live row here preserves the exact
scenario the block was built to prove, so every downstream assertion (the
skip-count in the confirm dialog, `/several live cases/i` still matching the
picker's own — reworded but still true — "have several live cases and you
skipped them" copy, nothing landing on a many_live client's cases, the toast,
the "stays selected" check) holds unedited. No assertion was loosened,
deleted or had its target changed; the fix is purely the one new UI step R36-C
inserted into a flow the block already drove end-to-end. 151/0 → 151/0 (same
count: nothing was added or removed, only the path between two existing steps
changed).

Ops note for whoever runs this battery next: `smoke.js` and every file in
`tests/` hardcode `REPO = "/root/nx"` and `PORT = 8099` — they are not meant to
be portable across checkouts, and this session's run confirmed that hardcoding
is still exactly right for this environment (no `REPO`/`PORT` edits were
needed anywhere in the R36 pass).

One environment-clock note, unrelated to any R36 code: a first full-battery
run landed squarely inside the 23:00–00:00 UTC hour, and `tests/r17.js`'s §D
(snooze arithmetic / "today" in the briefing) went red — 2 failures, then a
locator timeout crash on a re-run seconds later. This is the SAME pre-existing
harness artefact `admin/mock-supabase.js` already documents at its own `TODAY`
constant ("R12b flake fix" — `dateOnly()` reads the Node/browser process's own
local timezone, which during BST disagrees with `app.js`'s Europe/London
`localDateStr()` for exactly that one hour each day). Nothing in R36 touches
task snoozing, briefing or any date arithmetic, and `tests/r17.js` itself is
untouched. Re-run after 00:00 UTC: 112/0, clean — the count the table above
already carries. No file was edited to produce this; it was purely waiting out
the documented window.

R35 notes: a small, already-built, uncommitted round shipping a CASE IDENTITY
pack (`admin/app.js` only, no schema, no `admin/index.html`/`admin/mock-supabase.js`
changes) — every path already existed; this round only changes what they render.

  - **Board cards always show the case KIND.** The `.cd` line used to drop the
    kind the instant ANY chip rendered at all, so an addressed remortgage and
    the BTL beside it on the board read identically apart from the lender —
    the one fact separating a landlord's home remortgage from the BTL next to
    it vanished the moment the address chip appeared. The kind is now dropped
    ONLY when the chip itself already says it — the hollow no-address chip
    (`propChip`'s own `fallback` label, shown only when the client has more
    than one case and at least one of them carries a real address) — every
    addressed card's `.cd` is `kind · lender`.
  - **Same-property live twins get a stage tail.** Two LIVE (non-terminal)
    cases for the same `client_id` + `propKey`, on a card that carries a real
    address chip, get ` <span class="case-tag">Stage label</span>` appended to
    `.cd` — Duncan Armitage's Application/Offer pair on 4 Seafield Gardens
    (the app's own worked example in the source comment) is the canonical
    case. Off entirely on a solo card, on a hollow (no-address) chip, or once
    a twin completes and the count falls back to one.
  - **BTL affordability never silently vanishes.** `#cs-btl-icr` used to
    require `btlIcr(c)`, which is `null` until a rent is captured — so the one
    BTL case where affordability is genuinely UNKNOWN (arguably the case most
    worth flagging, since it is the one most likely to get sent to a lender
    that will refuse it) rendered nothing at all, indistinguishable from "not
    a BTL". The row is now drawn for EVERY `buy_to_let` case: the existing ICR
    chip when there is a rent, an amber "Rent — not captured" badge plus a
    `#cs-btl-add-rent` button (same gesture as the expected-completion nudge —
    opens `#modal .case-details`, focuses `[name=monthly_rent]`) when there is
    not. Non-BTL cases are unchanged: still no row at all.
  - **Retention self-nag stops.** Starting a retention case copies the
    source's `rate_end_date` onto the new live successor, which is right — but
    the successor was then itself a case with a rate end in the past, so the
    Rate & ERC drawer grew a SECOND "rate ended N days ago" row for the same
    client/building/mortgage: one for the completed source and one for the
    live case that already IS the answer to it. A live successor
    (`retention_source_case_id` set, stage not terminal) is now excluded from
    the feed's own sets before the list, the heading's scoped counts and the
    tooltip's firm-wide figures are built, so none of them can disagree. The
    SOURCE row is untouched — it is what still carries "Start retention case"
    and the 🔁 badge.
  - **The modal grows a move-to-any-stage control.** `#cs-stage-select`
    (class `card-stage-move`, same shape and same options as the board card's
    own per-card select) sits beside `#cs-advance-btn`, all 8 STAGES with the
    current one selected; its `onchange` routes through the SAME
    `moveCaseToStage` single path as Advance, the board's drag-and-drop and
    the board card's own select — the protection gate, the lost-reason
    capture and the reopen/complete confirms all still apply, because there is
    only ever the one write path. `#case-mark-np` ("🚫 Mark not proceeding")
    is new in the More-actions overflow at every stage except not_proceeding
    itself (where "Record reason" already does that job) — a confirm names
    the consequence, then the same lost-reason capture Not Proceeding has
    always required.

`tests/r35.js` (43 checks, §A–§F) seeds/reads every fixture it needs directly
against `window.__mockDb` (never relying on the shifting fixture's current
composition) except §B's twin pair, which reuses Duncan Armitage's own
fixture cases — the round's own source comment cites them as the worked
example, and they are a live Application/Offer pair on one property that
needs no seeding to demonstrate. §B's "complete one twin, then look again"
step does NOT call `page.reload()` — a real reload rebuilds the mock db's
whole in-memory fixture from scratch (see "What this is" above), which would
silently undo the very update the check depends on. It re-navigates to the
same page instead (`window.nav("pipeline")`, called again): `nav()`
unconditionally re-runs the destination page's loader even when already on
it, which is the "come back and look again" the check needs without the
reset.

One genuine, NON-MASKING fix to a pre-existing suite: `tests/r16.js` §A4
asserted that `#cs-btl-icr` is entirely ABSENT for a BTL case with no rent —
true before this round, and exactly the behaviour R35 §3 deliberately
inverted (see above). The fix does not loosen or delete the assertion; it
replaces the absence-check with three new ones proving the STRONGER
replacement behaviour: the row is present, it carries `.badge.amber` reading
"Rent — not captured", and it carries `#cs-btl-add-rent`. A3 (the
rent-present ICR chip) is untouched, because R35 did not touch that path.
81/0 → 83/0.

One deliberate strengthening, not a fix: `tests/r5_batch3.js`'s existing
"Start retention case" flow (driven from a live Rate & ERC row, same as
before) now asserts — right after the button-gone check, using the successor
id the block already resolved — that the re-rendered drawer shows exactly
ONE row for Kwame Boateng (the source; unchanged) and that the successor's
own case id never appears in it. This is the R35 §4 behaviour exercised
through the real UI flow rather than a direct seed, complementing
`tests/r35.js` §D's independent (seeded, not button-driven) coverage of the
same rule. 66/0 → 68/0.

Every OTHER pre-existing suite (`smoke.js` through `tests/r34.js`, minus the
two above) re-ran unedited at its exact pre-R35 count — grepped for
`#cs-btl-icr`, `case-tag`, `cs-stage-select` and `case-mark-np` and none of
the others touch any of them. `admin/mock-supabase.js` was not touched by
this test-writing pass (R35's product code was already built/uncommitted
before this session started, and no fixture needed changing to exercise it).

R34 notes: a small, already-built, uncommitted round shipping an adviser
SCOPING pack (`admin/app.js` + `admin/index.html` only, no schema).

  - **Watchtower Mine/All scope.** `#wt-scope-mine`/`#wt-scope-all` seg-btns
    in the Watchtower header, the same shape the Tasks and Rate & ERC drawers
    already carry. Default is a role judgement — Mine for an adviser (p2/p3),
    All for admin/owner (p1/p4) — beaten in both directions by a stored
    `localStorage nx_wt_scope` ("mine"/"all"). Scoping is by the ALERT's
    CASE's adviser (`wtLast.assignedBy`, one bounded `cases` read keyed on
    the case ids already in hand — costs nothing extra per chip click or
    scope flip, both of which re-filter what is already in memory). The one
    carve-out: an alert with NO case behind it (`workload`, `retention_gap`,
    `fee_aging_60`, a slow `lead_slow`) is a firm-level fact, shown to
    admin/owner in BOTH scopes and to an adviser in NEITHER — flipping an
    adviser to All must not hand them somebody else's firm-wide to-do list.
    Chips, the panel's own count, and `autoDrawer`'s auto-open all read off
    the same scoped list, so none of them can disagree with what is on
    screen.
  - **Board/diary default-to-me + persist.** `#board-adviser`
    (`nx_board_adviser`) and `#diary-staff` (`nx_diary_staff`) now open on: a
    stored VALID value if one exists (a leaver's id silently falls through
    rather than leaving the select on a value nothing matches); else the
    signed-in adviser's own id for p2/p3; else "all" for admin/owner. The
    default itself writes nothing — only a real choice persists — so
    clearing the key genuinely restores the role default. Wired into R31's
    saved-view apply on the board too: a view that pins the adviser filter
    is a choice like any other and now re-persists the moment it is applied.
  - **Drawer persistence.** `toggleDrawer` now writes `nx_drawer_<key>`
    ("open"/"closed") for every dashboard drawer (watchtower/unactioned/
    leads/todayappts/tasks/rateerc/retention/revenue — the "-panel" id
    convention has two exceptions, `todayappts`→`#today-appts-panel` and
    `rateerc`→`#rate-erc-panel`, both accounted for). `applyStoredDrawers()`
    runs at the very top of `loadDashboard`, before any loader can call
    `autoDrawer`, so a restored drawer is never briefly re-collapsed on the
    way past; a stored preference now outranks the auto-open/auto-close
    heuristic permanently rather than just for the session that set it.
  - **Synthetic adviser data-health rows.** Two rules computed client-side,
    purely additive, from an adviser's OWN book (never shown to admin/owner,
    who already have the firm-wide Data health page): `my_missing_email`
    (warn — a live case whose client has no email on file) and
    `my_no_rateend` (info — a completed case with no rate_end_date),
    de-duplicated against whatever `run_watchtower` already returned on the
    same rule+case identity. Rows carry `data-wt-synth="<rule>"` and class
    `wt-row-mine`, are Open-only (no Snooze/Dismiss — there is no
    `watch_alerts` row behind them to snooze or dismiss), and cap at 8 with
    a tail "…and N more" row linking to Data health.

`tests/r34.js` (60 checks: §A watchtower scope 17, §B synthetic rows 13, §C
board/diary defaults 18, §D drawer persistence 12) covers all of the above on
fresh, isolated pages per persona/section, seeding its own cases/clients
straight into `window.__mockDb` (never depending on the fixture's current
composition, per the Standing rules) for the synthetic-row and board-cap
scenarios.

Two pre-existing suites needed a genuine, non-masking fix, both the SAME root
cause: `#board-adviser` no longer opens on "all" for an adviser, and both
suites seed cases that are deliberately NOT the viewing adviser's own (to
prove something about rendering/caps that has nothing to do with who owns the
case) — so the new default silently hid the very rows each suite went on to
assert against. Both are fixed by pinning `#board-adviser` to "all" with a
real `selectOption` right after the page's own board load, before the
assertions that need every row visible — the mechanism each suite was
actually written to test is untouched:
  - `tests/r18.js` §B seeds 55 `assigned_to: null` cases to prove the board
    column's render CAP (50) against its TRUE total (header count); as p2,
    the new adviser default filtered them all out, so the header read the
    baseline (1) instead of 56, and the next assertion's `.board-show-more`
    lookup then threw outright (an uncaught rejection, never reaching a final
    tally) rather than reporting a clean red. 43/0 after the fix.
  - `tests/r24.js` §C seeds one `assigned_to: "p3"` kitchen-sink case and
    opens it AS p2, specifically to prove the board/table render every field
    correctly regardless of who is looking — the new p2-own-id default hid
    a p3-owned card from a p2-scoped board entirely, and everything gated
    behind "is the card/row actually there" (19 further C-block assertions)
    never ran either: 68/2 (70 executed of 89) → 89/0 after the fix.

A third fix, in `tests/r5_batch9.js`, is the SAME root cause reaching a
PRE-condition rather than an assertion: R34 also changed the plain default —
an adviser's diary now opens on their OWN id in Month view too, not just Day
— but `r5_batch9`'s "Month's own adviser selection ('all'/Everyone) is
restored, untouched by Day's default" check exists to prove a DIFFERENT
mechanism (that Month and Day each keep their own remembered selection when
you flip between them), which only means something if Month actually starts
on something other than Day's default. The fix pre-seeds
`localStorage.nx_diary_staff = "all"` before that scenario, restoring the
exact starting condition the check was written to assume, rather than
weakening what it asserts — the alternative (asserting `"p2"` instead of
`"all"`) would have quietly stopped testing the Month/Day memory mechanism
altogether, since both views would then trivially agree. 26/1 → 27/0 (same
27 the R27 fix already left it at; this pass changed a precondition, not the
check count).

LOCALSTORAGE KEYS a test must clear before exercising any of the above:
`nx_wt_scope`, `nx_board_adviser`, `nx_diary_staff`, and one `nx_drawer_<key>`
per drawer key (watchtower/unactioned/leads/todayappts/tasks/rateerc/
retention/revenue) — `tests/r34.js` clears all of them (plus `nx_views_v1`,
since §C's saved-view test touches it) at the top of every block that needs a
clean slate, the same per-block convention `tests/r33.js` uses for
`nx_nav_firm`/`nx_import_blurb`.

`admin/app.js`/`admin/index.html` were not touched by this test-writing pass
(R34's product code was already built/uncommitted before this session
started) — no product bug was found; the two pre-existing-suite fixes above
are fixture/assertion adjustments in the TEST files only.

R33 notes: a small, already-built, uncommitted round shipping a role-aware
GROUPED sidebar plus five small, independent quick wins (`admin/app.js` +
`admin/index.html` + `admin/admin.css` only, no schema).

  - **Sidebar regroup.** `#topnav` gained `.nav-group-head` labels
    (Work/Book/Money) and a collapsible "Firm" group (`#nav-firm-group`:
    Emails/Import/Data health/Settings, toggled by `#nav-firm-toggle`,
    `aria-expanded`). The default state is a ROLE judgement computed once at
    sign-in (`applyNavRole()`, app.js ~L4103): collapsed for an adviser
    (p2/p3), expanded for admin/owner (p1/p4) — unless `localStorage
    nx_nav_firm` ("open"/"closed") already holds an answer, which beats the
    role default in both directions the moment the operator has touched the
    toggle. `nav(page)` (app.js ~L4374) additionally auto-expands the group
    — without writing to `nx_nav_firm` — whenever it lands on a page inside
    it (a command-palette jump, a deep link, `gotoDataHealth()`), so the
    active tab is never hidden behind a folded group; this expansion does
    not survive a reload once the operator has navigated off that page.
    `smoke.js` needed one accommodation (expand `#nav-firm-group` before
    driving pages; page count still 144) which the build agent had already
    made — left as-is. All 12 `button[data-page]`s are unchanged and still
    live inside `#topnav`.
  - **Diagnostics relocation.** `#report-diag-section` (CSV/copy/clear/
    health, `#diag-error-table`, R30's `#diag-persist-table` +
    `#report-diag-persist-clear`) moved from Reports to a new
    `<details id="diag-details">` at the bottom of Settings, collapsed by
    default and hidden outright for an adviser (same `isAdminOrOwner()`
    gate it always had — `renderDiagnostics()`, app.js ~L18872). Called
    from `renderSettings()` with no Reports read behind it (`all == null`),
    so the "Records loaded" fragment is omitted rather than reported as a
    fake zero.
  - **Quick wins.** `#new-note` (case-modal note box) is now a `<textarea>`
    (Enter still submits). A new Settings field, `name="doc_chase_days"`
    ("Document chase interval"), finally lets an owner SET the number
    `docChaseDays()` already read (blank = the 3-day default). The import
    preview's four-hundred-word rules paragraph is now foldable
    (`#imp-review-blurb` / `#imp-blurb-toggle`, persisted via `localStorage
    nx_import_blurb`). `#diary-staff` and `#client-adviser`'s first option
    LABEL is now "All advisers" (matching `#board-adviser`, unchanged since
    R31) — the VALUE stays "all".

`tests/r33.js` (55 checks: §A sidebar/adviser 17, §A5 owner 5, §B
diagnostics 12, §C quick wins 21) covers all of the above on fresh, isolated pages per
persona/section, the same convention every suite in this harness uses. §A's
sharpest assertion is proving the auto-expand is genuinely NOT persisted:
naively reloading right after `window.nav('settings')` would always show the
group open again regardless of `nx_nav_firm`, because the reload itself
re-lands on the `#settings` hash and re-triggers the very same auto-expand —
so §A4e navigates AWAY to `#dashboard` first, THEN reloads, which is the only
way to isolate "was this remembered" from "did I just land somewhere that
auto-expands". §C2 proves the `doc_chase_days` round-trip through the actual
rendered prose (`#doc-chase-note`), not just the input's echoed value, since
that prose is where the blank-defaults-to-3 promise is user-visible.

Three pre-existing suites needed a genuine, non-masking re-point because the
UI they drive genuinely moved or is now selectively unreachable by a raw
click, not because anything they asserted stopped being true:

  - **`tests/r30.js` §C/§D4/§E** drove Diagnostics on Reports; it now lives
    on Settings inside a collapsed `<details>`. Fixed by navigating to
    `settings` instead of `reports` and opening the details
    (`document.getElementById("diag-details")?.setAttribute("open","")`)
    before reading `#diag-persist-table`/`#report-diag-section` — the exact
    accommodation the round brief specified. §E was rewritten to check
    `#diag-details` itself (hidden for p2, present+openable for p1/p4) IN
    ADDITION to the pre-existing `#report-diag-section` checks, which is why
    its count rose by 3 (37 → 40) rather than staying flat like the other
    two files — a real, additional assertion about the new wrapper's own
    gate, not a loosening of anything that was there before.
  - **`tests/r5_batch8.js`'s `gotoSettings()`** and **`tests/r5_batch1.js`'s
    p2 `[data-page="emails"]` click** both drove `#topnav` buttons that now
    sit inside the collapsed-by-default Firm group for an adviser (p2/p3) —
    a raw Playwright click on a `display:none` button times out. Both fixed
    by switching to `page.evaluate(() => window.nav("<page>"))`, the exact
    route the button's own click handler ends up calling (and which
    auto-expands the group when it lands on a page inside it), so it works
    for every persona unconditionally — not a weaker check, the same
    destination reached a different way. Neither file's check count moved
    (`r5_batch8.js` 42, `r5_batch1.js` 54).

One GENUINE PRODUCT BUG found and fixed, reported loudly per the round
brief — not test-only fragility:

  1. **`.case-details` selector collision breaking five real, user-facing
     "reveal the field that needs fixing" flows.** `#diag-details` (Settings'
     new diagnostics wrapper) carries the SAME `class="case-details
     settings-details"` the case-modal's own collapsible section and
     Settings' pre-existing General/Advanced sections already share (a
     class that exists purely to reuse `<details>` disclosure-triangle CSS,
     not to identify "the current case"). Settings' General/Advanced copies
     of this class were already latent — but harmless in practice, because
     `renderSettings()` only ever creates them once Settings has actually
     been visited in that session. `#diag-details` is different: it is
     STATIC markup in `index.html`, present in the DOM from initial page
     load regardless of navigation. The effect: `admin/app.js`'s own
     internal `$(".case-details")` — used at five call sites to force open
     the case modal's collapsible section right before pointing the
     operator at a field inside it (a blocked stage-move pending a
     protection status, a missing protection commission, the "Set expected
     completion" nudge, the "Discuss protection →" prompt, and
     `openCase({revealProtection|openDetails})` after applying a mortgage
     offer) — now resolves to `#diag-details` FIRST (it sits earlier in the
     DOM than the modal, which is injected later), leaving the ACTUAL
     field the operator was just told to go fix sitting collapsed and
     invisible. Confirmed with a standalone repro
     (`document.querySelector(".case-details")` resolves to `#diag-details`
     both before and after opening a case) before touching anything.
     Fixed by scoping all five call sites to `$("#modal .case-details")` —
     the exact pattern `admin/app.js`'s own `revealProtection` sibling code
     already used one line below one of them (`$("#modal .client-details")`
     at ~L13766), so this is bringing the other five in line with an
     existing, already-correct convention, not inventing a new one.
  2. **The SAME collision was silently masking a second, harness-only
     effect first**: it broke the *test* helper pattern six suites share —
     `document.querySelector(".case-details")`, used to force-open the
     modal's collapsed details drawer before driving fields inside it
     (documented in `tests/r13.js` as the origin of the pattern, which
     already scoped it to `#modal .case-details` and was therefore
     unaffected). `tests/r16.js`, `tests/r17.js`, `tests/r18.js`,
     `tests/r5_batch2.js` (3 call sites), `tests/r9_adv.js` and
     `tests/r9_docs.js` all used the unscoped form and went red running the
     full battery (always the same shape: a `selectOption`/`fill` timeout
     on a field that "exists" per `$eval` but is not actionable because the
     wrong `<details>` opened). Fixed the same way, in every file, restoring
     each test's own documented intent rather than loosening any assertion
     — re-run individually AND as part of the full battery afterward, all
     green at their exact pre-existing counts (r16 81, r17 112, r18 43,
     r5_batch2 112 as part of the 557 batch sum, r9_adv 169, r9_docs 255).
  3. **A second, smaller, related bug**: the round's own new "Document
     chase interval" prose used `settings.doc_chase_days ?? "3"` in three
     places (the Settings note, the Data Health "Waiting on documents"
     panel) to fall back to the 3-day default. `??` only falls back on
     `null`/`undefined` — but saving a BLANK input genuinely upserts
     `value: ""` (an empty string, not absent), so a firm that saved blank
     — exactly the documented, intended way to ask for the default — saw
     "Emails a client every&nbsp;&nbsp;days" (the number silently missing),
     not "every 3 days" as the round's own code comment promised. Confirmed
     with a standalone repro before and after. Fixed by reusing the
     existing `docChaseDays()` helper (`Number(x) || 3`, which already
     handled this correctly) at all three template sites instead of
     re-deriving the same fallback a third, subtly different way.

`tests/r33.js` §C2d's blank-save assertion (`/every 3 days/.test(noteBlank)`)
now exercises the FIXED behaviour directly — it would have failed against
the pre-fix code, and was written and verified against the bug before the
fix was applied, not backfilled to match whatever the code happened to do.

Ran the WHOLE regression battery (`smoke.js` through `tests/r31.js`)
alongside the new suite, twice — once to catch the two issues above, once
clean afterward. Final run: every suite green, `node smoke.js` alone
144/0, full battery 3,414/3,414 (table above), zero new console errors
anywhere. `admin/app.js` was modified for the two genuine product-bug fixes
above (the `#modal`-scoped `.case-details` selectors at five call sites, and
the three `docChaseDays()` template sites) — both minimal, precise,
non-masking fixes matching an existing in-file convention, not new
behaviour; `admin/index.html` and `admin/admin.css` were not touched.

R31 notes: a small, already-built, uncommitted round shipping THREE
independent features in `admin/app.js` + `admin/index.html` only (no schema,
no `admin/mock-supabase.js` change beyond what R31's own tests needed to
seed, which was nothing — every check rides the existing mock surface).

  - **A · main-nav accessibility.** `a.skip-link[href="#main"]` ("Skip to
    main content") is now the first element in `<body>`, off-screen
    (`left:-9999px`) until `:focus` brings it on-screen (`left:0`) via a
    small inline `<style>` block in `index.html` scoped to this feature; its
    click handler (app.js ~L4076) `preventDefault()`s the native fragment
    jump and calls `#main.focus()` directly. `<main id="main" tabindex="-1">`
    makes that focus call legal without adding `#main` to the normal Tab
    order. `#topnav` gained `aria-label="Main navigation"`. `nav()` (app.js
    ~L4312) now sets `aria-current="page"` on the active `#topnav
    button[data-page]` and strips it from every other one on every
    navigation — both the programmatic `nav()` path and the existing
    `#topnav` click-delegate route through the same function, so a raw
    button click keeps the attribute correct too.
  - **B · saved filter views**, Clients + Pipeline, `localStorage` key
    `nx_views_v1` (`{clients:[{name,filters}], pipeline:[{name,filters}]}`).
    Deliberately per-BROWSER only — no server row, no schema, never synced
    across devices/users. `savedViews`/`saveView`/`deleteView` (app.js
    ~L7396) wrap every store access so a disabled, quota-full or corrupt
    localStorage degrades to "no saved views" and can never throw. Pipeline's
    bar (`#board-views`/`#board-view-save`/`#board-view-del`) captures
    `#board-search`, `#board-adviser`, `pipelineSegment`, `stageTab`,
    `sortKey`, `sortDir`, `pipelineView`; Clients' bar
    (`#client-views`/`#client-view-save`/`#client-view-del`) captures
    `#client-search`, `clientAdviser`, `clientSegment`, `clientSort`. Save
    reads `window.prompt()`, delete reads `window.confirm()`; selecting a
    saved option restores every captured filter and re-renders.
  - **C · data-health readiness rollup**, `#dh-readiness` (app.js ~L21320),
    rendered above the tile row inside `#page-data` and rebuilt on every
    `loadDataHealth()`. Rolls up ONLY the page's genuine data-quality FAULT
    tiles (missing/invalid email/phone, live cases unassigned, completed
    with no fee/rate-end/completion date, missing milestone date, R27's
    dead-book/overdue) into one worst-first list, each row's real count
    read off the SAME arrays the tiles themselves already computed — no new
    data, no new query. It deliberately EXCLUDES the page's informational /
    Consumer-Duty care lists (shared addresses, waiting-on-documents,
    vulnerable, automation-suppressed) — those are not faults to "clear".
    Zero issues renders a plain "…looks clean… ✅" empty state instead of
    the list. Each row is wired via the SAME `wireTile`/`wireTileScroll`
    handler its tile already had (an inline `onclick` resolves
    `document.getElementById(<realTileId>)` and clicks it), so clicking a
    rollup row scrolls to, and — for tiles whose panel starts hidden — also
    expands, the exact same panel the tile itself opens.

`tests/r31.js` (55 checks) covers all three on fresh, isolated pages per
section (§A, §B1/§B2/§B3, §C), the same per-page-isolation convention every
suite in this harness uses. §A proves the skip-link is genuinely first in
tab order with one real `page.keyboard.press("Tab")` from a page where
nothing is focused yet (not merely "exists in the DOM somewhere early"),
checks its off-screen/on-screen CSS contract via `getComputedStyle`, proves
clicking it moves focus to `#main`, and proves `aria-current="page"` moves
between tabs — and only the active one carries it — across three separate
navigations (two via `window.nav()`, one via a raw `#topnav` button click,
proving both routes stay correct). §B1 (Pipeline, the full round-trip) sets
`#board-search` + `#board-adviser`, stubs `prompt`, saves, and checks BOTH
the new `#board-views` option AND the exact `localStorage.nx_views_v1` shape
(name + captured filters) — not just that *something* got written; then
changes the live filters away from the saved values, selects the saved view,
and proves both fields are RESTORED to the saved values, not merely that the
select's own value changed; then stubs `confirm`, deletes, and checks the
option AND the storage array are both empty. §B2 repeats a lighter version
on Clients (save → verify option + storage + one restore assertion → delete
→ verify both are empty). §B3 seeds `localStorage.nx_views_v1 = "not json"`,
reloads, and confirms zero new console errors and that both saved-view
selects still render (degrading to just their placeholder option, not a
crash). §C reads the rollup's existing structure off the fixture first
(headline total/checks-count math, worst-first ordering, every row's target
`tileId` resolving to a real element) with a headline-math fallback in place
of the (impractical-to-reach-live) empty state, then SEEDS — independent of
fixture composition, the same `window.__mockDb` insert technique
`tests/r25.js`/`tests/r27.js` use — enough freshly-unassigned live cases
(count computed from the fixture's own current worst count at runtime, so it
is always strictly larger, never a hardcoded guess) to prove "Live cases
unassigned" sorts to the very top after reload, plus one deliberately
malformed-email client so the click-to-expand assertion never depends on the
fixture already having one; the first seed batch sets `submitted_at` so it
trips ONLY the unassigned predicate and not R25's milestone-date one too
(the first draft of this suite caught exactly that double-count — see
below). §C's final assertion clicks the "Invalid email" row (a `wireTile`
tile, panel starts hidden) rather than "Live cases unassigned" (a
`wireTileScroll` tile, panel always rendered) specifically because only the
former can prove the "expands" half of "scrolls/expands its tile's panel";
a spied `Element.prototype.scrollIntoView` proves the "scrolls" half on the
same click.

One self-caught, self-fixed test bug during authoring, not a product bug:
the first draft's seeded unassigned cases left `submitted_at` null, which
also tripped R25's "Missing application/offer date" tile
(`dh-tile-milestone`) — since that tile's own baseline count in the fixture
happened to already be the run's largest, seeding N more onto both tiles
made `dh-tile-milestone` grow faster than the case actually being tested for
top-of-sort, and §C11 failed on this pre-existing tile's count, not R31's.
Fixed by setting `submitted_at` on the seeded rows so they trip only the
predicate under test — a real, precise, non-masking fix to the TEST's own
seed data, not a loosened assertion; `admin/app.js` was never in question.

No product bug found otherwise. `admin/app.js`, `admin/index.html` and
`admin/mock-supabase.js` were not modified for this pass — R31's product
code was already built/uncommitted before this session started. Ran the
WHOLE regression battery (`smoke.js` through `tests/r30.js`) alongside the
new suite; every pre-existing suite passed unedited at its exact pre-R31
count (see the table above). `node smoke.js` alone: 144/0.

R30 notes: a small, already-built, uncommitted round persisting a
SANITISED client-error fingerprint to a new `error_events` table, plus a
cross-session view in the owner/admin Diagnostics panel — no `index.html`
markup change beyond the pre-existing R21 Part C panel gaining an
"Across sessions (persisted)" sub-section (`#diag-persist-table`,
`#report-diag-persist-clear`) inside the same `#report-diag-section`.

  - **Table**: `error_events` — EXACTLY four sanitised columns beyond the
    key: `error_type` (the JS error CLASS name, parsed off the stack, never
    the message), `location` (code file:line/fn only), `page` (the base hash
    route, ids stripped), `role` (the staff role). No `message`, `stack`,
    `recordId`, `user`/`email` or `view` column exists on the table AT
    ALL — by construction, not by filtering — mirroring the in-memory
    `ERROR_LOG`'s richer shape (which keeps message/stack/recordId/user/view,
    session-only, never persisted, exactly as R21 Part A documented).
  - **Write path**: `logClientError` (app.js ~L42) fires the persist insert
    ONLY on a genuinely-NEW `ERROR_LOG` entry — the existing R21 de-dupe
    branch (identical message within `ERROR_DEDUPE_MS`=5s bumps `.count` and
    returns early) sits BEFORE the R30 persist block, so a repeat within the
    window adds zero new rows, not a second one. The insert is
    fire-and-forget with both `.then` handlers present (so it can never
    raise an `unhandledrejection` and recurse back into `logClientError`)
    and gated by `errorEventsOff` — a session-local flag that latches TRUE
    the first time the DB answers 42P01/42501/PGRST205/PGRST106, so an
    unsupported/denied table degrades to "keep logging in-memory, stop
    trying to persist" rather than a console-error storm on every
    subsequent client error.
  - **RLS (production intent, documented here since the mock doesn't model
    row-level security beyond `duplicate_dismissals`/`case_documents`/etc.'s
    explicit `writePolicy` blocks — `error_events` has none, so the mock
    allows any signed-in persona to read/write it at the DB layer, same as
    every other table with no bespoke policy)**: insert = any staff member
    (any authenticated admin app session logs its own errors); read/delete
    = owner/admin only. In this build that read/delete gate is enforced at
    the UI layer — `#report-diag-section` (and therefore
    `#diag-persist-table` inside it) is hidden for a plain adviser by the
    same `isAdminOrOwner()` check that already gates R21 Part C's session
    table and R19's Pipeline MI — exactly like every other owner/admin-only
    Reports panel in this codebase; §E of `tests/r30.js` confirms adviser
    (p2) never sees the section while admin (p1) and owner (p4) both do.
  - **Read/aggregate path**: `loadPersistedDiagnostics()` reads
    `error_type,location,page,role,created_at` (never more), groups by
    `error_type|location|page` into ×count + last-seen + the set of roles
    that hit it, and renders `#diag-persist-table`; any read failure
    (including the feature-gate's 42P01) degrades to a plain "Cross-session
    error log isn't enabled on this database." note — the function is
    written to NEVER throw and NEVER call `logClientError` (either would
    re-enter the error path). `#report-diag-persist-clear` deletes every row
    (`.gte("id", 0)` — delete needs a filter, so this is the "match
    everything" idiom) and re-renders.
  - **Feature-gate test hook**: `window.__setErrorEventsSupported(false)`
    (mock-supabase.js) makes every op on `error_events` answer with a
    PostgREST-shaped 42P01, exercising `errorEventsOff` end to end without
    faking a network failure.

`tests/r30.js` (37 checks) proves this on fresh, isolated pages per section
(each Playwright page load re-executes `mock-supabase.js` from scratch, so
`error_events` starts empty every time — the same per-page-isolation fact
R29's notes already establish). §A is the round's core: as owner (p4), with
`location.hash` set to `#case/ca001` immediately before the call, one error
is logged whose message AND stack deliberately contain an obviously-
sensitive string ("SECRET-CLIENT-NAME") and the case id ("ca001"). The
persisted row is read straight off `window.__mock.db.error_events` — the
mock's live in-memory table, not a `select()`-shaped copy — and asserted:
exactly one row; its keys are a SUBSET of
`{id,created_at,error_type,location,page,role}`; `error_type==="TypeError"`
(parsed off the stack, not the message); `location==="app.js:9"`;
`page==="case"` (the id stripped off the hash route); `role==="owner"`; and,
the crucial negative assertions, the row's `JSON.stringify`'d text contains
NEITHER the secret client name NOR the original message text NOR the case
id NOR the stack's own line:col — proving no client string reaches the
table, not merely that the expected four fields look right. §B proves the
de-dupe/persist interaction directly: two identical `logClientError` calls
within the 5s window leave `ERROR_LOG` at exactly one entry (`.count`
bumped to 2) and `error_events` at exactly one row, not two. §C seeds two
DISTINCT messages sharing one `error_type`/`location`/`page` (so the
in-memory de-dupe never fires — each persists its own row) and confirms
`#diag-persist-table` renders one aggregated ×2 row naming the role, then
that `#report-diag-persist-clear` empties both the DOM table and the
underlying `error_events` store. §D flips `__setErrorEventsSupported(false)`
and proves `logClientError` still doesn't throw, `window.__errorLog` still
grows, `error_events` stays empty, and the panel shows the "isn't enabled"
note — then restores the flag so it can't leak into a later suite sharing
the browser. §E is the audience check described above. §F (no new console
errors) is checked per-section throughout, the same `page.__err` convention
every suite in this harness uses.

No product bug found. `admin/app.js` and `admin/mock-supabase.js` were not
modified for this pass — R30's product code (the persist block +
`errorEventsOff` in `logClientError`, `loadPersistedDiagnostics`, the
`error_events` table + `errorEventsSupported` feature-gate +
`window.__setErrorEventsSupported`) was already built/uncommitted before
this session started, and the sanitisation guarantee held on first run: no
loosening, no masking, no test written around a gap. Ran the WHOLE
regression battery (`smoke.js` through `tests/r29_scale.js`) alongside the
new suite; every pre-existing suite passed unedited at its exact pre-R30
count (see the table above). `node smoke.js` alone: 144/0.

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
