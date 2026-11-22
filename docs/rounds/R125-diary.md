# R125 — Diary: task count and title-first blocks

Approved by Daniel on 21 Nov 2026 (review items B8 and B9). Real mode only (`ROW_ONE()`); the seam is unchanged.

- **B8 — one count per day.** Two or more tasks due on a day show as one "N tasks due" button in the Week head and the Day row (`diaryDueHtml`, `diaryDueToggle`). A click lists the tasks in place; each still opens its case. One task stays a plain chip. An overdue task turns the count's edge red. This reverses R12b · W-18's always-open row, which pushed the lanes down the page.
- **B9 — title before time.** Where appointments sit side by side in a narrow lane (Week view, three or more across in Day view, or any side-by-side pair on a phone) the title leads and the time follows; the block's own time and title are always in the tooltip. R6FIX-1's line budget is unchanged.

Tests: `tests/r125_diary.js` (17).
