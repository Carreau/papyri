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
  papyri gen ../examples/papyri.toml --no-infer
  papyri ingest ~/.papyri/data/papyri_<version>/
  ```

  By default the viewer reads `~/.papyri/data/` and
  `~/.papyri/ingest/papyri.db`. Point it elsewhere with the env vars
  below.

## Install

```sh
cd viewer
pnpm install
```

`better-sqlite3` has a native binding that pnpm builds on first
install; the allowlist for post-install scripts is declared in
`package.json` under `pnpm.onlyBuiltDependencies`.

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

| Method | Route                        | What it does                                         |
| ------ | ---------------------------- | ---------------------------------------------------- |
| `GET`  | `/api/bundles.json`          | Live list of ingested bundles, read per request.     |
| `GET`  | `/api/search.json?q=<term>`  | Cross-bundle substring search over qualnames.        |
| `PUT`  | `/api/bundle`                | Receive a bundle, store it, update the graph DB.     |

These are the designated shock absorber for future dynamic behaviour
(global search, on-the-fly bundle swaps, the hosted multi-tenant
service). Existing pages keep their SSG contract via the default
`output: "static"` — only routes that explicitly `export const
prerender = false;` are rendered at runtime.

## Uploading a bundle

The `PUT /api/bundle` endpoint receives a pre-ingested bundle, extracts
it into the ingest store, and updates the cross-link graph — so
cross-refs and back-refs work immediately without restarting the server.

**Prerequisite**: the server must be running in SSR mode (`pnpm dev` or
`pnpm serve`).

### Step 1 — ingest the bundle locally

Use either the Python CLI or the TypeScript `ingest/` package:

```sh
# Python
papyri gen examples/papyri.toml --no-infer
papyri ingest ~/.papyri/data/papyri_0.0.8/

# TypeScript (ingest/ package — eventual Python replacement)
papyri-ingest ~/.papyri/data/papyri_0.0.8/
```

Both write the processed bundle to `~/.papyri/ingest/<pkg>/<version>/`.

### Step 2 — upload

Stream the bundle directory directly to the running viewer:

```sh
tar czf - -C ~/.papyri/ingest/papyri/0.0.8 . \
  | curl -X PUT http://localhost:4321/api/bundle \
         -H "Content-Type: application/gzip" \
         --data-binary @-
```

Or save the archive first if you need to inspect it or retry:

```sh
tar czf papyri-0.0.8.tar.gz -C ~/.papyri/ingest/papyri/0.0.8 .
curl -X PUT http://localhost:4321/api/bundle \
     -H "Content-Type: application/gzip" \
     --data-binary @papyri-0.0.8.tar.gz
```

### Response

| Status | Body                                      | Meaning                                     |
| ------ | ----------------------------------------- | ------------------------------------------- |
| `201`  | `{ok, pkg, version, path, blobs, links}`  | Bundle stored and graph updated.            |
| `207`  | `{ok:false, error, pkg, version, path}`   | Blobs on disk; graph update failed — retry. |
| `400`  | `{ok:false, error}`                       | Missing body or bad `meta.cbor`.            |
| `422`  | `{ok:false, error}`                       | Tar extraction failed.                      |
| `500`  | `{ok:false, error}`                       | Filesystem error.                           |

### Notes

- The bundle must be an **ingest-format** directory — the output of
  `papyri ingest` or `papyri-ingest`, not the raw `papyri gen` output.
  The `meta.cbor` file inside the bundle identifies the package and
  version; no URL parameters are needed.
- The archive is extracted atomically into a staging directory inside
  `PAPYRI_INGEST_DIR` and then renamed into place.
- The graph update runs inside a single SQLite transaction. If it fails,
  blobs are already on disk; re-uploading the same bundle retries the
  graph step.
- No authentication is applied. Run behind a trusted network or
  reverse-proxy ACL until auth is added.
- **Future direction**: once the viewer and `ingest/` are linked as a
  pnpm workspace, the endpoint will accept the raw gen bundle directly
  (output of `papyri gen`), removing the need for a separate local
  ingest step before uploading.

## Other scripts

| Script               | What it does                                  |
| -------------------- | --------------------------------------------- |
| `pnpm check`         | Astro + TypeScript type-check.                |
| `pnpm test`          | Run the vitest unit suite once.               |
| `pnpm test:watch`    | Vitest in watch mode.                         |
| `pnpm serve`         | Run the built Node server (SSG + SSR routes). |

## Environment variables

| Variable            | Default                          | Purpose                                  |
| ------------------- | -------------------------------- | ---------------------------------------- |
| `PAPYRI_INGEST_DIR` | `~/.papyri/ingest`               | Root of the ingested store.              |
| `PAPYRI_INGEST_DB`  | `~/.papyri/ingest/papyri.db`     | SQLite graph database.                   |

If `PAPYRI_INGEST_DB` points at a missing file, the viewer still
builds and serves: xrefs render as muted "unresolved" spans and the
"Referenced by" sections are omitted. This is the CI path — no bundles
are required to verify the scaffolding.
