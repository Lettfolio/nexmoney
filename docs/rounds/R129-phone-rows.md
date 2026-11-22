# R129 — shorter rows on a phone

Daniel's "proceed" on the fresh review's layout items, 22 Nov 2026 (A). Real mode, ≤760px.

- **One action line a row.** On Today, Protection and Retention a row's Call and Text sat on a line of their own above its buttons. They now join the button line as two 44px icon buttons (`phoneRows()`, `.row-contact-moved`); they still dial and open a text, and Call carries the number as its label. A Retention row with two buttons plus ⋯ still takes two lines.
- **Today:** an alert's Clear button sits beside its text instead of on a line below.
- **Clients:** the title and New client share a line.

Measured on the fixture: Retention rows 215–291px → 182–264; Today's tallest row 302 → 257; Clients' list starts 37px higher.

**Not done here:** Clients rows (they have no button line to join), putting search, sort and Mine/All on one line, and the open case's header before its tabs.

Tests: `tests/r129_phone_rows.js` (11).
