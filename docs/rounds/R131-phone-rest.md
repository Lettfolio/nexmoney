# R131 — the rest of the phone work

Daniel's "proceed", 23 Nov 2026 (the parts of review item A left out of R129). Real mode, ≤760px.

- **Clients toolbar:** search, Mine/All and sort share one line (the sort's label is clipped to fit).
- **Clients rows:** Call and Text are two 44px icon buttons in a column down the row's right edge (`.row-contact-side`), instead of a line of their own. Rows 139–193px → 121–141 on the fixture; the list starts at 337px (was 391).
- **Open case:** next task, next appointment and last note fold behind one button (`phoneCase()`, `.cs-fold`). Once opened they stay open for the session. A case with an overdue task is never folded and gets no button. Tabs start at 509px on the fixture (was 576). Daniel did not name the lines to fold; this is the smallest cut and he was told.

Filter rows keep the fade (R128); they do not wrap.

Tests: `tests/r131_phone_rest.js` (15).
