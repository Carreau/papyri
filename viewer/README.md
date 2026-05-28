# Papyri viewer

A read-only web viewer that renders pages directly from a local papyri
IR on disk. Lives in-tree next to the Python producer; reads the same
CBOR bundles and SQLite graph that `papyri gen` produces and the
sibling `ingest/` (TypeScript) package writes under `~/.papyri/`.

See [`PLAN.md`](PLAN.md) for scope, milestones, and rationale.

## Prerequisites

- Node.js 20+
- pnpm 10+ (`npm install -g pnpm`)
- An ingested papyri bundle somewhere on disk. If you don't have one
  yet, generate a bundle and upload it to a running viewer:

  ```sh
  pip install -e .
  papyri gen examples/papyri.toml --no-infer
  # in another terminal: pnpm --filter papyri-viewer dev
  papyri upload ~/.papyri/data/papyri_<version>/
  ```

  See [Uploading a bundle](#uploading-a-bundle) for details.

  By default the viewer reads `~/.papyri/ingest/` and
  `~/.papyri/ingest/papyri.db`. Point it elsewhere with the env vars
  below.

## Install

The viewer lives in a pnpm workspace alongside `ingest/` (the
TypeScript ingest library it depends on). Install everything from the
repo root:

```sh
pnpm install
```

`better-sqlite3` has a native binding that pnpm builds on first
install; the allowlist for post-install scripts is declared in the
top-level `package.json` under `pnpm.onlyBuiltDependencies`.

## Run the dev server

```sh
pnpm dev
```

Defaults to <http://localhost:4321>. Hot-reloads on source changes.
If you ingest a new bundle while the dev server is running, refresh
the page — the IR and SQLite store are read at request time.

## Build a static site

```sh
pnpm build
```

Writes a fully static site to `viewer/dist/client/` with one HTML page
per ingested qualname. Pages are self-contained: KaTeX math is
server-rendered, Shiki highlights code at build time, and crosslinks
resolve to real `<a href>`s via the SQLite graph.

Preview the built output:

```sh
pnpm preview
```

## SSR mode

The build also emits a Node server bundle at `viewer/dist/server/`.
It serves static pages for every prerendered route and handles a set of
`prerender = false` routes at request time. A static-only deploy that
serves `dist/client/` works too — those request-time routes are simply
never called there — but the full build runs under a long-running Node
process.

Run the server locally after `pnpm build`:

```sh
pnpm serve
```

SSR endpoints:

| Method | Route                       | Surface | What it does                                       |
| ------ | --------------------------- | ------- | -------------------------------------------------- |
| `GET`  | `/api/bundles.json`         | docs    | Live list of ingested bundles, read per request.   |
| `GET`  | `/api/search.json?q=<term>` | docs    | Cross-bundle substring search over qualnames.      |
| `PUT`  | `/api/admin/bundle`         | admin   | Receive a gen bundle, ingest it, update the graph. |

These are the designated shock absorber for future dynamic behaviour
(global search, on-the-fly bundle swaps, the hosted multi-tenant
service). The viewer runs under `@astrojs/node` (`output: "server"`);
prerendered pages are still served as static HTML, while routes that
read live state handle requests at runtime.

## Uploading a bundle

The `PUT /api/admin/bundle` endpoint receives a packed `.papyri` artifact, runs
the full ingest pipeline, and updates the cross-link graph — so cross-refs and back-refs
work immediately without restarting the server. This is the canonical
ingest entry point; the Python side ships bundles to it via
`papyri upload`.

**Prerequisite**: the server must be running in SSR mode (`pnpm dev` or
`pnpm serve`).

### Step 1 — generate the bundle

```sh
papyri gen examples/papyri.toml --no-infer
```

This writes a gen bundle to `~/.papyri/data/papyri_<version>/`. The
upload endpoint runs the ingest pipeline server-side.

### Step 2 — upload

```sh
papyri upload ~/.papyri/data/papyri_<version>/
```

`papyri upload` (defined in `papyri/cli/upload.py`) tars the bundle
directory and PUTs it to the endpoint. It defaults to the local
viewer (`http://localhost:4321/api/admin/bundle`); point it elsewhere with
`--url`. Multiple bundle paths can be passed in a single invocation.

### Response

| Status | Body                      | Meaning                                 |
| ------ | ------------------------- | --------------------------------------- |
| `201`  | `{ok:true, pkg, version}` | Bundle ingested into the graph store.   |
| `400`  | `{ok:false, error}`       | Missing body or bad `papyri.json`.      |
| `422`  | `{ok:false, error}`       | Tar extraction or ingest failed.        |
| `500`  | `{ok:false, error}`       | Filesystem error before ingest started. |

### Notes

- The bundle must be a **gen-format** directory — the output of
  `papyri gen`, containing `papyri.json`, `module/`, `docs/`,
  `examples/`, `assets/`, `toc.cbor`. The `papyri.json` file
  identifies the package and version; no URL parameters are needed.
- The archive is extracted into a staging directory inside
  `PAPYRI_INGEST_DIR`. The `Ingester` writes blobs and graph entries
  directly into `<PAPYRI_INGEST_DIR>/<pkg>/<version>/`; the staging
  copy is removed afterwards.
- Ingestion runs the `papyri-ingest` library's `Ingester` (sibling
  workspace package). It is synchronous and blocks the event loop for
  the duration of a single upload.
- No authentication is applied. Run behind a trusted network or
  reverse-proxy ACL until auth is added.

## Other scripts

| Script            | What it does                                  |
| ----------------- | --------------------------------------------- |
| `pnpm check`      | Astro + TypeScript type-check.                |
| `pnpm test`       | Run the vitest unit suite once.               |
| `pnpm test:watch` | Vitest in watch mode.                         |
| `pnpm serve`      | Run the built Node server (SSG + SSR routes). |

## Running admin and docs on separate hostnames

The viewer can serve its read-only docs surface (`/`,
`/project/<pkg>/<ver>/...`) and its mutating admin surface (`/admin`,
`/admin/login`, `/api/admin/bundle`, …) under different hostnames so a
bundle-injected XSS payload on a docs page cannot reach the admin
session cookie. Set `PAPYRI_DOCS_HOST` and `PAPYRI_ADMIN_HOST` and the
middleware in `src/middleware.ts` 404s any cross-surface path. See
[`DEPLOY.md`](DEPLOY.md#splitting-admin-and-docs-onto-two-hostnames) for
local-dev recipes (two ports, `/etc/hosts` aliases, or a reverse proxy).

## Environment variables

| Variable            | Default                      | Purpose                                                                              |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `PAPYRI_INGEST_DIR` | `~/.papyri/ingest`           | Root of the ingested store.                                                          |
| `PAPYRI_INGEST_DB`  | `~/.papyri/ingest/papyri.db` | SQLite graph database.                                                               |
| `PAPYRI_DOCS_HOST`  | _unset_                      | External hostname of the docs surface. Setting either host var turns on the split.   |
| `PAPYRI_ADMIN_HOST` | _unset_                      | External hostname of the admin surface (login, upload, all mutating endpoints).      |
| `PAPYRI_SITE`       | _unset_                      | Canonical external origin (Astro `site`). With the split enabled, the docs URL.      |

If `PAPYRI_INGEST_DB` points at a missing file, the viewer still
builds and serves: xrefs render as muted "unresolved" spans and the
"Referenced by" sections are omitted. This is the CI path — no bundles
are required to verify the scaffolding.
