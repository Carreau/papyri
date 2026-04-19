# Viewer — open TODOs

Everything from the M6 redesign (§0–§6 of the old punch list) landed in
commits `8d226a73` … `bdf5327a`; the rename pass (`5bb6531d`, `53c2e967`,
`1f8ec880`) updated the viewer dispatch tables to match the new class
names. Per-item decisions are summarised in `viewer/PLAN.md` § M6.

## Open

- **Playwright smoke test** — landing card → bundle index → qualname →
  narrative doc → example → asset. Needs a Playwright devDep + a
  fixture ingest. Separate PR.
- **Dark-adapted Shiki theme** — ship `github-dark` and swap via
  `html[data-theme="dark"] pre.code`. KaTeX surface is already fine.
- **Vendor KaTeX CSS** instead of the jsDelivr CDN link in `Head.astro`.
  Blocks strict-CSP and offline builds.
- **Per-bundle version picker** — sidebar or header dropdown listing
  other ingested versions of the current pkg.
- **Static-export deploy story** — `viewer/DEPLOY.md` exists but the
  Cloudflare Pages workflow was removed; document a minimal "rsync the
  dist/ dir to any static host" path.
- **Global search** — cross-bundle manifest fed into a single
  `BundleGridSearch`-style island. Currently per-bundle only.
- **Splitting the viewer into its own repo** — option once the IR
  schema stabilises; not scheduled.

## Out of scope (do not revive)

- Re-executing examples, edit-in-browser, auth.
- Python-side HTML / terminal / TUI renderers (explicitly removed in
  root `PLAN.md`).
