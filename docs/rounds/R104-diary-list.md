# R104 — Diary: a List view, and the default (review item B10)

Daniel ticked B10 in the UI/UX review on 14 Nov 2026.

## What changed
- **A fourth Diary view, "List"**, first in the toggle: the next 14 days as rows. Only days that hold
  something are shown (today always). Each day lists absences, tasks due, then appointments in time order
  (time, title, outcome, property, client, adviser when viewing everyone). A row opens the appointment.
  Prev / Next step 14 days; Today returns to today. Same read as the other views (`loadDiaryRange`).
- **Default:** with no stored view the Diary opens on List, on phone and desktop. A stored choice still
  wins, so anyone who has already picked Month, Week or Day keeps it. This replaces the 28 Aug desktop
  default (Week) and the R73 phone default (Day) for first visits only.
- The harness seam (`__NEX_TODAY_SCOPE === "all"`) keeps the older defaults for the existing suites.
- Also: the "i" basis marker from R103 gets its circle (wrong colour variable).

## Tests
New `tests/r104_agenda.js` (19, uses `?scope=default`). `r5_batch9` and `r75_diary` toggle checks re-based to
List | Month | Week | Day. `r87_shell`, `r78_hands`, `r78_fast`, `r90_carve`, `r101_keys`, `r12a`, `r12b`, `r13`,
`r90_queues`, `r73_system` green locally. Tags → r104. admin.css 3,949 lines.
