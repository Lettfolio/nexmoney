# R133 — tests that only passed on some dates

Daniel's "proceed", 24 Nov 2026, after two Diary tests went red on a calendar coincidence (r76_case §F on 19 Nov, r75_diary B3 on 24 Nov). Tests only; no change to the back office.

**Method.** `tests/tools/shift-date.js` runs a suite as if today were another day (it shifts the clock in Node and in every page). Twelve suites that book, click or read appointments were each run as if on ten future days: 25, 26, 27, 28 and 30 Nov, 1, 2, 3, 4 and 10 Dec 2026 — 120 runs.

**Found.** Two more would have failed on 26, 27 and 28 Nov:
- `r12a` D11 (clash notice) and `r12b` B5 (four appointments in a day) both pick a test day as `Math.min(27, today + N)`. Late in the month that is today itself or the day beside it, where the seed keeps today's own appointments and parks a displaced one.
- Both now go N days the *other* way in the second half of the month, so the day is always odd, in this month and at least eight days from today.

Re-run as if on 24, 26, 27, 28, 29 Nov and 1, 2, 15, 17 Dec: both pass.

**Clean on all ten days:** r75_diary, r76_case, r80_ledger, r78_hands, r41, r5_batch9, r104_agenda, r13, r72_admin, r125_diary.

**Not covered.** Ten sampled days, not every day of the year; month ends other than November's, leap day and the clock changes were not simulated. Suites that do not touch appointments were not run shifted.
