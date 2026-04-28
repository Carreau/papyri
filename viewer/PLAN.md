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

## Tech choices

| Area             | Choice                        | Why                                          |
| ---------------- | ----------------------------- | -------------------------------------------- |
| Language         | TypeScript                    | Typed IR = fewer renderer bugs               |
| Runtime          | Node LTS / Cloudflare Workers | Local dev + hosted service target            |
| Framework        | Astro (SSG + SSR islands)     | Current choice; not locked in permanently    |
| UI components    | React (inside Astro islands)  | Familiar; may revisit with framework choice  |
| Graph client     | abstracted (`GraphBackend`)   | SQLite for Node, D1 for Workers              |
| Blob storage     | abstracted (`StorageBackend`) | Filesystem for Node, R2 for Workers          |
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
│   │   ├── storage.ts       # StorageBackend (NodeFsBackend / R2Backend)
│   │   ├── graph.ts         # GraphBackend (Sqlite3Backend / D1Backend)
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

All milestones through M8 and M9.0–M9.1 are complete. Open milestones:

- [x] **M9.2 — async storage + graph layer.** `BlobStore` /
      `GraphDb` abstractions in `papyri-ingest` (fs+sqlite ↔ R2+D1),
      built per-request by `viewer/src/lib/backends.ts`.
      `viewer/src/lib/{ir-reader,graph,nav,image-index,xref}.ts` are
      async and parameterised on the backend pair; every page calls
      `getBackends()` and passes the pair down. CrossRef resolution
      batches once per page via `buildXrefResolver(graphDb, doc)` so
      render components stay sync. `output: "server"` (no SSG): newly
      uploaded bundles appear without a rebuild.
- [x] **M9.3 — bundle upload on Workers.** `PUT /api/bundle` shares
      the same `getBackends()` path. Body is gunzipped via
      `DecompressionStream` and CBOR-decoded to a `Bundle` Node, then
      handed to `Ingester.ingestBundle(node)` — no temp dir, no `tar`
      spawn. Write path uses subquery-based link inserts so a single
      `db.batch([…])` is atomic on both SQLite and D1.
- [ ] **M9.4 — CI smoke + cutover.** A workflow that runs `wrangler dev`
      against an empty store, hits a few routes, then `papyri upload`s a
      fixture bundle and checks that pages now resolve. Decide whether the
      Node `pnpm serve` mode stays as a maintained fallback or is dropped.

M9 constraints:

- Nothing in the IR shape changes as part of M9.
- `better-sqlite3` and `node:fs` must not be reachable from a route compiled
  into the Workers bundle (sync APIs, native bindings).

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
