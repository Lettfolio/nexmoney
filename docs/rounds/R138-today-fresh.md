# R138 — a return to Today inside a minute keeps what is on screen (26 Nov 2026)

Item 2 of the performance review. **Daniel, 26 Nov 13:17: "yes to the 60-second refresh"** — asked with the trade-off stated: R55 (August) had decided against caching Today's reads because a change saved elsewhere could show late.

**Before:** every return to Today re-read everything — 14 calls, even seconds after the last load.

**Now (real mode):** `nav("dashboard")` keeps the page as it is when all of these hold:
- Today was loaded less than 60 s ago (`TODAY_FRESH_MS`);
- this browser has written nothing since — `dbWriteSeq` (core.js) is bumped by every `insert` / `update` / `upsert` / `delete` on any table, every RPC not matching `READ_ONLY_RPC` (`get_*`, `has_*`, `find_*`, `my_role`, `session_ok`), and every edge-function call (`fnFetch`, which the eight `functions/v1` call sites now use);
- no read has failed since (`dbFail` clears the stamp);
- the list is on the page.

So your own change always shows at once (R55's concern), and a colleague's change shows within a minute — the rule the book already keeps. `loadDashboard()` called directly, Mine/All, a sign-in and the tab-return refresh (R101) all still load.

When Today is kept, the page-shown helpers (`stripHints`, `capLists`, …) are run once by hand: they normally ride the redraw's DOM mutations, and without that the strip fades went unmeasured and another page's "show 20" cap did not reset (found by `r128` B and `r130` A6/B0/B2).

**A new RPC that only reads** must match `READ_ONLY_RPC` or it will count as a write (safe, but it costs the saving).

**Tests:** `tests/r138_today_fresh.js` (14). Locally: lint, type-check, smoke, all 44 real-mode / r87 / r90 / r94 / r85 suites. Tag r136 → r138.

**Not done:** Operations still makes 8 `email_queue` reads on opening.
