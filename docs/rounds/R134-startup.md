# R134 — start-up reads together (26 Nov 2026)

Daniel asked for a performance review of the whole site (report: project doc `claude/performance-review-2026-11.md`), then said "go" to this first round.

**Measured live before the change** (one signed-in load of www.nexmoney.co.uk/admin, owner, tag r132, timing entries only): Today finished at 4.5 s. 1.40–3.02 s was nine calls one after another (`auth/user`, `my_role`, `session_ok`, `my_role` again, `settings`, `profiles` ×2, `staff_absences`, `get_staff_activity`); the book's three case pages then ran in series (561 + 307 + 135 ms).

## What changed (admin/app.js)
- `enterApp`: `my_role()` and `session_ok()` go out together; the decision reads them in the same order. `showApp(session, true)` skips its own `my_role()` only when enterApp has just asked; the MFA and recovery callers still ask.
- `showApp`: after the role gate, `loadSettings()`, the four team reads (`loadTeamReads()`) and, in real mode, `bookLoad()` are all requested at once, then consumed in the old order. `loadTeam(session, reads)` takes the started reads; its two other callers pass none and it starts them itself.
- `bookReadPages(table, mk)`: a full book read asks for as many pages as the last full read needed (row count kept in `localStorage` `nx_book_rows_<table>` — a number only), in parallel, then carries on page by page if the last was full. Rows kept once per id. No stored count → plain `readAll`, as before. Incremental syncs unchanged.
- `loadUnactioned`: the 90-day `case_notes` and `case_events` reads are paged with `readAll` (were unpaged — 41 rows today, would have been cut at 1,000 without a word).

## Not changed
- The role gate still runs first and nothing is read before it answers (test A3). Server-side rules are untouched.
- Today's own reads still wait for the book.
- Start-up order applies in both harness modes; the book warm-up is real mode only so seam suites keep their call order.

## Tests
`tests/r134_startup.js` (24): every database call is slowed 40 ms so "together" is distinguishable. 11 of the 24 fail against r132.

## To measure after merge
One more signed-in load, timing entries only, to compare with 4.5 s. Estimate before building: about 3 s.
