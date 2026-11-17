# R112 — Target colour by pace (O4), SEO tab in two (O10); C5 measured

Daniel, 17 Nov 2026: "proceed" (the remaining review items).

## O4 — Reports: "34% of target" was red on the 14th
The hero percentage was coloured by the percentage alone (green ≥100, amber ≥60, else red). It is now read
against how much of the month has gone:
- **green** — target met, or (this month) earned % ≥ % of the month gone;
- **amber** — this month and behind that pace;
- **red** — only a month that has closed short;
- a future month is muted.
For the current month the text says it too — "34% of target · on pace" / "· behind pace" — with the two
percentages on the tooltip, so colour is not the only signal. Applies in both harness modes (text is
appended; nothing removed).

## O10 — Website › SEO: five panels in one scroll
Two inner tabs under the tiles: **Performance** (history, recommendations, queries) and **Page audit** (the
per-page table). Opens on Performance once Search Console is connected, on the audit until then; stays on
the tab it was left on; a tile that points at a section on the other tab switches to it. `seoBodyHtml()`,
`seoShowTab()`; reuses `.rec-tabs`, so no CSS added. Off under the harness seam, where R93/R100's suites
read one page.

## C5 — measured, no change
The review counted 45 controls on the old case panel and asked for 10–15 per tab with one primary action.
On the record now: 3–4 buttons in the action bar (Advance, Log call, Book appointment, Actions ▾), 6–7
controls in the left column and 4–8 on the Work tab. Met by R109; nothing built.

## Left for Daniel's say (each reverses a recorded decision)
- **B8 / B9** (Diary week/day: tasks row, overlapping blocks) — the tasks row (R12b W-18) and the block line
  budget (R6FIX-1) were deliberate, and the List view is the default since R104.
- **O7** (Operations run buttons into one menu) — sits beside the email hold; wording there is deliberate.

## Harness
`tests/r112_pace_seo_tabs.js` (15). Tags → r112. admin.css unchanged (3,949).
