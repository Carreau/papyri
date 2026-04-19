# Viewer — HTML serving for ingested papyri IR

This subfolder hosts a **read-only web viewer** that renders pages directly
from the local papyri IR on disk (`~/.papyri/data/<pkg>_<ver>/`) and the
SQLite cross-link graph (`~/.papyri/ingest/papyri.db`).

> Relation to top-level `PLAN.md`: that doc's Phase 3 originally punted
> rendering to a *separate* repo. Decision: **keep the renderer in-tree
> under `viewer/` for now.** Rationale: the IR is still in heavy
> development (Phase 2 hasn't stabilized it yet), so having the renderer
> and the IR producer in the same repo lets us iterate on both in a single
> commit/PR instead of juggling two repos across breaking changes. Splitting
> into a separate repo remains an option once the IR schema is documented
> and stable. The top-level `PLAN.md` should be updated to point at this
> directory.
>
> Practical consequence: **expect the IR to break us.** The `ir-reader`
> module is the designated shock absorber — when the IR changes, the fix
> lands there (plus whatever component consumes the new shape), not spread
> across the viewer. Treat `src/lib/ir-reader.ts` as the only place allowed
> to know the on-disk format.

## Goals

1. Serve browsable HTML for every ingested package/module/qualname.
2. Consume the IR **directly** — no Python-side rendering, no new
   intermediate format.
3. Support both a local dev server (for working on papyri) and a static
   export (for publishing a site from a given set of ingested bundles).
4. Stay small. No authoring, no search backend, no database beyond what
   papyri already writes.

## Non-goals (for v0)

- Running or re-executing examples. `papyri gen` produces the captured
  outputs; the viewer only displays them.
- Authentication, multi-tenant hosting, comments, edit-in-browser.
- Full-text search. Start with qualname/prefix search against the graph;
  revisit later.
- Server-side math rendering via `flatlatex` (that was removed on purpose).
- Re-implementing the old `papyri serve` / `serve-static` Quart stack.

## Features

### Must-have (v0)

- **Package index**: list ingested `(pkg, version)` bundles from the graph
  DB.
- **Module / page index**: TOC per bundle, driven by `toc.json`.
- **Qualname page**: signature, parameters, description, see-also, notes,
  examples.
- **Cross-links**: forward links resolve via the graph; 404 → nearest
  match.
- **Back-references**: "used by" / "referenced from" section fed by the
  graph.
- **Math**: KaTeX in the client (swap in for the removed `flatlatex`).
- **Code highlighting**: Python, text, console. Precomputed at build where
  possible.
- **Example blocks**: render captured stdout/plots/HTML assets from the
  bundle's `assets/` dir.
- **Dev server**: hot-reloads when a new bundle is ingested.
- **Static build**: pre-rendered HTML + assets for hosting behind any
  static file server.

### Nice-to-have (later)

- Prefix / fuzzy search (client-side index built at export time).
- Dark mode toggle.
- Permalink copy for any anchor.
- Per-bundle version picker.
- Diff view between versions of the same qualname.

## Tech choices

Leaning toward the minimum that reads the IR cleanly.

| Area            | Choice                        | Why                                             |
| --------------- | ----------------------------- | ----------------------------------------------- |
| Language        | TypeScript                    | Typed IR = fewer renderer bugs                  |
| Runtime         | Node LTS                      | Matches the "future Node project" in `PLAN.md`  |
| Framework       | **Astro** (SSG + SSR islands) | Content-shaped site; minimal JS by default      |
| UI components   | React (inside Astro islands)  | Familiar; matches the original Phase 3 intent   |
| CBOR reader     | `cbor-x`                      | Fast, streaming, TS types                       |
| Graph client    | `better-sqlite3`              | Sync, tiny, reads `papyri.db` directly          |
| Math            | `katex` (client)              | Replaces `flatlatex`; no server dep             |
| Syntax highlight| `shiki`                       | Zero-runtime, VS Code grammars                  |
| Styling         | Plain CSS + CSS custom props  | No Tailwind yet; keep the surface small         |
| Package manager | `pnpm`                        | Workspace-ready if we add a shared IR lib       |
| Lint / format   | ESLint + Prettier             | Standard                                        |
| Tests           | Vitest + Playwright smoke     | Unit for IR reader; e2e for a few golden pages  |

### Alternatives considered

- **Next.js**: heavier, RSC + route conventions don't buy much for a
  content-only site, deploy story is more opinionated.
- **SvelteKit / Remix**: fine, but the main `PLAN.md` calls out React and
  there's no reason to diverge.
- **Plain Express/Fastify + server-rendered React**: more plumbing than
  Astro, no static-export story out of the box.
- **Python-side rendering** (Jinja etc.): out of scope — top-level
  `PLAN.md` explicitly removed this.

## Architecture sketch

```
viewer/
├── PLAN.md                  # this file
├── package.json
├── pnpm-workspace.yaml      # if we split packages later
├── astro.config.ts
├── src/
│   ├── lib/
│   │   ├── ir-reader.ts     # load bundle dir, decode CBOR/JSON, typed IR
│   │   ├── graph.ts         # better-sqlite3 wrapper over papyri.db
│   │   └── paths.ts         # ~/.papyri discovery, env override
│   ├── components/          # React islands: Signature, Param, SeeAlso, …
│   ├── pages/
│   │   ├── index.astro      # list of (pkg, version) bundles
│   │   ├── [pkg]/[ver]/index.astro
│   │   └── [pkg]/[ver]/[...slug].astro   # qualname pages
│   └── styles/
└── tests/
```

Data flow per request/page:

1. Resolve `(pkg, ver, qualname)` from the URL.
2. `ir-reader` loads the matching `module/*.json` (or CBOR) from the
   bundle dir and the referenced `docs/` / `examples/` / `assets/` files.
3. `graph` queries `papyri.db` for forward and back references.
4. Astro page renders structured IR nodes → JSX. No ad-hoc HTML strings.

## Config

- `PAPYRI_DATA_DIR` — defaults to `~/.papyri/data`.
- `PAPYRI_INGEST_DB` — defaults to `~/.papyri/ingest/papyri.db`.
- `--mode dev | build` via Astro.

## Milestones

1. [x] **M0 — scaffolding.** `pnpm init`, Astro app boots, reads
   `~/.papyri/data` and lists bundles. No qualname rendering yet.
2. [x] **M1 — single-page render.** Given `(pkg, ver, qualname)`, render
   signature + description from the IR. No crosslinks.
3. [x] **M2 — crosslinks + backrefs** via `papyri.db`.
4. [x] **M3 — examples, math, syntax highlighting.**
5. [x] **M4 — static export** (`astro build`) verified against a real
   ingested set (numpy, scipy).
6. [x] **M5 — polish**: search, error pages, dark mode.

### M3 notes

- **Math rendering is server-side, not client-side.** Earlier planning
  text said "KaTeX in the client"; the viewer is SSG, so we render KaTeX
  at build time via `katex.renderToString` and embed the HTML. This
  removes the need to ship KaTeX's JS runtime — only the stylesheet is
  linked from each page. Parse errors fall back to a
  `<code class="math-error">` span so one bad `:math:` snippet can't
  break the build.
- **KaTeX CSS source is the jsDelivr CDN** (`katex@0.16.9/dist/katex.min.css`),
  not vendored. Tradeoff: zero bytes in the repo and zero build config,
  but static exports depend on an external origin at load time. Vendor it
  when we need offline support or a strict CSP.
- **Syntax highlighting uses Shiki's `createHighlighter` + `github-light`.**
  Highlighter is a cached module-level singleton so grammars load once per
  build. The IR `Code` node carries no language tag today (see
  `papyri/nodes.py:228`), so every `Code` is highlighted as `python`.
  Adding a language discriminator to the IR is a future refinement; the
  viewer defaults safely and swaps the string when that lands.
- **`example_section_data` is rendered.** It was silently dropped before
  M3. Treated as a `Section`, rendered between regular sections and
  aliases/backrefs.

### M5 notes

- **Dark mode.** Light is the default; writing `data-theme="dark"` on
  `<html>` flips the color tokens in `global.css`. An inline head script
  (in `src/components/Head.astro`) reads `localStorage` synchronously
  before first paint to avoid a FOUC. The toggle itself is a small React
  island (`ThemeToggle.tsx`) that calls `applyTheme` and persists the
  choice. Pure helpers (`nextTheme`, `parseTheme`, `applyTheme`) live in
  `src/lib/theme.ts` with unit tests.
- **Shiki in dark mode is not dark.** We still ship `github-light` for
  code blocks; accepted for M5 since code reads on a darker surface. A
  follow-up is to load a second Shiki theme (e.g. `github-dark`) and
  swap via CSS custom properties or `html[data-theme="dark"] pre.code`.
  KaTeX's stylesheet is untouched; the surface around it darkens but
  glyph strokes stay black. Both fine for now.
- **Per-bundle client-side search.** At build time
  `src/pages/[pkg]/[ver]/search.json.ts` emits a tiny manifest
  (`{qualnames: [...]}`) alongside each bundle index. The `BundleSearch`
  island (`src/components/BundleSearch.tsx`) fetches it on mount and does
  case-insensitive substring filtering over up to 50 hits. Scope is
  deliberately per-bundle — a combined / global index is a follow-up.
  Pure filter (`filterQualnames` in `src/lib/search.ts`) is unit-tested.
- **404 page.** `src/pages/404.astro` is a plain Astro page with the same
  crumb bar pointing to `/`. Astro serves it on unknown routes in dev;
  GitHub Pages / Netlify pick up `dist/404.html` for not-found responses.

### M2 notes

- New runtime dep: `better-sqlite3`. Justification: synchronous SQLite
  client that maps cleanly onto Astro's build-time data loading; the graph
  is a few MB and all lookups happen at SSG time, so we want a zero-async
  API rather than e.g. `sql.js`.
- Async/sync DB access: Astro component frontmatter is async but Astro
  component *props* are resolved synchronously per render. Rather than
  pre-resolving every XRef into a flat `{url, label}` table before rendering
  (which would mean walking the whole IR tree up front), we pass a
  synchronous `resolveXref(node) => {url, label} | null` function into
  `<IrNode>` as a prop. The function closes over the cached SQLite handle
  (`openGraphDb` caches a single `Database` instance per build process), so
  the DB is opened once and queried on demand from within the recursive
  renderer. When the graph DB is absent (fresh checkout / CI), `openGraphDb`
  returns `null` and every `resolveXref` call returns `null`; the viewer
  then degrades to unresolved `.xref` spans and no "Referenced by" section.
- `resolveRef` prefers an exact `(pkg, ver, kind, path)` match, falling
  back to any ingested version of the same `(pkg, kind, path)` sorted
  lexicographically (highest first). True cross-version picking (prefer
  the "closest" ingested version to the caller's version) is deferred —
  our ingested set is tiny, so lexicographic max is fine for now.
- `Fig` refs are not yet rendered — IrNode doesn't have a Fig branch yet,
  and asset serving is M3. The graph still resolves asset links so that
  whenever the renderer gains a Fig branch, the URLs are already correct.

### M1 notes

- CBOR decoding uses `cbor-x` with a global `addExtension` entry per IR
  tag from `docs/IR.md`. Each extension re-shapes the positional
  `CBORTag(tag, [values...])` payload into `{ __type, __tag, ...fields }`
  using the field order declared in `FIELD_ORDER` (mirrors
  `typing.get_type_hints(cls)` on the Python side). Unknown tags fall
  through as `{ __type: "unknown", __tag, value }` and the UI falls back
  to a `<details><pre>` JSON dump per-node, not per-section.
- URL slug for qualnames: colon `:` is rewritten to `$` because colons
  are awkward on some filesystems and in URL bars. `papyri.nodes:RefInfo`
  becomes `papyri.nodes$RefInfo`. `qualnameToSlug` /
  `slugToQualname` in `ir-reader.ts` are the single source of truth.
- Source of truth for ingest bundles is `~/.papyri/ingest/<pkg>/<ver>/`
  (via `listIngestedBundles`), not `~/.papyri/data/`: ingested blobs are
  `IngestedDoc` (tag 4010) with resolved refs, which is what the viewer
  wants. The landing page still lists gen bundles for context and
  annotates ones that haven't been ingested yet.

## Open questions

- Directory name: `viewer/` vs `web/` vs `site/`. Going with `viewer/`
  because it describes intent (view ingested IR) rather than delivery.
- Encoding convergence (top-level `PLAN.md` Phase 2): if everything moves
  to CBOR or everything to JSON, the `ir-reader` gets simpler. Until then,
  it handles both.
- Do we vendor a tiny IR schema doc inside `viewer/` or wait for
  `docs/IR.md` (Phase 2) and consume that?
- Publishing target: resolved — **Cloudflare Pages**, driven from
  `.github/workflows/cloudflare-pages.yml`. The static export is
  deployed as-is; all papyri-side state (bundles, ingest store, graph
  DB) is a build input, never a runtime dependency. See
  [`DEPLOY.md`](DEPLOY.md) for the Cloudflare setup, secrets, and the
  upgrade path to D1 + R2 if we ever outgrow SSG.
- Should the viewer have its own CI workflow, or piggyback on the
  existing Python CI? Probably separate, filtered on `viewer/**`.
- IR-drift policy: do we pin a "known-good" IR commit hash in
  `viewer/package.json` (or similar) so the viewer can fail loudly when
  the IR on disk was produced by an incompatible `papyri gen`, or do we
  just accept best-effort rendering and let components no-op on unknown
  nodes? Probably the latter while Phase 2 is in flux.

## Ground rules for this subfolder

- No Python code here. Everything reads the IR produced by the top-level
  `papyri` package.
- No changes to the IR format from inside `viewer/`. If the viewer needs
  a field the IR doesn't expose, raise it against the top-level plan
  (Phase 2) first.
- Keep dependencies tight. Every new runtime dep needs a one-line
  justification in the PR.
