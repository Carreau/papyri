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
- [ ] Render bundle / site logos against a translucent background so
      light-on-light or dark-on-dark logo PNGs (e.g. the white
      silhouette in `assets/papyri-logo 2.png`) stay legible across
      both themes. The current path inlines the logo as a data URI on
      whatever surface the sidebar / card sits on; a small wrapper
      with a checkered or theme-tinted backdrop would handle the
      worst cases without per-bundle config.

## Out of scope for this pass

- Global full-text search. Per-bundle + per-grid filters only.
- Re-executing examples, edit-in-browser, auth.
- Server-rendered dark Shiki theme (follow-up tracked in `PLAN.md`).
- Splitting the viewer into its own repo (tracked in `PLAN.md`).
