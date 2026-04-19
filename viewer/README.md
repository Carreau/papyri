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

Writes a fully static site to `viewer/dist/` with one HTML page per
ingested qualname. Pages are self-contained: KaTeX math is
server-rendered, Shiki highlights code at build time, and crosslinks
resolve to real `<a href>`s via the SQLite graph.

Preview the built output:

```sh
pnpm preview
```

## Other scripts

| Script               | What it does                                  |
| -------------------- | --------------------------------------------- |
| `pnpm check`         | Astro + TypeScript type-check.                |
| `pnpm test`          | Run the vitest unit suite once.               |
| `pnpm test:watch`    | Vitest in watch mode.                         |

## Environment variables

| Variable            | Default                          | Purpose                                  |
| ------------------- | -------------------------------- | ---------------------------------------- |
| `PAPYRI_DATA_DIR`   | `~/.papyri/data`                 | Root of per-bundle gen output.           |
| `PAPYRI_INGEST_DIR` | `~/.papyri/ingest`               | Root of the ingested store.              |
| `PAPYRI_INGEST_DB`  | `~/.papyri/ingest/papyri.db`     | SQLite graph database.                   |

If `PAPYRI_INGEST_DB` points at a missing file, the viewer still
builds and serves: xrefs render as muted "unresolved" spans and the
"Referenced by" sections are omitted. This is the CI path — no bundles
are required to verify the scaffolding.
