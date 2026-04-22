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

The build now also emits a Node server bundle at `viewer/dist/server/`.
It serves the static pages for every prerendered route and handles a
small set of `prerender = false` routes at request time. The SSG deploy
path (Cloudflare Pages) is unchanged — those routes simply aren't
called — but the same build works under a long-running Node process.

Run the server locally after `pnpm build`:

```sh
pnpm serve
```

SSR endpoints currently exposed:

| Route                        | What it returns                                      |
| ---------------------------- | ---------------------------------------------------- |
| `/api/bundles.json`          | Live list of ingested bundles, read per request.     |
| `/api/search.json?q=<term>`  | Cross-bundle substring search over qualnames.        |

These are the designated shock absorber for future dynamic behaviour
(global search, on-the-fly bundle swaps, the hosted multi-tenant
service). Existing pages keep their SSG contract via the default
`output: "static"` — only routes that explicitly `export const
prerender = false;` are rendered at runtime.

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
