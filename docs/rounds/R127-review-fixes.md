# R127 — four plain fixes from the 21 Nov review

Daniel's go-ahead: 22 Nov 2026. Stylesheet and small markup fixes; both harness modes.

- **Phone rows (Clients, Protection, Retention):** the case label was painted 48px tall to make it tappable and sat over the client's name and the line beneath. It is pill-height again; the 44px tap is an invisible hit area (`::after`).
- **Off the right edge:** the Protection clawback table sits in a `.table-scroll` wrapper; a row's labels wrap on a phone instead of running off-screen.
- **Small tap targets (touch / ≤760px):** the Pipeline column fold arrow, "+N" on a card, the "i" info buttons, "+N more on this case", Vault "Details", "Preview this email", the case's "add" rent link, Data health's "see Emails" and adviser names on Reports get a 44px hit area with no change to how they look. Adviser names on Reports are limited by the row pitch (~40px).
- **Case History:** the author's initials were 8.5px; now 12px in a 22px circle.
- **Reports:** the monthly bar takes the headline's pace colour (R112 · O4), so "on pace" in green no longer sits over an amber bar. The bar on My numbers keeps its own thresholds.

Tests: `tests/r127_fixes.js` (22).
