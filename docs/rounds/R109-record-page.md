# R109 — A case opens as a full-width record with tabs (C1, C2, C3)

Daniel's answer on 16 Nov 2026: full-width record page (not a side panel), save-as-you-go to follow.

## What changed
- **C1 — full width.** An existing case no longer opens in the 640px pop-up. `recordLayout()` (called from
  `openModal()`) gives `#modal` the class `record`: it fills the page beside the sidebar (max 1240px),
  with the summary card and its action bar down the left.
- **C2 — four tabs** on the right: **Work** (tasks, notes, referrals, offer diff, milestones, stage
  checklist), **Documents** (documents, files), **Details** (more facts, security check, the case form),
  **History**. The sections are the ones `openCase` already rendered, moved into `.rec-panel` wrappers —
  nothing is re-rendered and no handler changes. Outside Work a fold opens with its tab. The last tab used
  is remembered for the next case.
- **C3 — heading** reads "Client — Type · Stage" instead of "Case"; the client link loses the default
  blue underline. The ✕ is titled "Back to the list".
- The case form is three columns at this width (one on a phone). On a phone the record is one column.

Measured on the sample case at 1366 × 768: Work, Documents and History each fit one screen (768px);
Details is 2,009px. The pop-up was 1,584px in one column for the same case before any fold was opened.

## Not in this round
- **C4 save-as-you-go** — the Save button and the unsaved-changes guard are unchanged here.
- **B3 client record**, new-case form and every other modal keep the small panel.
- C5 (one primary action per stage) — the action bar is as it was.

## Harness
Off under the R102 seam (`ROW_ONE()`), so the older suites drive the 640px panel. `tests/r109_record.js`
(20). The phone rules live inside the existing 900px media block (`r87_shell` D4 pins 14 blocks).
Tags → r109. admin.css 3,949 lines.
