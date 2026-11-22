# R126 — one Mine/All for the whole back office

Approved by Daniel on 21 Nov 2026 (review item N6). Real mode only (`ROW_ONE()`); the seam is unchanged.

A press on Mine or All on Today, Pipeline, Clients, Protection, Retention or the rate list is stored per user (`nx_scope_v1_<user id>`) and every other page opens on it (`firmScope`, `firmScopeApply`, `firmScopeNote`). With nothing stored: advisers and the owner open on Mine, an administrator on All.

A page's own extras stay that page's: Unassigned on Protection or Pipeline, and a named adviser picked on Pipeline or Clients, are not stored firm-wide and are not overwritten by a press elsewhere.

**Changed for the owner:** Pipeline, Clients and Retention used to open on All; they now open on Mine until he presses All once, which then holds everywhere. This reverses R12b · W-7 ("nothing is remembered" on Today), R64 · M9 and the per-page defaults of R102 · T3.

The Diary's adviser picker is not part of this — it chooses whose calendar to look at.

Tests: `tests/r126_scope.js` (16). Re-based to press All first: `r105_rows`, `r109_record`, `r117_pipeline_cards`, `r118_edge_marks`, `r122_undo`.
