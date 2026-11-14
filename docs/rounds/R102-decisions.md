# R102 · Decisions from the UI/UX review (in progress)

Daniel ticked eight review items on 14 Nov 2026 that reverse earlier rounds' decisions:
T1, T2/B6/X8, T3, B1, B2, B7, O1/O2, B10. Not ticked: O3, O8, N5.

## Built
- **T1 — work first on Today.** `#briefing-panel` (My Day) now follows `#today-heading`; `#kpi-row`,
  `#dash-cap-notice` and `#ops-strip` follow My Day, ahead of the Checks drawer. Same elements, ids and
  click-throughs. First task row at 1366×768 moves from about 430px to 347px (five rows visible, was three).
  Re-based: `r11_ux` R11-A (owner and adviser order), `r68_mi` D2/D2b. R11-1 ("numbers come first") and
  R68 · M16 ("ops strip above the title") are retired by this decision.

## Still to build
T3 (Today opens on Mine, overdue + today), B1 (Clients filter fold), B2 (Clients default sort — needs a
"recently touched" order; today's "recent" is date added), B7 (scope sentences: `#protection-scope-note` and
the scope clause of the Retention sub-line, which `r64_retention` §B3 and `r82_correct` §G read),
O1/O2 (Reports repeats and definitions), B10 (an agenda view does not exist yet — Diary has month/week/day),
T2/B6/X8 (one row pattern).

Eight tags `r102`. Local: smoke 150, r11_ux 129, r68_mi 126, r73_visible 88, r87_today 82, r69_today 71,
r88_today 67; lint 0.
