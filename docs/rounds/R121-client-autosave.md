# R121 — save-as-you-go on an existing client's fields; a fragile CI check made reliable

## Client fields (the leftover from R110/R111)
An existing client on the full-width record has no Save or Cancel button. A field is written as it is left, with a "✓ Saved" tick beside it.
- `clientAutosaves(id)`, `clientFormRow(form)` (the one builder the Save button also uses), `wireClientAutosave(k)`, `saveClientFields(k, form, base)`.
- Only changed columns are sent. `#client-form` carries `data-autosave="1"` **in its markup** (not set afterwards — `modalSnapshot` is taken at `openModal`, so a later attribute made every record look unsaved).
- Refusals, each on its own field: a blank first or last name is put back with a toast; a malformed email or phone stays in the box, marked, and is not written.
- Concurrency as on the case: write on the opened stamp; if a colleague wrote meanwhile, re-read — untouched fields go again on the fresh stamp, a clash asks "Keep mine".
- After a write: stamp refreshed, heading follows a name change, the side column catches up on the next change of tab, watchtower + client list refresh (debounced 800ms), and the "Fix contact → Retry now" offer is kept.
- The client record's bottom bar is hidden when empty (Delete moved to Details in R111).
- New clients and the harness seam keep the Save button.

`tests/r121_client_autosave.js` (21). `r111_client_record` A6/B1/B2 and `r116` A2 re-based.

## `r95_kit` I2
The no-JS contact-page check ticked the consent box with a forced pointer click that sometimes did not register in CI (PR #36). It now sets the box directly and asserts it took; the check is about the submit, not the click.
