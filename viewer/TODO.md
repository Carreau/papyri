# Viewer redesign — TODO

Scope: layout overhaul + card-based index + sidebar navigation covering
narrative docs, tutorials, examples, and API. Driven entirely from the
**ingest store** (`~/.papyri/ingest/`).

Tracked against `viewer/PLAN.md`. When an item lands, tick it here and note
any new constraint in `PLAN.md`.

## Remaining

- [ ] Playwright smoke: landing card click → bundle index → qualname
      page → narrative doc → example → asset. Deferred; needs a
      Playwright devDep + fixture ingest. Track as a follow-up PR.

## Out of scope for this pass

- Global full-text search. Per-bundle + per-grid filters only.
- Re-executing examples, edit-in-browser, auth.
- Server-rendered dark Shiki theme (follow-up tracked in `PLAN.md`).
- Splitting the viewer into its own repo (tracked in `PLAN.md`).
