# Viewer — HTML serving for ingested papyri IR

Read-only Astro + React + TypeScript app that renders pages directly from
the papyri ingest store (`~/.papyri/ingest/`) and its SQLite graph. The
gen dir (`~/.papyri/data/`) is a `papyri` CLI concern, not a viewer input.

> **IR break-policy.** Expect the IR to change under us. `src/lib/ir-reader.ts`
> is the designated shock absorber — when the IR format shifts, the fix
> lands there (plus any component consuming the new shape). Don't spread
> on-disk format knowledge across the codebase.
>
> **Keep in-tree for now.** Splitting the viewer into its own repo stays
> an option once the IR schema stabilises, but while Phase 2 is still
> settling it's easier to iterate on both sides in one PR.

## Tech choices

| Area            | Choice                        | Why                                             |
| --------------- | ----------------------------- | ----------------------------------------------- |
| Language        | TypeScript                    | Typed IR = fewer renderer bugs                  |
| Framework       | **Astro** (SSG + React islands) | Content-shaped site; minimal JS by default    |
| CBOR reader     | `cbor-x`                      | Fast, streaming, TS types                       |
| Graph client    | `better-sqlite3`              | Sync, tiny, reads `papyri.db` directly          |
| Math            | `katex` (build-time SSR)      | Rendered at build; only CSS shipped to clients  |
| Syntax highlight| `shiki` (`github-light`)      | Cached singleton highlighter                    |
| Styling         | Plain CSS + CSS custom props  | No Tailwind                                     |
| Package manager | `pnpm`                        |                                                 |
| Tests           | Vitest + (planned) Playwright |                                                 |

Every new runtime dep needs a one-line justification in the PR body.

## Config

- `PAPYRI_INGEST_DIR` — defaults to `~/.papyri/ingest`. Viewer reads
  bundles, assets, and metadata from here.
- `PAPYRI_INGEST_DB` — defaults to `~/.papyri/ingest/papyri.db`. When
  absent the viewer still builds; XRefs render as unresolved spans and
  the "Referenced by" section is omitted.

## Architecture

```
viewer/
├── src/
│   ├── layouts/       # BaseLayout (landing + 404), BundleLayout (sidebar + main)
│   ├── lib/
│   │   ├── ir-reader.ts  # CBOR decode, FIELD_ORDER tag → name map
│   │   ├── nav.ts        # per-bundle view-model; memoised per build
│   │   ├── graph.ts      # better-sqlite3 wrapper
│   │   └── paths.ts      # ~/.papyri discovery + env overrides
│   ├── components/    # BundleCard, BundleSidebar, BundleSearch, IrNode, ...
│   ├── pages/
│   │   ├── index.astro                          # landing (card grid)
│   │   ├── [pkg]/[ver]/index.astro              # bundle index
│   │   ├── [pkg]/[ver]/[...slug].astro          # qualname page
│   │   ├── [pkg]/[ver]/docs/[...doc].astro      # narrative doc
│   │   ├── [pkg]/[ver]/examples/[...ex].astro   # example page
│   │   └── assets/[pkg]/[ver]/[...asset].ts     # static asset endpoint
│   └── styles/
└── tests/             # vitest
```

Data flow per page: resolve `(pkg, ver, …)` from the URL → `nav.ts`
hydrates the bundle view-model (logo, summary, TocTree, docs,
tutorials, examples, qualnames) → `ir-reader` decodes the relevant
CBOR blob → page renders via `<IrNode>`; XRefs resolve synchronously
through `graph.ts`.

## Milestones — all landed

M0 scaffolding · M1 single-page render · M2 crosslinks + backrefs
· M3 math (KaTeX SSR) + Shiki · M4 static export verified against
numpy 2.3.5 · M5 search + 404 + dark mode · M6 layout redo + sidebar
nav + cards + narrative/example routes + asset endpoint.

Per-commit history and rationale: `git log --grep='^viewer:'`.

## Load-bearing design notes

A few choices that aren't obvious from the code and that future work
will want to build on or challenge:

- **Math is server-side, not client-side.** `katex.renderToString` at
  build; parse errors fall back to `<code class="math-error">` so one
  bad `:math:` snippet can't break the build. Only the KaTeX CSS is
  shipped to clients — currently via jsDelivr CDN; vendoring is tracked
  in `TODO.md`.
- **Shiki is `github-light` only.** Dark-mode surface is darker but the
  code palette stays light. Swapping in `github-dark` via
  `html[data-theme="dark"] pre.code` is tracked.
- **Per-bundle client-side search.** `src/pages/[pkg]/[ver]/search.json.ts`
  emits a small manifest; `BundleSearch` filters it client-side. Global
  search is a follow-up.
- **`nav.ts` is the view-model surface.** Pages / layouts read
  `loadBundleNav(pkg, ver, bundlePath)` and nothing else for bundle
  metadata. `ir-reader.ts` stays the on-disk shim; `nav.ts` memoises
  per `bundlePath` so many pages per bundle pay the CBOR round-trip
  once.
- **TocTree handling.** `meta/toc.cbor` decodes to either a single
  TocTree or a list; `readToc` unwraps single-root trees with children.
  Hrefs are shaped inline via `refToHref` (local to `nav.ts`) to avoid
  cross-module coupling with `linkForRef`.
- **Tutorials are filename-driven.** `tutorial_*` prefix or
  `docs/tutorials/*` path. No dedicated IR field — see `docs/IR.md`.
- **Logos as data URIs.** `loadBundleNav` base64-inlines the logo from
  `meta/logo.<ext>` (falling back to `assets/<name>` for older ingests).
  Keeps the sidebar + card renderers synchronous; logos are tens of KB.
- **Asset endpoint.** `src/pages/assets/[pkg]/[ver]/[...asset].ts`
  materialises each bundle's `assets/` into `dist/assets/...` at build.
  Asset filenames containing `:` get slugified `:` → `$` (rule mirrors
  qualnameToSlug); `linkForRef` and the Fig `IrNode` branch apply the
  same rule. Astro's URL-based output writer rejects bare colons.
- **Graph DB is optional.** `openGraphDb` caches a single handle per
  build; returns `null` when the DB is absent. Viewer degrades
  gracefully — no crash.
- **Dev server hot-reload is best-effort.** Astro watches `src/**`, not
  `~/.papyri/**`. "Ingest → restart dev" is the real workflow.

## Ground rules

- **No Python here.** The viewer reads the IR produced upstream; if a
  field is missing, raise it against the root `PLAN.md` first.
- **No IR format changes from inside `viewer/`.** Same reason.
- **Keep dependencies tight.** Every new runtime dep needs a one-line
  justification.
- **Run `pnpm check` + `pnpm test` (+ `pnpm build` on structural
  changes) before committing.** Same for the Python linters if your
  change crosses the boundary — see root `CLAUDE.md`.
