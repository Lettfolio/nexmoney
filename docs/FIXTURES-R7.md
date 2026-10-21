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

---

## § R9 — the document-chase and advocacy round (this session)

Two production migrations mirrored (**r9_m10**, **r9_m11**), two new edge
functions, three comms changes and one fixture pass — all inside
`admin/mock-supabase.js`. The production UI half (`admin/app.js`) was being
written in parallel in the same sandbox; nothing below depends on it having
landed, and the whole battery is green with it as it stood at the end of this
session.

### 1. Schema — migrations m10 and m11

| Toggle | What it adds | OFF behaves as |
|---|---|---|
| **m10** | table `case_documents` (`id, case_id, item, status, requested_at, received_at, note, storage_path, created_at`) **and** `cases.waiting_on`, `cases.solicitor_firm`, `cases.doc_token` | table → **42P01**, the three columns → **42703** on write and simply absent from a SELECT |
| **m11** | `cases.referrer_client_id` | column → **42703** / absent |

**One toggle covers the table and the three columns on purpose**: they shipped as
a single migration, so a database that has one has all four. Flipping them apart
would model a state that cannot exist. `referrer_client_id` gets its own toggle
because it is its own migration and `app.js` probes for it separately
(`referrerSupported()`), rendering no "Referred by" field at all without it.

`status` is a real check constraint (`requested` / `received` / `waived`, 23514
otherwise) and `item` is NOT NULL (23502). **`waived` is a first-class outcome,
not a delete**: a document we decided we did not need is a fact about the case,
and dropping the row would leave the checklist looking as though it was never
asked for. `case_documents` joins the **audited** set under the standing round-4
rule (every new table gets the trigger) and is **staff-only** on both read and
write — an introducer login sees nothing. The client's own view of the list does
not come through RLS at all; it comes through the edge function on the service
role, which is what makes a link usable without a login.

### 2. `doc-upload` — the only thing here a client without a login ever touches

`GET ?token=…` → the checklist; `POST {token, item, storage_path}` → one item has
arrived. Three properties the stub exists to make testable:

1. **A bad token is a 404, and always the same 404** — empty, invented, or
   belonging to a case since cleared. An error that distinguishes "no such link"
   from "not your link" is an oracle for guessing tokens. Without m10 there is no
   `doc_token` column at all, so every link 404s, which is what an un-migrated
   database would do.
2. **The GET leaks a first name and nothing else.** `{first_name, greeting,
   items[{id,item,status}], outstanding[], outstanding_count, complete}` — no
   surname, no email, no address, no case id, no adviser, no money. A document
   link gets forwarded and pasted into WhatsApp; everything it shows is
   effectively public. A first name is enough for the client to know the page is
   theirs and useless to anyone else.
3. **The POST writes the case note** — `Document received via upload link:
   <item>` — with `created_by = null`, because the service role wrote it, not a
   member of staff. A second upload of the same item replaces the file and does
   **not** write the note twice. An item that is not on that checklist is its own
   404; a POST with no item named is a 400.

The mock's `window.fetch` stub now parses the **query string** and passes
`{method, url, query}` as an optional second argument to a handler. Every
existing handler keeps its one-argument signature untouched.

### 3. `nps-capture` v2 — a detractor is the most urgent thing in the inbox

v1 recorded the score and stopped, which is the wrong way round: a 10 needs
nothing from anybody. v2 keeps the score and, for **6 or below**:

* writes the client's own words to the case **verbatim**, prefixed with the
  score — `Review feedback (<score>/10): <text>`. Verbatim on purpose: a summary
  of a complaint is a way of losing the complaint. Only when they actually typed
  something.
* puts a call task on the case's adviser — `Call <client> — review feedback needs
  attention` — **due tomorrow**. Not today (an unhappy client submitting at 23:40
  should not generate a task that is already overdue before anybody reads it) and
  not next week. The call happens whether or not they typed a reason; a bare 4
  still needs a phone call. Idempotent on the title, so a double submit creates
  one task.

**No email goes anywhere.** Nobody wants an automated reply to a complaint.

**The token is the only thing that resolves a case, and the guard runs before
any write** — corrected during the round-9 verification pass, where the stub was
found resolving by `case_id` first with no check that it matched the token. The
deployed function has always carried
`if (!kase || !kase.nps_token || kase.nps_token !== token) return 404` ahead of
every write, so production was never exposed; the mirror was wrong, which is a
worse failure than a strict stub refusing something real, because it makes the
harness silent on a property it appears to cover. What the stub now enforces,
each refusal returning before a single row is touched:

| Sent | Answer |
|---|---|
| `website` non-empty | `200 {ok:true}`, nothing written — the honeypot, checked first so the codes below cannot be probed |
| no token / empty token | **400** — a submission naming no link is malformed |
| unknown token | **404**, the same 404 an expired one gets |
| `case_id` ≠ the token's case | **404** — `case_id` is an assertion to be verified, never a lookup key |
| valid token, no `case_id` | **200** — the token alone is sufficient |

**The score is write-once**: `effective = stored ?? request`. A case that already
holds a score keeps it, so a number edited into the address bar can only ever
fill a blank — it cannot move a recorded score, and it cannot decide away the
call-back, because the band is read off the score the firm actually captured.
`tests/r9_docs.js` § **R9-8b** asserts the whole matrix, zero-writes included.
**No fixture seeds an `nps_token`**, so a feedback link has to be minted on the
case before it does anything.

### 4. Comms parity

**(a) `docs_request` is checklist-aware.** With a checklist on the case the mail
lists **only what is still missing**, plus the upload link where the case has a
token; with no checklist it falls back to the firm-wide `settings.docs_list` —
the v10 wording and the whole list, every time, word for word. A client who has
already sent their passport and is asked for it again reasonably concludes we
lost it. The composed object gains `checklist_source` (`"case"` / `"settings"` /
`null`), `checklist_items` and `docs_link`, so a test asserts the list a client
reads rather than a flag about it.

**(b) The nightly document chase** (`queueDocChases`, inside
`queue_comms_extras()`), tallied as `doc_chases_queued` / `doc_overdue_tasks`:

| Rule | Why it is that rule |
|---|---|
| Only `fact_find` / `application` | Before that there is nothing to collect; after it the lender has what it needs and a chase is noise |
| Only cases with a checklist that still has `requested` items | A case with no checklist is not "fully documented", it is *unknown* — and inventing a chase for an unknown is how a client gets asked for a passport they handed over in person |
| Quiet window `doc_chase_days` (**3**) over *any* document mail, request or chase | Stops the cron plus an operator pressing Run now becoming two chases in an evening |
| **Max 3 chases**, then an adviser task `Documents overdue — call <client>`, due today, on the case's adviser, `created_by = null` | The fourth email is not the one that works; a phone call might be. Idempotent on its own title, so a week of nightly runs leaves one task, not seven |
| The task is **not** subject to the quiet window | The window governs how often we mail a client; this is the point at which we stop mailing them |

Gated on a new setting **`doc_chase_enabled`, seeded `off`** — the same call
round 8 made for `annual_review_enabled`, for the same reason: chasing a client
is a decision a firm makes, not something a deploy starts doing to their book.
The tests turn it on themselves, which is also the only way to prove the switch
really is the gate.

**(c) The review reminder** (`queueReviewReminders`), tallied as
`review_reminders_queued`. One nudge, `review_reminder_days` (**7**) after a
review request that was actually **sent** and never answered.

* **Keyed on the `email_queue` row, not on `cases.review_requested_at`.** The
  stamp records that we decided to ask; the sent row records that the client was
  asked. Only the second is worth chasing — and it means a back book stamped as
  "already asked" during a migration is never nudged for a mail nobody received.
* **One reminder per case, ever.** The existence of a `review_reminder` row is
  the memory, so no new column was needed and a re-run cannot double up.
* **It shares the drip's five a run and takes what is left AFTER the new
  requests.** Someone who has never been asked comes before someone being asked
  twice. With the round-8 backlog of 8 this is directly observable, and it is
  what keeps every existing count in the battery still true:

| Run | requests | reminders |
|---|---|---|
| 1 | 5 | 0 (no budget left) |
| 2 | 3 | 2 |
| 3 | 0 | 0 |

Both tallies also come back on `process-emails`' `queued` object, along with the
doc-chase pair, so "what did the cron do last night" is answerable from one
object.

### 5. Fixtures — and a deliberate constraint on the whole pass

**This pass adds no clients and no cases.** Everything is written onto rows that
already exist. Round 8 learned that a fixture which changes what another block is
measuring is worse than no fixture at all, and every new completed case is a new
member of the review drip, a new row in every month's completions and possibly a
new watchtower alert. The new *columns* are invisible to all of that. The only
rows added anywhere are `case_documents` (a brand-new table), the document emails
those checklists imply, and the one note-and-task pair a detractor left behind.

Cases are selected **by client name and stage, never by id** — ids renumber the
moment anything above the block seeds one more row, and a fixture that silently
lands on a different case is the worst kind of harness bug.

#### (a) Four checklists — one per state the chase can be in

| Case | Items | Mails already sent | What must happen tonight |
|---|---|---|---|
| **Sarah Ellingham** · fact find · token `doc-ellingham-4f21c8` | 4: Photo ID + payslips **received** (both through the link), bank statements + proof of deposit **outstanding** | `docs_request` **yesterday** | **Nothing** — the control the quiet window exists for: outstanding items, no chase ever sent, and still nothing goes out, because we spoke to her yesterday |
| **Bethany Quirke** · application · token `doc-quirke-90b7ae` | 3, all outstanding | request −12d, chase −8d, chase −4d | **The third chase** — and the third is the last |
| **Rosalind Amery** · application · **no token** | 4: 3 outstanding + 1 **waived** (self-employed, SA302s asked for instead) | request −34d, chases −22d / −15d / −8d | **The task**, not a fourth email |
| **Tanya Osei** · fact find · token `doc-osei-2d64f0` | 3, all received | request −20d | **Nothing, ever again** |

The other **65 cases have no checklist at all** — the legacy majority the
checklist-aware template has to keep sending the old firm-wide list to.

Amery's case is deliberately the one **without** a `doc_token`: the upload link
is not the point of the feature, chasing is, and her mails prove the
checklist-aware template still lists the missing items when there is no link to
offer. Her waived payslips are why "three outstanding" and "four items" are both
true — anything counting outstanding work must count **status**, not rows.
Ellingham's two received items carry the two `Document received via upload link:`
notes the function writes, so the case reads as though the link had been used.

#### (b) Solicitors and waiting-on

Three firms across **27 completed cases**, nine each, assigned **by measured
submission→completion duration** — fastest third to Harker & Bligh, slowest to
Bexley Rowe:

| Firm | Cases | Avg days | Range |
|---|---|---|---|
| Harker & Bligh LLP | 9 | **38.1** | 28–44 |
| Trelawny Conveyancing | 9 | **51.7** | 46–56 |
| Bexley Rowe Solicitors | 9 | **63.9** | 62–71 |

Assigning by measured duration rather than naming firms at random and then moving
the dates is the whole reason this pass could exist at all: rewriting completion
dates would have moved a dozen other fixtures and every completions report.
Product transfers are left blank on purpose — nothing changes hands, so there was
no conveyancer. Blank means "there wasn't one", not "we forgot".

**`waiting_on` is on 18 of the 33 live cases** — 9 `client`, 5 `lender`,
4 `solicitor` — every case from Application onwards (before that there is nothing
outside the office to wait for), plus any live case that has not moved in 45+
days. **Every case that says it is waiting on a solicitor names one** (4 live
cases therefore carry a `solicitor_firm` as well): a "waiting on solicitor"
report whose rows cannot name the solicitor is a list of shrugs. Note what
`waiting_on` is **not** — it is not the stage. A case can sit at Application for
a month waiting on the *client*, and the useful question is "who do I ring", not
"what stage is it".

#### (c) Advocacy

**Referrers — three cases, two referrers, deliberately different shapes**,
because `app.js` has to decide *where* the thank-you task goes:

| Referred case | Referrer | Why this one |
|---|---|---|
| Amara Okonkwo · offer | **Meera Chandran** | She has exactly **one** case, so a thank-you lands on it with nothing to decide |
| Ian & Susan Fairweather · offer | **Meera Chandran** | …and she is therefore the referrer with **two** referrals, which is what gives a "who sends us business" list a top row |
| Ross McKay · fact find | **Gareth Pollard** | The landlord with five cases, three of them live. There is no right answer to which of his buy-to-lets a thank-you belongs on, so the app must decline to guess — and that path needs a fixture or it is never walked |

**The review loop — three states side by side**, because the reminder means
nothing unless all three exist:

| Case | State | Consequence |
|---|---|---|
| **Sophie Ravenhill** | asked **8 days ago**, never answered — the stamp *and* a `review_request` row with `status = sent` | the reminder is **due** |
| **Ian Corrigan** | answered **4/10** with a reason | note `Review feedback (4/10): …` + task `Call Ian Corrigan — review feedback needs attention` due **tomorrow**, `created_by = null` — exactly the state `nps-capture` v2 leaves behind, written into the fixtures so it is there on a **cold page load**, before anybody submits anything |
| Damian Fairhurst | answered **9/10** | nothing happens at all |

**A second case is reminder-eligible in the base fixtures, and that is left
alone deliberately**: Louise Garnham's review request (`ca017`) was sent 33 days
ago and never answered. It is the honest "nobody chased this one for a month"
case, it is what makes run 2 above queue **two** reminders rather than one, and
removing it would have meant inventing an arbitrary upper bound on how stale an
unanswered request may be.

**Review scores went from 6 to 12**, spanning **4 → 10**: `4, 6, 6, 6, 7, 8, 8,
9, 9, 10, 10, 10` — four detractors, three passives, five promoters. Six scores
that were all 6, 8 or 9 is the one shape a review dashboard can say nothing
about. Every new score is written onto a case that had **already been asked**
(`review_requested_at` set), so the review drip's waiting list is untouched.

### 6. Test assertions this round legitimately shifted

Two, both in one file, both the same hardcoded `6`, and both because the fixture
count genuinely moved. No assertion was weakened.

| Test | Was | Now | Why |
|---|---|---|---|
| `r5_batch6.js` · "fixture · six cases carry a review score" | `scored.length === 6` | `scored.length === 12`, **and** that the twelve span detractors, passives and promoters | The advocacy fixtures took the scored book from 6 to 12 and gave it a real spread. Still asserted exactly, so silent drift still fails; what it has to be has moved — and the spread it now also states is the property the count was standing in for |
| `r5_batch6.js` · "S7 · the tile expands to every respondent" | `list.rows.length === 6` | `list.rows.length === scored.length` | "Every respondent appears" is a statement about the fixtures, not about the number six. Read off the fixtures at run time, per the standing rule in `HARNESS.md` |

The two were merged into one `ok(...)` and one `eq(...)`, so the battery total is
**unchanged at 1,104**.

### 7. Battery at the end of this session

| Suite | Checks |
|---|---|
| `smoke.js` | 144 |
| `tests/r5_batch1..9.js` | 554 |
| `tests/r64.js` | 91 |
| `tests/r8_touch.js` | 149 |
| `tests/r8_rev.js` | 166 |
| **Total** | **1,104 · 0 failures** |

Fixture counts after this pass (unchanged rows in bold — the point of §5):
**clients 50**, **cases 69**, case_tasks 37 → **38**, case_notes 118 → **121**,
email_queue 30 → **40**, settings 41 → **44**, case_documents **14** (new),
**watch_alerts 24**, **v_alerts 46**, **audit_log 318**.

`admin/app.js` was being edited in the same sandbox by the round-9 UI work while
this ran — at one point it carried a duplicate `const clientFullName`, which is a
parse error that takes the whole page down. If a run of the battery fails
everywhere at once, check `node --check admin/app.js` before suspecting anything
here.
