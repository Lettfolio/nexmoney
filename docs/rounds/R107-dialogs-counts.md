# R107 — In-app confirm and type-in (X3), sidebar counts (N1), loading placeholders (X4)

Daniel, 16 Nov 2026: "proceed with … the remaining updates".

## What changed
- **X3 — no browser boxes.** `askConfirm(text, okLabel)` and `askText(text, opts)` replace 33 native
  `confirm()` calls (app.js 29, diary.js 2, reports-money.js 2) and 4 `prompt()` calls. Both open the house
  overlay: the first paragraph is the heading, the rest the body; the dismiss button is "Go back", the
  action button a verb ("Continue" by default; "Cancel this email", "Mark not proceeding" where set).
  `askText` keeps prompt()'s contract (string, or null when cancelled). Every call site was already inside
  an async function, so each became `await askConfirm(…)` with no change to its callers.
  Left native on purpose: the "Your account email:" prompt on the sign-in page (before the app has loaded).
- **N1 — sidebar counts.** `setNavCount()`: Today = My Day rows due or overdue (every band but "Worth
  doing"); Retention = rates already ended (`rateBookCounts`, the one definition); Operations = emails the
  sender rejected (the same figure as Today's "emails failed" chip). Zero shows nothing; 100+ shows "99+".
- **X4 — loading placeholders.** `paintSkeleton(page)` draws six grey bars into a list container that is
  still empty when its page is opened (Today, Clients, Retention, Protection, Operations, Vault). It never
  overwrites a list already on show, and the loader's own write replaces it.

## Not done here
- Undo in place of confirm for reversible actions (the other half of X3) — each needs its own reverse
  write; the dialogs are converted first so nothing still raises a browser box.

## Harness
Under the R102 seam the native boxes, no counts and no placeholders remain, so the older suites (which
answer `page.on("dialog")`) run unchanged. `tests/r107_dialogs.js` (18) reads the real behaviour.
Tags → r107. admin.css 3,949 lines.
