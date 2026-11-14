# R102 · Decisions from the UI/UX review (in progress)

Daniel ticked eight review items on 14 Nov 2026 that reverse earlier rounds' decisions:
T1, T2/B6/X8, T3, B1, B2, B7, O1/O2, B10. Not ticked: O3, O8, N5.

## Built
- **T1 — work first on Today.** `#briefing-panel` (My Day) now follows `#today-heading`; `#kpi-row`,
  `#dash-cap-notice` and `#ops-strip` follow My Day, ahead of the Checks drawer. Same elements, ids and
  click-throughs. First task row at 1366×768 moves from about 430px to 347px (five rows visible, was three).
  Re-based: `r11_ux` R11-A (owner and adviser order), `r68_mi` D2/D2b. R11-1 ("numbers come first") and
  R68 · M16 ("ops strip above the title") are retired by this decision.

- **T3 — Today's defaults.** The owner's Today opens on Mine (administrators still open on All: the
  firm-wide desk is the job). The "Worth doing" band renders folded; Today and Urgent are the first screen.
- **B7 — scope sentences.** On All, the Retention sub-lines, the Today rate drawer, the gone-quiet definition
  and the protection drawer no longer say "Showing every adviser's cases"; narrowed to Mine or Unassigned the
  sentence stays. Re-based: `r64_retention` §B3e, `r82_correct` G2a, `r38` §B2d.
- **B2 — Clients default order.** New sort "Recently touched" (latest change to the client or any of their
  cases, then name), first in the control and the default. Re-based: `r11_ux` R11-E, `r88_book_b` A4.
- **B1 — Clients filter fold.** All, No live case, No protection outcome and Not contacted on show; the three
  rate-end years and Missing DOB behind "More filters" (a pressed folded chip stays visible).

**Harness seam.** `mock-supabase.js` sets `window.__NEX_TODAY_SCOPE = "all"` unless the URL carries
`?scope=default`, so the older suites keep the firm-wide Today, the A–Z book and all eight chips;
`tests/r102_decisions.js` (19) runs with `?scope=default` and covers the app's real defaults.

## Still to build
O1/O2 (Reports: the earned figure appears in the hero, the Completed £ tile and the target bar; the basis
captions under the tiles are pinned by `r5_batch6` and `r74`), B10 (an agenda view does not exist yet —
Diary has month/week/day), T2/B6/X8 (one row pattern).

Eight tags `r102`. Local: smoke 150, r102_decisions 19, r11_ux 129, r41 86, r68_mi 126, r73_visible 88,
r73_system 73, r87_today 82, r88_today 67, r69_today 71, r12b 157, r64_retention 88, r82_correct 132, r38 95,
r87_book 111, r88_book_b 72, r88_book_c 108, r88_kit 85, r66_book 45, r36 84; lint 0.
