# FIXTURES — mock-supabase fixture manifest

What is in `admin/mock-supabase.js`'s in-memory fixture DB, and **why each thing is
there**, so a later session can tell a deliberate landmine from an accident.
Read `HARNESS.md` first — it covers how to run the battery and the standing rules
(chief among them: every fixture date is generated relative to "now" at page load,
so nothing here may be hardcoded in a test).

> **Provenance note (R8 session).** This file was rebuilt from the repo state at
> `origin/main` @ `1717caf`. The round-7 half of it (`§ R7`, written in the
> session that shipped the Money/SLA pack) is **not present in this sandbox** and
> is not on `origin/main` either: `*.md` is in `.gitignore`, so it was never
> committed and did not survive the sandbox it was written in. The same is true
> of `tests/r7_money.js` and `tests/r7_sla.js`, and of the R7 parity work on the
> mock itself — `admin/mock-supabase.js` on `origin/main` is still the round-6.4
> file. See § Harness state, below. The round-8 section is complete and current.

---

## § R8 — the client-touch round (this session)

Two production changes mirrored (migration **r8_m1**) and one fixture pass, all
inside `admin/mock-supabase.js`, plus a new sample import file.

### 1. Parity — `queue_comms_extras()` gains the annual review touch

A completed case gets **one call task** on the anniversary of its completion:

| Property | Value |
|---|---|
| Fires when | `settings.annual_review_enabled = 'on'` (seeded **off**) |
| Which cases | `stage = completed`, `completed_at` at least **12 months** old, and `completed_at`'s **MM-DD is today** |
| Title | `Annual review call — <client> (completed DD/MM/YYYY[, on <first address line>])` |
| Due | today |
| Assigned to | the case's `assigned_to` (null if the case has no adviser) |
| `created_by` | `null` — SECURITY DEFINER, the system wrote it, not whoever was signed in |
| Idempotency | skipped if a `case_tasks` row on that case whose title starts `Annual review call — ` was created in the **last 11 months** |
| Email | **none** — deliberately. A year on, the useful act is a phone call |
| Tally | the returned object gains `annual_review_tasks` |

Eleven months, not twelve, is the look-back on purpose: a run a day either side of
the anniversary can never double up, while **last year's** call (12 months old)
does not suppress this year's. The address in the title is the **first line only**
(`firstAddrLine()`, split on the first comma) and is gated on migration `m7`, so a
database without `cases.property_address` still gets a usable title.

Edge worth knowing: on **29 February** there is no anniversary in a non-leap year
(JS rolls the fixture date to 1 March), so the touch simply finds nothing that day —
the same thing production's date match does.

### 2. Parity — the review-request drip (max 5 a run)

The review-request block now queues **at most 5 per run**, **oldest `completed_at`
first**, and stamps `review_requested_at` on **only those 5**; the rest roll to the
next run. Rationale: a firm switching review requests on used to email its entire
back book in one evening.

**Naming discrepancy, deliberately resolved this way.** The round-8 brief places
this change in `queue_automated_emails()`. In this mock — and in the production
function this mock was built from — the review-request block lives in
`queue_comms_extras()`, which is where the cap has been implemented. The observable
behaviour is identical either way: `process-emails` calls both functions back to
back on every unscoped run, so an operator (and a test) sees "5 queued and stamped,
oldest first, remainder waiting" whichever function owns the block. If production
really did move the block between functions in r8_m1, the only thing that needs
changing here is which tally the counter is read from.

### 3. Fixtures

| Block | What is seeded | Why |
|---|---|---|
| **DOB coverage** | `HAS_DOB(i)` blanks every 5th and 5th+1 seeded client; **34 of 50 clients hold a DOB, 16 do not** (~68%) | The "Missing DOB" segment needs members, and a real book *is* full of holes — a DOB is captured on a fact-find, rarely on the phone call that opened the case |
| **Birthday today / tomorrow** | Ruby Sinclair's DOB is moved to **today**'s MM-DD, Duncan Armitage's to **tomorrow**'s (ages untouched — only the day moves) | So "today's birthdays" is provably not "everyone with a DOB", and the day boundary is a fixture, not something each test has to build |
| **Fixed DOBs** | Seven clients carry **absolute** dates of birth: James Whitfield, Priya Nadkarni, Sarah Ellingham, Owen Cadwallader, Nadia Hussain, Callum Brodie, Nigel Trewin | A CSV on disk cannot chase a NOW-relative DOB. Without this, "matched on name + DOB" would quietly degrade into "matched on name" |
| **Annual-review fodder** | Nathaniel Fearnley (completed **12 months ago today**), Marguerite Vasey (**24 months ago today**), Douglas Hearn (**11 months ago** — the control that must NOT fire). All three carry a `property_address` | The two anniversaries must produce a call task; the 11-month case must not, because today is not its anniversary |
| **Idempotency boundary** | Vasey's case also carries **last year's** annual-review call task, created 12 months ago and already done | 12 months is outside the 11-month look-back, so this year's call must still be written. That is the boundary that decides whether the touch is annual or one-off |
| **Review drip backlog** | Trimmed to exactly **8** eligible completions (email present, `review_requested_at` null, past the 14-day delay, not marketing-opted-out). Everything older is stamped as already asked, on the date it would have gone out | 8 > the cap of 5, so the cap is observable (a run queues 5, the next queues 3); and it drains in two runs, which is what keeps the Emails page's "nothing is waiting" state reachable and the firm-wide flush's promise honest |
| **Segment members** | Petra Winsloe (**no case at all**); Alfred Northcote (last contact **14 months** ago); Suki Farrant (last contact **8 months** ago, but her case moved 3 weeks ago, and her live case's protection status is `discussed` with no outcome); Gwen Halloran (last contact **5 months** ago — inside the line, must NOT read as cold) | Every client segment needs members, and the cold segment needs a *real* old date rather than only the degenerate "never contacted" case. Farrant is the point of the segment: a case moving through the pipeline is not the same thing as the client hearing from us |

**Segment counts after this pass** (43 → **50 clients**, 63 → **69 cases**). Counts
are as measured on 2026-08-01; the rate-year buckets in particular move with the
calendar, because every fixture rate-end is generated relative to "now":

| Segment | Members |
|---|---|
| No live case | 26 (one of them with no case at all) |
| No protection outcome | 14 |
| Rate ends *this year* / *+1* / *+2* | 11 / 9 / 14 |
| Missing DOB | 16 |
| Not contacted 6+ months | 9 — 4 never contacted, plus 5 with real dates (5, 8, 11, 12 and 14 months) |

**"Last contacted" is computed by the app, not stored.** `loadClientData()` in
`admin/app.js` derives it as the most recent of, per client:

* a **note** on any of their cases (`case_notes.created_at`);
* an email we **sent** them (`email_queue.status = 'sent'`, on `sent_at`) — a
  queued or failed row has not reached them, so it does not count;
* an **appointment that has already started** (`appointments.starts_at <= now`);
* a **task completed** on one of their cases (`case_tasks.done_at`).

A client with none of those at all counts as cold. The cutoff is
`CLIENT_SEG_CONTACT_MONTHS = 6` **calendar** months, not 183 days. Note what is
*not* in the definition: `cases.updated_at`, `clients.updated_at`, and anything
merely scheduled — which is exactly why Suki Farrant reads cold with a case that
moved three weeks ago.

### 4. `tests/fixtures/revolution_sample.csv`

A Stonebridge `client_data_export_V2`-shaped sample: **57 columns, 12 data rows**,
UK `DD/MM/YYYY` dates, money as bare decimals, `Y`/`N` flags, and the filler a real
export carries (case/client references, lender reference, LTV, reversion rate,
adviser FCA ref, network name, vulnerable-customer and consent flags, notes).

| Row | Client | What it is for |
|---|---|---|
| 1–6 | James Whitfield, Priya Nadkarni, Sarah Ellingham, Owen Cadwallader, Nadia Hussain, Callum Brodie | **Exact** matches on name **and** DOB against the fixture book (this is what the seven fixed DOBs exist for) |
| 7 | "Meera **Chandra**" | **Fuzzy** — surname variant of Meera Chandran, same email and phone. Her DOB in the file is *not* ours: a fuzzy row must be resolvable on the identity columns that do line up |
| 8 | Bruce Lindquist | **Fuzzy** — name matches, **email differs** (a work address), and the file supplies a DOB we do not hold (his fixture record has none) |
| 9 | Fergus Ballantyne | **Brand new** — not in the book. Carries a second applicant |
| 10 | Rowena Tasker-Hyde | **Brand new** — mid-case (Offer Issued, no completion date), vulnerable-customer flag set, a quoted comma inside `Notes` |
| 11 | Nigel Trewin | **Update conflict** — matches a client we hold, but shows `Initial Term Expiry Date = 31/03/2031`, **later** than the rate end on our case. Deliberately far in the future so it stays "newer" as the NOW-relative fixture dates drift |
| 12 | *(blank)* | **Garbage** — no name, `#N/A` in a date column, zeros in the money columns. The row a report tool leaves behind |

**The real export's headers will not be these.** The names above are plausible, not
authoritative — `client_data_export_V2` is described from the documented facts, not
from a copy of the file. Anything that consumes this must **map headers, not
positions**: match case-insensitively on normalised header text, accept synonyms
(`Surname`/`Last Name`, `Initial Term Expiry Date`/`Rate End Date`,
`Taken Protection`/`Protection Sold`), tolerate columns that are absent, and ignore
ones it does not recognise. `IMPORT_HEADER_MAP` in the mock is the existing
precedent for that shape.

Two standing caveats:

1. **The file is static; the fixtures are not.** Only the seven fixed DOBs and the
   client names are guaranteed to line up. Every other value (rate ends,
   completion dates, fee amounts) is a plausible invention and will not match the
   fixture case it names.
2. **No real client data**, here or anywhere in the harness — every name, address,
   email and reference in the file is synthetic (`example.com`, `SBM-…` references
   that belong to nothing).

### 5. Two fixture repairs the round-8 fixtures exposed

Both in `currentMonthCohort()`, both calendar bugs that only bit on the first days
of a month — which is what today happened to be:

1. `maxBack = Math.max(2, NOW.getDate() - 2)` back-dated the **current-month**
   cohort into the **previous** month on the 1st and 2nd, and left the reports
   page's default month with no applications at all (so every month-on-month
   comparison was against nothing). The cohort is now placed inside this month by
   construction, and the submitted stages get a `submitted_at` inside it too.
2. With no room to spread, every cohort row landed on the **same instant**, so
   (a) "one property, two cases at different times" stopped being true and
   `r5_batch2`'s M7 fixture assertion failed, and (b) rows tied with the ones the
   *app* inserts during a test (`applyInsertDefaults` stamps `iso(NOW)` too),
   which made "the three most recent cases" ambiguous and cost `r5_batch7` its
   import assertion. Rows now get their own instant and never land within a
   minute of `NOW`.

### 6. Test assertions this round legitimately shifted

Three, all in test files, all because the behaviour or the fixture shape genuinely
changed — no assertion was weakened to make a failure go away:

| Test | Was | Now | Why |
|---|---|---|---|
| `r5_batch1.js` · "the number consented to is the number sent" | Compared the accepted run's send count against the confirm shown by the **previous, cancelled** run | Reads the confirm from the run that was **accepted** | The drip queues 5 a run, so a second run legitimately creates the next five. The old comparison held only while one run queued the entire eligible book and the next queued nothing. The property under test is unchanged and now actually stated |
| `r5_batch6.js` · the three month-comparison scenarios | Hardcoded to *this month − 12* and *− 24*, on the assumption that the prior-year twin of the current month is empty | Derives the months from the fixture rows at run time | The annual-review fodder completes a case on today's date one and two years back — the point of it — so that month is not empty any anymore and never can be |
| `r5_batch6.js` · "computes a real fall" | Required an **empty** month whose twin held rows | Requires a month with **no completions** whose twin has some | Same property (a fall to zero is not "no data"), stated in a way that survives a book with rows in every recent month |

---

## § Harness state at the end of the R8 session

Recorded because it is not what the round-8 brief assumed:

* `admin/mock-supabase.js` on `origin/main` @ `1717caf` is the **round-6.4** mock.
  The round-7 parity pass on it (M8 protection-quote columns, the SLA stamps,
  process-emails v10) is **not in the repo** — it was done in a sandbox that is
  gone. The round-8 work in this file therefore sits on top of the 6.4 mock.
* `tests/r7_money.js` and `tests/r7_sla.js` **do not exist** in the repo. The
  battery that can actually be run here is `smoke.js` + `r5_batch1..9` + `r64`.
* `tests/r5_batch5.js` § S3c failed 5 checks at the **start** of this session
  (verified against a pristine checkout): R7-3 made the bulk "policy taken" flow
  ask for a commission figure *before* the confirm, and the test's dialog handler
  accepted that prompt with an empty string, which the app correctly treats as
  "cancel". It is green again as of the end of the session — `admin/app.js` was
  being edited concurrently by the round-8 UI work while this ran, so the fix
  came from there, not from anything in this pass.
* The battery total therefore reads **789** checks, not the 786 recorded in
  `HARNESS.md` (batch 5 executes 3 more checks now that the S3c flow completes,
  and batch 1 runs the same count against a repaired assertion). `HARNESS.md`'s
  counts table still says 786 @ `b78faaa` and was left alone — it is outside the
  edit scope of this pass.
* `tests/r8_touch.js` (149 checks — the round-8 UI suite, written concurrently
  with this fixture pass) runs **green against these fixtures**, including its
  R8-4 annual-review block. Full green total this session: **938** checks.
* Between **23:00 and 00:00 UTC** while the UK is on BST, two tests fail
  spuriously: the app computes dates in `Europe/London` (`localDateStr`) and the
  test files compute them in the container's UTC, so they disagree about what day
  it is for exactly one hour a day. Also verified against a pristine checkout.
