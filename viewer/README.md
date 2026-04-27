# Papyri viewer

A read-only web viewer that renders pages directly from a local papyri
IR on disk. Lives in-tree next to the Python producer; reads the same
CBOR bundles and SQLite graph that `papyri gen` + `papyri ingest`
write to `~/.papyri/`.

See [`PLAN.md`](PLAN.md) for scope, milestones, and rationale.

## Prerequisites

- Node.js 20+
- pnpm 10+ (`npm install -g pnpm`)
- An ingested papyri bundle somewhere on disk. If you don't have one
  yet, run these from the repo root:

  ```sh
  pip install -e .
  papyri gen examples/papyri.toml --no-infer
  papyri ingest ~/.papyri/data/papyri_<version>/
  ```

  Or, once the viewer is running in SSR mode, upload the gen bundle
  directly over HTTP — see [Uploading a bundle](#uploading-a-bundle).

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
`prerender = false` routes at request time. The SSG deploy path
(Cloudflare Pages) is unchanged — those routes are never called there —
but the same build works under a long-running Node process.

Run the server locally after `pnpm build`:

```sh
pnpm serve
```

SSR endpoints:

| Method | Route                       | What it does                                       |
| ------ | --------------------------- | -------------------------------------------------- |
| `GET`  | `/api/bundles.json`         | Live list of ingested bundles, read per request.   |
| `GET`  | `/api/search.json?q=<term>` | Cross-bundle substring search over qualnames.      |
| `PUT`  | `/api/bundle`               | Receive a gen bundle, ingest it, update the graph. |

These are the designated shock absorber for future dynamic behaviour
(global search, on-the-fly bundle swaps, the hosted multi-tenant
service). Existing pages keep their SSG contract via the default
`output: "static"` — only routes that explicitly `export const
prerender = false;` are rendered at runtime.

## Uploading a bundle

The `PUT /api/bundle` endpoint receives a raw `papyri gen` bundle, runs
the full ingest pipeline (the same code path as the `papyri-ingest`
CLI), and updates the cross-link graph — so cross-refs and back-refs
work immediately without restarting the server. This is the
network-callable replacement for running `papyri ingest` locally.

**Prerequisite**: the server must be running in SSR mode (`pnpm dev` or
`pnpm serve`).

### Step 1 — generate the bundle

```sh
papyri gen examples/papyri.toml --no-infer
```

This writes a gen bundle to `~/.papyri/data/papyri_<version>/`. No
local `papyri ingest` step is needed — the endpoint does that work.

### Step 2 — upload

```sh
papyri upload ~/.papyri/data/papyri_<version>/
```

`papyri upload` (defined in `papyri/cli/upload.py`) tars the bundle
directory and PUTs it to the endpoint. It defaults to the local
viewer (`http://localhost:4321/api/bundle`); point it elsewhere with
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
- Ingestion runs the same code as the `papyri-ingest` CLI (sibling
  workspace package). It is synchronous and blocks the event loop for
  the duration of a single upload.
- No authentication is applied. Run behind a trusted network or
  reverse-proxy ACL until auth is added.

## Other scripts

| Script               | What it does                                  |
| -------------------- | --------------------------------------------- |
| `pnpm check`         | Astro + TypeScript type-check.                |
| `pnpm test`          | Run the vitest unit suite once.               |
| `pnpm test:watch`    | Vitest in watch mode.                         |
| `pnpm serve`         | Run the built Node server (SSG + SSR routes). |
| `pnpm seed:wrangler` | Seed local D1 + R2 from the ingest store.     |

## Cloudflare Workers (D1 + R2) — experimental

Tracked as **M9** in [`PLAN.md`](PLAN.md). The eventual hosted target is
a Cloudflare Workers deploy whose graph store lives in D1 and whose CBOR
blobs / assets live in R2 — no per-deploy filesystem state. The work is
staged so each phase lands a working slice.

What is wired up today (M9.0):

- [`wrangler.toml`](wrangler.toml) declares the bindings the viewer
  expects at runtime: `GRAPH_DB` (D1, database name
  `papyri-viewer-graph`) and `BLOBS` (R2, bucket name
  `papyri-viewer-blobs`).
- [`scripts/seed-wrangler.mjs`](scripts/seed-wrangler.mjs) bootstraps
  the local miniflare state from your existing ingest store. It walks
  `~/.papyri/ingest/`, copies every row of `papyri.db` into D1
  (creating the schema first), and PUTs every blob to R2 with the same
  relative path as on disk.

What does **not** work yet: there is no Workers entrypoint, so
`wrangler dev` cannot serve the viewer. `pnpm dev` / `pnpm build` /
`pnpm serve` (Node adapter) remain the supported run modes. The
adapter swap and the async storage refactor land in M9.1–M9.3.

### Try the seeder

Prereqs:

- A populated `~/.papyri/ingest/` (run `papyri ingest` first).
- `wrangler` on your `PATH`. The script does **not** add it as a
  dependency yet; install it ad-hoc with `pnpm add -D wrangler` from
  `viewer/`, or globally with `npm install -g wrangler`.

```sh
cd viewer
pnpm seed:wrangler
```

Pass `--remote` to write to a real Cloudflare account instead of the
local miniflare state. The first remote run requires `wrangler d1
create papyri-viewer-graph` and `wrangler r2 bucket create
papyri-viewer-blobs`, plus replacing the placeholder `database_id` in
`wrangler.toml` with the UUID `wrangler d1 create` prints.

Local state lives under `viewer/.wrangler/state/v3/`. Delete that
directory to start over.

## Environment variables

| Variable            | Default                      | Purpose                     |
| ------------------- | ---------------------------- | --------------------------- |
| `PAPYRI_INGEST_DIR` | `~/.papyri/ingest`           | Root of the ingested store. |
| `PAPYRI_INGEST_DB`  | `~/.papyri/ingest/papyri.db` | SQLite graph database.      |

If `PAPYRI_INGEST_DB` points at a missing file, the viewer still
builds and serves: xrefs render as muted "unresolved" spans and the
"Referenced by" sections are omitted. This is the CI path — no bundles
are required to verify the scaffolding.
