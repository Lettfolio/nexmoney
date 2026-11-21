# R124 — three small tidy-ups Daniel approved on 21 Nov

Each reverses an earlier decision, so each waited for his yes (asked 17 Nov, ticked 21 Nov).

1. **Page boxes say Filter (rest of N3).** The boxes that narrow the list on a page — Pipeline, Clients, Retention, Protection, Vault — read "Filter …" in the placeholder and the aria-label. The global box that looks everywhere still says "Search clients and cases". Static text, both harness modes.
2. **No "Showing your…" sentence on Mine.** R102 · B7 dropped it on All; it now goes on Mine too (real mode): Retention's "Showing your cases: the whole…" → "The whole…", its "… Showing your cases." after the open/won/lost line, the rate list's "Showing your cases — N alerts firm-wide." → "N alerts firm-wide.", and Protection's "Showing your cases only — My Day's Mine/All toggle above decides this." The pressed Mine button is the statement.
3. **The Emails intro goes inside the fold beneath it.** R42 · F4 kept `#emails-intro` on show as an arrival fact. In real mode `tuckProse()` now moves it to the first line of `#emails-explainer` ("ⓘ How the queue, review requests and reminders behave"). Wording unchanged. The two status lines (`#em-morning-sub`, `#sms-summary`) stay on show.

`tests/r124_tidy.js` (13); `r119_prose_info` A1 re-based.
