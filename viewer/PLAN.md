# Viewer — web renderer for papyri IR

A **read-only web viewer** that renders documentation from ingested papyri
bundles. The viewer lives in-tree while the IR is in flux; co-locating
producer and consumer lets us iterate across breaking changes in one PR.
Splitting into a separate repo remains an option once the IR schema stabilizes.

> **IR stability contract.** `src/lib/ir-reader.ts` is the designated shock
> absorber — when the IR changes, the fix lands there, not spread across
> components. Treat it as the only place allowed to know the on-disk format.

## Goals

1. Serve browsable HTML for every ingested package/module/qualname.
2. Consume the IR through an abstract storage layer — no Python-side
   rendering, no new intermediate format.
3. Support both a local dev server (for working on papyri) and a static
   export (for publishing a site from a given set of ingested bundles).
4. Stay small. No authoring, no search backend, no database beyond what
   papyri already provides.

## Non-goals (for v0)

- Running or re-executing examples.
- Authentication, multi-tenant hosting, comments, edit-in-browser.
- Full-text search. Start with qualname/prefix search; revisit later.

## Features

### Must-have (v0)

- **Package index**: list ingested `(pkg, version)` bundles.
- **Module / page index**: TOC per bundle.
- **Qualname page**: signature, parameters, description, see-also, notes,
  examples.
- **Cross-links**: forward links resolve via the graph; 404 → nearest match.
- **Back-references**: "used by" / "referenced from" section.
- **Math**: KaTeX (server-side at build time).
- **Code highlighting**: Python, text, console.
- **Example blocks**: render captured stdout/plots/HTML assets from the
  bundle's `assets/` dir.
- **Static build**: pre-rendered HTML + assets for hosting behind any static
  file server.

### Nice-to-have (later)

- Prefix / fuzzy search (client-side index built at export time).
- Dark mode toggle.
- Permalink copy for any anchor.
- Per-bundle version picker.
- Diff view between versions of the same qualname.

### Open follow-ups

- **Decouple admin and docs routes in the source tree.** Host-based
  gating landed (`src/middleware.ts` + `src/lib/surface.ts`), but the
  filesystem layout still interleaves the two surfaces — e.g. `pages/`
  has `index.astro` (docs) next to `admin/` and `login.astro` (admin),
  and `pages/api/` mixes `bundles.json.ts` / `search.json.ts` (docs)
  with `bundle.ts` / `clear.ts` / `reingest.ts` / `inventory.ts` /
  `stats.ts` / `nodes.json.ts` / `ir-stats.json.ts` / `auth/` (admin).
  Reading the directory no longer tells you which surface owns a file.
  Worth resolving before splitting into two Astro builds, since the
  layout chosen here becomes the natural seam. Two options:
  - *(A) URL-aligned move.* Push every admin route under a predictable
    prefix: keep `/admin/*` for pages, move `pages/api/*` admin routes
    under `pages/api/admin/*` (so `/api/admin/bundle`, `/api/admin/clear`,
    …), and fold `/nodes`, `/ir-stats`, `/text-search` into `/admin/`.
    Requires changing `papyri upload`'s default URL and updating
    middleware prefix lists, but the directory then mirrors the URL
    space exactly and the two-build split is `cp -r pages/api/admin
    admin-app/pages/api/`. Pre-production, so the URL break is cheap.
  - *(B) Source folder via `injectRoute`.* Keep URLs unchanged but
    physically separate `src/routes/admin/` and `src/routes/docs/`,
    registered through a small Astro integration that walks each tree
    and calls `injectRoute({ pattern, entrypoint })`. Preserves the
    upload URL; adds one layer of indirection.

  Pick before the two-build milestone. Mention in the same commit that
  retires the host-gated single process.

- **Bundle-walk shared helper — landed; ingest-time index still open.** The
  duplicated walk in `lib/image-index.ts` and
  `pages/api/[pkg]/[ver]/nodes.json.ts` is now consolidated in
  `lib/bundle-walk.ts` (`walkBundle` / `walkAllBundles`), and the node-search
  dedup + Image-type bugs are fixed (dedup is keyed by `type\0content` with
  page-merge in `nodes.json.ts`). What remains is the perf optimisation:
  precompute a `nodes_by_type` table at ingest time so `/images/` and the node
  browser do an indexed lookup instead of a full bundle scan (the ~25s scan).
  Per the "Storage invariant" in the top-level `PLAN.md`, that table is free to
  hold whatever shape the endpoints want. `bundle-walk.ts` is the place to hang
  the optimisation once it lands.

## Tech choices

| Area             | Choice                        | Why                                          |
| ---------------- | ----------------------------- | -------------------------------------------- |
| Language         | TypeScript                    | Typed IR = fewer renderer bugs               |
| Runtime          | Node LTS (long-running server)| Local dev + hosted service (VPS) target      |
| Framework        | Astro (SSG + SSR islands)     | Current choice; not locked in permanently    |
| UI components    | React (inside Astro islands)  | Familiar; may revisit with framework choice  |
| Graph client     | abstracted (`GraphDb`)        | SQLite today; abstraction allows a swap later|
| Blob storage     | abstracted (`BlobStore`)      | Filesystem today; abstraction allows a swap  |
| Math             | `katex` (server-side)         | No JS runtime shipped to the client          |
| Syntax highlight | `shiki`                       | Zero-runtime, VS Code grammars               |
| Styling          | Plain CSS + CSS custom props  | No Tailwind yet; keep the surface small      |
| Package manager  | `pnpm`                        | Workspace-ready for the ingest sibling       |
| Lint / format    | ESLint + Prettier             | Standard                                     |
| Tests            | Vitest + Playwright smoke     | Unit for IR reader; e2e for golden pages     |

## Architecture sketch

```
viewer/
├── PLAN.md
├── package.json
├── astro.config.ts
├── src/
│   ├── lib/
│   │   ├── ir-reader.ts     # load bundle, decode blobs, typed IR
│   │   ├── backends.ts      # getBackends() → BlobStore + GraphDb + RawStore
│   │   ├── graph.ts         # graph queries over GraphDb
│   │   └── paths.ts         # discovery, env override
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
2. `storage` retrieves the matching blob from the bundle.
3. `ir-reader` decodes the blob into typed IR nodes.
4. `graph` resolves forward and back references.
5. Astro page renders IR nodes → JSX. No ad-hoc HTML strings.

## Config

- `PAPYRI_INGEST_DIR` — defaults to `~/.papyri/ingest`. Used by the Node
  filesystem backend.
- `PAPYRI_INGEST_DB` — defaults to `~/.papyri/ingest/papyri.db`. Used by
  the SQLite graph backend.
- `--mode dev | build` via Astro.

## Milestones

All milestones through M8 are complete. The viewer runs as a
long-running Node.js server (`@astrojs/node`, `output: "server"`) on a
VPS; newly uploaded bundles appear without a rebuild.

The pieces below landed during the (now abandoned) Cloudflare Workers
exploration and are kept because they stand on their own:

- [x] **Async storage + graph layer.** `BlobStore` / `GraphDb` /
      `RawStore` abstractions in `papyri-ingest`, built per-request by
      `viewer/src/lib/backends.ts`.
      `viewer/src/lib/{ir-reader,graph,nav,image-index,xref}.ts` are
      async and parameterised on the backend triple; every page calls
      `getBackends()` and passes it down. CrossRef resolution batches
      once per page via `buildXrefResolver(graphDb, doc)` so render
      components stay sync.
- [x] **Bundle upload in-process.** `PUT /api/bundle` gunzips the body
      via `DecompressionStream`, CBOR-decodes it to a `Bundle` Node, and
      hands it to `Ingester.ingestBundle(node)` — no temp dir, no `tar`
      spawn. Write path uses subquery-based link inserts so a single
      `db.batch([…])` is atomic.
- [x] **Raw bundle archive.** Every `PUT /api/bundle` archives the
      compressed `.papyri.gz` bytes to `_raw/<pkg>/<ver>.papyri.gz`
      (`<ingest-dir>/_raw/` on the filesystem) before ingest runs.
      `POST /api/reingest` (auth-gated, NDJSON stream) replays the raw
      archive through a fresh ingest — supports `?pkg=` / `?ver=` to
      scope to one bundle. `RawStore` interface + `FsRawStore` live in
      `ingest/src/raw-store.ts`.

### Cloudflare Workers (R2 + D1) — abandoned

The hosted target was a Cloudflare Workers deploy (graph in D1, blobs in
R2). It was dropped: **ingest latency on Workers/R2/D1 was far too
high.** Workers caps subrequests per invocation (50 Free / 1000 Paid),
and ingest does ~3 subrequests per object (`blobStore.has` +
`blobStore.put` + `graphDb.batch`); even a 0.16 MiB astropy bundle 422'd
on Free, and there was no way to ingest a scipy-sized bundle in one
invocation without queue-based chunking. The wall-clock cost of R2/D1
round-trips made it impractical. Hosting is now a long-running Node
process on a VPS, where ingest is a single in-process transaction.

The storage **abstractions are kept** (`BlobStore` / `GraphDb` /
`RawStore`) so a different backend can be slotted in later without
touching the viewer — but only the filesystem + SQLite implementations
exist today, and there is no Cloudflare adapter, `wrangler.toml`, or
`build:cf` target anymore.

## Open questions

- Encoding convergence: if everything moves to a single encoding (CBOR or
  JSON), `ir-reader` gets simpler. Until then it handles both.
- IR-drift policy: pin a "known-good" IR version, or accept best-effort
  rendering and let components no-op on unknown nodes? Probably the latter
  while the IR is still evolving.

## Ground rules

- No Python code here. Everything reads the IR produced by the top-level
  `papyri` package.
- No changes to the IR format from inside `viewer/`. If the viewer needs a
  field the IR doesn't expose, raise it against the top-level plan first.
- Keep dependencies tight. Every new runtime dep needs a one-line
  justification in the PR.
