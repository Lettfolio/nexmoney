# R110 — A case field saves as you leave it (C4)

Daniel's answer on 16 Nov 2026: "full-width record page and save-as-you-go on case fields".

## What changed
- **No Save button on the record.** On an existing case in the full-width record, leaving a box (or
  choosing from a drop-down) writes it. A "✓ Saved" tick shows beside that field's label for 2.5 seconds.
  Cancel goes with Save; "Open client" stays in the footer.
- **Only what changed is sent.** `saveCaseFields()` writes the difference between the form now and the
  form as last saved (`caseFormRow()`), so a box nobody touched is never written. The old Save sent all
  fifty fields every time.
- **The same checks, on the field that trips them.** Protection conversation before Application, a
  commission figure before "Policy taken", the reason for Not Proceeding, a completion date in the past
  or 30+ days after the offer expires. A refused field goes back to what it was.
- **Two people in one case.** If a colleague saved the case meanwhile but left your field alone, yours is
  written with no question. If they changed the same field, you are asked which to keep.
- **The left column follows.** Adviser, Loan, LTV, Lender, Rate and the heading repaint as the field
  saves. A stage or type change redraws the record (actions and checklist follow the stage); anything else
  redraws on the next change of tab. Never while a note or task is half typed.
- **Leaving.** Escape or ✕ saves the box being typed in first; there is no "discard changes?" for case
  fields. A half-typed note, task or call log still warns.
- "+ New client…" is not offered in the client picker of an existing case (it needed the Save step). It
  is still on a new case.

## Unchanged
- A **new case** keeps Save and Cancel — nothing exists to save into until it is created.
- The client record, appointments and every other form.
- `saveCase()` itself, which the new case and the harness seam still use.

## Harness
Off under the R102 seam (`ROW_ONE()`). `tests/r110_autosave.js` (27). `r109_record` A10/B1/B2 re-based:
they asserted the Save button and the unsaved-changes warning on the record. No CSS added (the tick reuses
`.saved-msg`). Tags → r110. admin.css 3,949 lines.
