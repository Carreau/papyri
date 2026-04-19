# Viewer redesign — TODO

Scope: layout overhaul + card-based index + sidebar navigation covering
narrative docs, tutorials, examples, and API. Driven entirely from the
**ingest store** (`~/.papyri/ingest/`). The gen dir (`~/.papyri/data/`) is
no longer a viewer input; anything the viewer needs at render time must be
written by `papyri ingest`.

Tracked against `viewer/PLAN.md`. When an item lands, tick it here and note
any new constraint in `PLAN.md`.

## Ground constraints

- Viewer reads ingest only. `listBundles()` / `dataDir()` usage must go.
  Landing page lists `listIngestedBundles()` exclusively.
- No new Python runtime deps. Changes to `papyri` stay minimal and are
  justified in their PR body.
- Keep per-PR diffs small. Order below is the intended merge order.

## 0. Python-side: ingest carries what the viewer needs

Prereq for everything downstream. Land before the TS work starts.

- [x] `crosslink.py` `Ingester._ingest_logo`: copies the gen bundle's
      logo from `assets/` into `<ingestDir>/<pkg>/<ver>/meta/logo.<ext>`
      and rewrites the ingested meta's `logo` field to that basename so
      the viewer doesn't have to sniff extensions.
- [x] Ingested meta now carries a `summary` field: plain-text first
      paragraph of the top-level module docstring's `Summary` section,
      extracted at ingest time from `IngestedDoc._content["Summary"]`.
- [x] Confirmed: `meta/toc.cbor` (TocTree, tag 4021) is written by
      `Ingester._ingest_narrative` for bundles that have a `toc.json`.
- [x] Tutorials bucket documented as a filename convention in
      `docs/IR.md` (files prefixed `tutorial_` or under `docs/tutorials/`).
      No new IR field.

## 1. TS: stop reading from gen

Minimal-diff PR that precedes the layout work so follow-ups don't have to
juggle two code paths.

- [x] Delete `listBundles`, `dataDir`, and the gen-bundle branch from
      `src/pages/index.astro`. Landing page lists ingested bundles only.
- [x] Remove `dataDir` from `src/lib/paths.ts` (and its tests) once no
      caller remains. (Also removed now-dead `listBundles`, `Bundle`,
      `BundleMeta` from `ir-reader.ts`.)
- [x] Drop the "gen only — run papyri ingest" row; an un-ingested bundle
      simply doesn't appear.
- [x] Update `PLAN.md` Config section: no `PAPYRI_DATA_DIR`.

## 2. Shared layout + sidebar shell

Layout redo. No new routes yet — just rehome existing pages under a
two-column layout.

- [x] Add `src/layouts/BaseLayout.astro` (header only) and
      `src/layouts/BundleLayout.astro` (header + sidebar + main slot,
      takes `{pkg, ver, bundlePath}` as props).
- [x] Extract `SiteHeader` content: wordmark on the left, theme toggle on
      the right, optional global-search slot.
- [x] Sidebar structure (stubbed sections render empty until their data
      source lands):
      - bundle identity block: logo, pkg, version (links to bundle index)
      - Docs (from `meta/toc.cbor` — stub)
      - Tutorials (filtered docs — stub)
      - Examples (from `examples/` — stub)
      - API (BundleSearch island + compact qualname list)
- [x] CSS grid in `global.css`: `[aside][main]` on ≥900px, stacked below.
      Replace `main { max-width: 960px }` with a layout-level container.
- [x] Mobile: sidebar collapses behind a small toggle (checkbox hack is
      fine; prefer zero-JS).
- [x] Migrate `src/pages/[pkg]/[ver]/index.astro` and
      `[...slug].astro` onto `BundleLayout`. Landing and 404 stay on
      `BaseLayout`.

## 3. Landing page — cards

- [x] `src/components/BundleCard.astro`: logo, pkg, version, blurb,
      counts (N qualnames / N docs / N examples). Entire card is a link.
- [x] `src/pages/index.astro`: responsive grid (CSS `auto-fill,
      minmax(16rem, 1fr)`), header with a filter island.
- [x] `src/components/BundleGridSearch.tsx`: reuses the `filterQualnames`
      pattern from `BundleSearch` but over `(pkg, blurb, tag)`. Tiny,
      client-side, no network.
- [x] Render logo via a static route served out of the ingest store
      (see §5) or, if that slips, inline as a data URI at build time.
      (Done as data URI at build time; static route deferred to §5.)

## 4. Narrative docs, tutorials, examples routes

Blocked on §0 (toc.cbor must exist) for the sidebar to be useful, but the
routes themselves can land first rendering flat lists.

- [x] `src/pages/[pkg]/[ver]/docs/[...doc].astro`: load the `docs/<ref>`
      CBOR blob, render via `<IrNode>`, reuse `BundleLayout`.
- [x] `src/pages/[pkg]/[ver]/examples/[...ex].astro`: load
      `examples/<name>` (Section), render children via `<IrNode>`.
- [x] `src/lib/nav.ts`: per-bundle view-model —
      `{logoUrl, summary, toc, docs, tutorials, examples, qualnames}`.
      Memoised per-build via a module-level `Map<bundlePath, Promise>`.
      `ir-reader.ts` grew a shared `loadCbor()` helper; `nav.ts` is now
      the sole consumer on the page side.
- [x] Read `meta/toc.cbor`, walk the `TocTree` (tag 4021) into a
      sidebar-ready tree. Tutorials split off by filename convention
      (`tutorial_*` or `docs/tutorials/*`).
- [x] Wire the sidebar stubs from §2 to `nav.ts`. Highlight the current
      entry via `activeQualname` / `activeDocPath` / `activeExamplePath`
      props on `BundleLayout`.

## 5. Assets

- [x] Static route or `public/`-shuttle for bundle assets so
      `linkForRef({kind:"assets"})` resolves. Implemented as an Astro
      endpoint (`src/pages/assets/[pkg]/[ver]/[...asset].ts`) that reads
      from the ingest store at build time; colons in asset filenames are
      slugified `: -> $` to sidestep Astro's URL-based output writer
      (rule mirrors qualnameToSlug).
- [x] Fig IR node handling in `IrNode.astro`: renders `<img>` pointing
      at the resolved asset URL.

## 6. Cross-cutting

- [x] Update `viewer/PLAN.md`: note M6 (layout redo + nav) with notes on
      decisions; flagged the "dev server hot-reloads when a new bundle
      is ingested" claim as untested.
- [x] Vitest coverage: pure helpers in `nav.ts` (`tests/nav.test.ts`
      covers `isTutorial`, `listFilesRecursive`, `listDocs`/`listExamples`,
      `loadBundleNav` docs-vs-tutorials split + URL encoding). Snapshot
      test on the card grid deferred — the grid already renders at
      build time through `pnpm build` against the local ingest, so a
      snapshot over a fixture wouldn't catch much more.
- [ ] Playwright smoke: landing card click → bundle index → qualname
      page → narrative doc → example → asset. Deferred; needs a
      Playwright devDep + fixture ingest. Track as a follow-up PR.

## Out of scope for this pass

- Global full-text search. Per-bundle + per-grid filters only.
- Re-executing examples, edit-in-browser, auth.
- Server-rendered dark Shiki theme (follow-up tracked in `PLAN.md`).
- Splitting the viewer into its own repo (tracked in `PLAN.md`).
