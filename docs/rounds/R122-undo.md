# R122 — Undo in place of a question, where the thing can be put back (review X3, second half)

## The survey
The back office asks before acting in about forty places. Nearly all of them guard something that cannot be taken back or should not be done lightly: an email or SMS going to a client, a hard delete, a role or access change, a payment written onto cases, a warning about a date. Those keep their question.

Three guarded something that can be put back exactly. In real mode they now act at once and the toast offers **Undo** (10 seconds, the existing action-toast time):

| Action | Undo does | Notes |
|---|---|---|
| Delete a checklist row (case › Documents, Owner/Admin) | re-inserts the same row — same id, status, dates and file pointer | the row is read before it is deleted; no trigger removes the uploaded file; repaints only if that case is still open |
| Delete a saved Pipeline view | saves it again with the filters it held | R74 · B3 asked because a view "does not come back"; now it does |
| Assign ticked cases to an adviser (Operations › Data health) | hands each back to whoever had it | only where the case is still as this left it — one a colleague has re-assigned since is left alone, and the toast says how many |

Under the harness seam all three still ask.

## Not changed, and why
- Cancelling a queued email or SMS: the queue's status changes are guarded server-side (R97), and a cancelled send is not simply re-queued.
- Deleting an appointment: it may already have gone to a calendar.
- Bulk protection status: it stamps quote dates and commissions; putting those back exactly is not a one-line reversal.

`tests/r122_undo.js` (16).
