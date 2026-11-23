# R130 — "Show more" on long lists

Daniel's "proceed" on the fresh review's layout items, 22 Nov 2026 (C). Real mode only.

Clients, Protection and Retention show their first 20 rows and a button — "Show 20 more (30 not shown)" — at the end of the list (`capLists()`, `LIST_CAPS`). A list of 25 or fewer is left alone.

- Rows are drawn as before and only hidden, so search, sort and the chips work on the whole list.
- **Nothing is selected out of sight:** if any hidden row is ticked (Select all), the whole list is shown.
- The count goes back to 20 when the page changes.
- A group heading with no visible rows under it is hidden with them.

Fixture: Clients 4.8 screens → 2.3 at 1366×768 (Protection 3.7 → 2.9).

Not covered: Data health (its length is many panels, not one list) and the open case's Details tab.

Tests: `tests/r130_show_more.js` (15).
