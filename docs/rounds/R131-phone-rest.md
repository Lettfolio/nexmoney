# R131 — the rest of the phone work

Daniel's "proceed", 23 Nov 2026 (the parts of review item A left out of R129). Real mode, ≤760px.

- **Clients toolbar:** search, Mine/All and sort share one line (the sort's label is clipped to fit).
- **Clients rows:** Call and Text are two 44px icon buttons in a column down the row's right edge (`.row-contact-side`), instead of a line of their own. Rows 139–193px → 121–141 on the fixture; the list starts at 337px (was 391).

**Tried and withdrawn — the open case header.** Folding next task / next appointment / last note behind a 44px button moved the tabs up by 3px on a typical case (512 → 509): the button is as tall as the lines it hides. It only pays when all three lines wrap. Left as it was; shortening the header needs a decision on hiding the objective prompt or the adviser / loan / LTV strip.

Filter rows keep the fade (R128); they do not wrap.

Tests: `tests/r131_phone_rest.js` (10).
