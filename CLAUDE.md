# Instructions for Claude (or any agent) working on this repo

Read `PLAN.md` first. It is the agreed scope and roadmap. If anything here
contradicts `PLAN.md`, `PLAN.md` wins.

## What this project is trying to solve

Two specific problems in the Python documentation ecosystem drive all design
decisions here. Understand these before touching anything.

**Problem 1 — Sphinx couples building and rendering.**
In Sphinx, parsing docstrings and rendering HTML happen in the same step. To
update a template (e.g. for accessibility), you must rebuild every project
from source. Papyri solves this by splitting the pipeline:

1. `papyri gen` — run by the library maintainer. Produces a self-contained
   *DocBundle* (the IR) from the project source.
2. Rendering — a separate, stateless step that consumes the IR. Updating the
   renderer never touches the original source.

**Problem 2 — Documentation is fragmented across domains.**
Every library lives on its own subdomain with no shared cross-linking.
Papyri's model: maintainers publish DocBundles; a single rendering service
ingests many bundles and serves them from one place with real cross-package
links (conda-forge model).

The **local viewer** (`viewer/`) is the current reference implementation of
the rendering side. It is used for development and debugging, and is being
designed with the centralized service in mind. The architecture is
intentionally shaped to support a future hosted service (Cloudflare Workers +
R2 + D1).

## Repo purpose, short version

- **`papyri gen`**: run per project, by each library maintainer in their own
  CI or build environment. Produces a self-contained DocBundle directory under
  `~/.papyri/data/<pkg>_<ver>/`.
- **`papyri pack`**: packs a DocBundle directory into a `.papyri` artifact
  (gzip-compressed CBOR). The artifact is the canonical shipping unit.
- **`papyri upload`**: ships a `.papyri` file, a `.zip` containing one, or a
  DocBundle directory to a viewer instance whose `/api/bundle` endpoint (HTTP
  `PUT`) runs the TypeScript ingest pipeline server-side to wire bundles into
  the cross-linked graph. Auth: `$PAPYRI_UPLOAD_TOKEN` / `--token`; endpoint:
  `$PAPYRI_UPLOAD_URL` / `--url` (default `http://localhost:4321/api/bundle`).
- **`ingest/`**: TypeScript `papyri-ingest` package — the canonical
  ingestion engine, invoked by the viewer's upload endpoint. There is no
  `papyri ingest` Python CLI; do not add one.
- **`viewer/`**: TypeScript web renderer (Astro + React islands). Targets both
  Node.js (local dev, `pnpm dev`) and Cloudflare Workers (`pnpm build:cf`).
  When building the viewer, think about what the hosted service will need.
- There is no Python-side rendering. Do not add any.

## Audience

- **Right now**: contributors to papyri itself.
- **Eventually**: Python library maintainers who publish DocBundles to a
  central service.

When writing docs, code, or CLI help text, speak to contributors first.
Don't design features for the hosted service yet — design so that a hosted
service *could* be built later without a breaking change to the IR.

## Ground rules for changes

1. **Stay inside scope.** Before adding or fixing anything, check `PLAN.md`.
   If a task is not in the open work or follow-ups, stop and ask the user.
2. **Small focused PRs.** One logical change per commit.
3. **Don't add Python-side rendering, a `papyri ingest` CLI, or the
   JupyterLab extension.** Dangling references to `render.py`, `rich_render`,
   `textual`, `ipython`, `jlab`, `install`, `browse`, or `serve` should be
   deleted, not restored.
4. **Python 3.14+.** `requires-python = ">=3.14"` (PLAN.md). Note: `pyproject.toml`
   currently says `>=3.13` — update it if you touch the file. CI runs 3.14 only.
   Don't add shims for anything older than 3.14.
5. **Verify locally before committing.** At minimum:
   ```
   pip install -e .
   papyri gen examples/papyri.toml --no-infer
   # then run a viewer instance and:
   papyri upload ~/.papyri/data/papyri_<version>
   python -m pytest
   ```
   Run `python -m pytest` (not bare `pytest`) so the editable install's
   interpreter is used. If `papyri.db` complains about schema, `rm -rf
   ~/.papyri/ingest/` and re-upload to a fresh viewer instance.
6. **Run linters and formatters before every commit — before pushing.**
   Waiting for CI to report a formatting or lint failure is wasteful.
   Run all of these locally and fix any issues first:

   **Python** (always, even for viewer-only changes):
   ```
   ruff format papyri/
   ruff check papyri/
   mypy papyri/
   ```
   `ruff format` rewrites files in place; re-stage any files it touches.

   **Viewer** (when `viewer/` files changed):
   ```
   cd viewer
   pnpm install --frozen-lockfile   # only needed once / after lockfile changes
   pnpm run format                  # Prettier — rewrites files in place
   pnpm run lint                    # ESLint — fix any errors (warnings are OK)
   pnpm run check                   # TS type check — must report 0 errors
   ```
   Re-stage any files Prettier rewrites before committing.

   **Ingest** (when `ingest/` files changed):
   ```
   cd ingest
   pnpm run format                  # Prettier
   pnpm run lint                    # ESLint
   pnpm run check                   # tsc --noEmit
   ```

   **Workflows** (when `.github/workflows/` files changed):
   ```
   apt-get install shellcheck       # CI's actionlint runs the shellcheck rule
   go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
   ```
   GitHub Actions silently rejects workflow YAML it can't parse, so the
   only safety net is `actionlint` locally. `shellcheck` must be on
   `PATH` — without it, `actionlint` skips the shell-script rule and
   misses what CI catches.

   CI enforces all of the above via `.github/workflows/lint.yml` — a
   failing commit blocks the PR.
7. **Do not commit anything under `~/.papyri/`.** That's user data, not
   repo content.
8. **Viewer design should anticipate the hosted service.** When working on
   `viewer/`, consider what a centralized multi-bundle service will need (URL
   structure, bundle switching, cross-package search). The storage and graph
   layers must be abstracted so the same code runs against local backends
   (filesystem + SQLite, via `FsBlobStore`/`SqliteGraphDb`) and cloud backends
   (R2 + D1, via `R2BlobStore`/`D1GraphDb`). Both are in `ingest/src/`.

## Repository layout

```
papyri/                   Python package (IR producer + CLI)
  __init__.py             CLI entry (typer app), wires commands from cli/
  cli/                    One file per subcommand: gen, upload, pack, find,
                          describe, diff, debug, about, bootstrap
  gen.py                  Core IR generation (inspect + docstring → IR)
  nodes.py                IR node types (CST/AST nodes)
  node_base.py            Base class for IR nodes (serialization hooks)
  node_serializer.py      CBOR serialization for nodes
  serde.py                Generic dataclass round-trip (JSON or CBOR)
  ts.py                   tree-sitter RST parser wrapper
  tree.py                 RST→IR visitor (directive handlers live here)
  crosslink.py            Read-only access to the ingested graphstore
  graphstore.py           Python graphstore (read-only; write side is TS)
  bundle.py               Bundle load/save helpers
  pack.py                 .papyri artifact packing / unpacking
  config.py               Config dataclasses
  config_loader.py        TOML config loading
  doc.py                  GeneratedDoc — per-object doc container
  directives.py           RST directive registry helpers
  toc.py                  Table of contents extraction
  tokens.py               Token types for RST lexing
  signature.py            Python signature parsing
  numpydoc_compat.py      NumPy docstring section helpers
  executors.py            Doctest / example execution
  error_collector.py      Error accumulation during gen
  examples.py             Example runner helpers
  tests/                  pytest test suite

ingest/                   TypeScript papyri-ingest package
  src/
    index.ts              Public API (re-exports all below)
    ingest.ts             Ingester class — writes bundle into blob+graph
    encoder.ts            CBOR decode/encode, IR node types
    visitor.ts            Forward-ref collector (walks IR nodes)
    bundle.ts             Bundle validation + directory exploder
    graphstore.ts         GraphStore (legacy; used by CLI)
    graph-db.ts           GraphDb interface + SqliteGraphDb/D1GraphDb
    blob-store.ts         BlobStore interface + FsBlobStore/R2BlobStore
    raw-store.ts          RawStore interface + FsRawStore/R2RawStore
    cli.ts                papyri-ingest CLI (standalone use)
  migrations/             SQL schema applied to both SQLite and D1

viewer/                   TypeScript Astro web renderer
  src/
    lib/
      ir-reader.ts        Decode blobs → typed IR (shock absorber for IR changes)
      ir-types.ts         TypeScript types mirroring IR node shapes
      backends.ts         getBackends() — builds BlobStore+GraphDb per adapter
      graph.ts            Graph queries (getBackrefs, getForwardRefs, …)
      nav.ts              Navigation / TOC helpers
      qualname-page.ts    Qualname page view model
      qualname.ts         Qualname parsing/normalization
      doc-page.ts         Narrative doc page view model
      image-index.ts      Image index builder
      xref.ts             Cross-reference resolver
      render-node.ts      IR node → HTML string helpers
      highlight.ts        Shiki syntax highlighting
      math.ts             KaTeX math rendering
      search.ts           Per-bundle search index
      paths.ts            Path discovery, env overrides
      links.ts            Link helpers
      slugs.ts            URL slug utilities
      auth.ts             Auth helpers
      api-utils.ts        API response helpers
      version-utils.ts    PEP 440 version comparison
      theme.ts            Theme detection
      visibility.ts       Visibility toggle state
      signature.ts        Signature rendering helpers
    components/           Astro + React islands
    pages/                Routes (Astro file-based routing)
      index.astro         Bundle list (home page)
      [pkg]/[ver]/        Per-bundle routes
        index.astro       Bundle overview
        [...slug].astro   Qualname pages
        docs/[...doc].astro  Narrative doc pages
        examples/[...ex].astro  Example pages
        images/           Image index
        nodes/            Node browser
        text-search/      Full-text search
      api/                API endpoints
        bundle.ts         PUT /api/bundle — ingest endpoint
        reingest.ts       POST /api/reingest — replay raw archive
        bundles.json.ts   GET /api/bundles.json — bundle list
        clear.ts, clear-raw.ts, health.json.ts, stats.ts
      admin/              Admin panel (auth-gated)
      login.astro         Login page
    layouts/              BaseLayout, BundleLayout
    styles/               global.css, ir-nodes.css
    middleware.ts         Auth session middleware
  tests/                  Vitest test suite
  wrangler.toml           Cloudflare Workers config (D1 + R2 + KV bindings)
  PLAN.md                 Viewer-specific milestone tracker

examples/                 Example TOML configs for papyri gen
  papyri.toml             Self-gen config (papyri's own docs)
  numpy.toml, scipy.toml, matplotlib.toml, …
docs/                     Project-level documentation (RST)
  IR.md                   IR schema reference
  IR-NODE-AUDIT.md        Node audit log
```

## IR encoding

The IR encoding is **mixed**: some fields use CBOR (`cbor2`), others use JSON.
Do not assume "the IR is JSON". See `node_base.py`, `serde.py`,
`node_serializer.py`. Two serialization paths coexist intentionally:

- `node_serializer.py` — CBOR with internal type tags. Used for most IR nodes.
- `serde.py` — generic dataclass round-trip (JSON or CBOR). Used for config
  and metadata blobs.

The `.papyri` artifact format is a gzip-compressed CBOR-encoded `Bundle` node.
The per-bundle directory (`~/.papyri/data/<pkg>_<ver>/`) contains
`papyri.json` (manifest), `toc.json`, and per-object files under `module/`,
`docs/`, `examples/`, `assets/`.

The **graphstore is a derived cache** — the raw `.papyri.gz` archive stored
at `_raw/<pkg>/<ver>.papyri.gz` is the only authoritative IR. Everything in
the graphstore and blob store is rebuildable via `POST /api/reingest`.

## Known environmental gotchas

- RST parsing uses `py-tree-sitter-rst` (PyPI) on top of `tree-sitter >= 0.24`.
  The parser is constructed via `tree_sitter.Parser(tree_sitter.Language(tree_sitter_rst.language()))`.
  Do not reintroduce `tree_sitter_languages` or `tree-sitter-language-pack`.
- The IR encoding is mixed: some fields use CBOR (`cbor2`), others use JSON.
  Do not assume "the IR is JSON". See `node_base.py`, `serde.py`. The
  encoding is an implementation detail and may change.
- `papyri upload` sends `PUT` (not `POST`) to `/api/bundle`. The viewer's
  CSRF protection requires the `Origin` header to match the upload host; the
  upload CLI sets it automatically. Cloudflare's default bot-protection
  rejects `Python-urllib/3.x`; the CLI sends `papyri-upload/<version>`.
- `better-sqlite3` and `node:fs` must not be reachable from a route compiled
  into the Workers bundle (sync APIs, native bindings). Backend selection
  happens in `viewer/src/lib/backends.ts` via `PAPYRI_ADAPTER` env var.

## Code conventions

- Keep imports lazy inside CLI command functions (the existing pattern).
  `papyri --help` should stay fast.
- `ruff` (lint + format, config in `pyproject.toml` under `[tool.ruff]`) +
  `mypy` are wired in `.github/workflows/lint.yml`. Don't break them.
- No new runtime dependencies without a note in the PR body explaining why.
- `ir-reader.ts` is the designated shock absorber for IR changes — when the
  IR format changes, the fix lands there first, not spread across components.

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `PAPYRI_UPLOAD_URL` | `papyri upload` | Viewer endpoint (default `http://localhost:4321/api/bundle`) |
| `PAPYRI_UPLOAD_TOKEN` | `papyri upload`, viewer | Bearer token for `PUT /api/bundle` |
| `PAPYRI_INGEST_DIR` | viewer (Node mode) | Bundle data root (default `~/.papyri/ingest`) |
| `PAPYRI_INGEST_DB` | viewer (Node mode) | SQLite graph DB (default `~/.papyri/ingest/papyri.db`) |
| `PAPYRI_ADAPTER` | viewer build | `cloudflare` to build for Workers; omit for Node |
| `PAPYRI_USERNAME` / `PAPYRI_PASSWORD` | viewer middleware | Credentials for the session-cookie auth gate |

## Viewer current state (M9 milestones)

- **M9.0–M9.3b complete.** Async storage+graph layer (`BlobStore`/`GraphDb`
  abstractions), Workers bundle upload via `PUT /api/bundle`, raw bundle
  archive (`_raw/<pkg>/<ver>.papyri.gz`), and `POST /api/reingest`.
- **M9.4 open.** CI smoke test against `wrangler dev` + `papyri upload`
  fixture; decide whether Node `pnpm serve` stays as a maintained fallback.
- **M9.5 open.** Cut subrequest count per `PUT /api/bundle` (Workers has a
  per-invocation cap; large bundles currently exceed it).

See `viewer/PLAN.md` for the detailed milestone tracker.

## Handy starting points

- CLI entry: `papyri/__init__.py` (typer app, wires `papyri/cli/*`).
- CLI subcommands: `papyri/cli/gen.py`, `upload.py`, `pack.py`, `find.py`,
  `describe.py`, `diff.py`, `debug.py`, `about.py`, `bootstrap.py`.
- IR gen: `papyri/gen.py`.
- RST→IR visitor + directive handlers: `papyri/tree.py`.
- RST parsing via tree-sitter: `papyri/ts.py`.
- IR node types: `papyri/nodes.py`, `papyri/node_base.py`.
- Cross-link read access: `papyri/crosslink.py`, `papyri/graphstore.py`.
- Ingest engine: `ingest/src/ingest.ts`.
- Storage abstractions: `ingest/src/blob-store.ts`, `ingest/src/graph-db.ts`,
  `ingest/src/raw-store.ts`.
- IR decoder (shock absorber): `viewer/src/lib/ir-reader.ts`.
- Backend selection: `viewer/src/lib/backends.ts`.
- Cross-reference resolution: `viewer/src/lib/xref.ts`.
- Graph queries: `viewer/src/lib/graph.ts`.
- Example TOML configs: `examples/*.toml`.
- DB schema: `ingest/migrations/`.
- Tests (Python): `papyri/tests/`.
- Tests (TS): `ingest/tests/`, `viewer/tests/`.

## Communication

- When a task is ambiguous, read `PLAN.md`, then ask the user. Don't guess
  scope.
- Update `PLAN.md` when you complete an open work item or discover a new
  constraint. Treat `PLAN.md` as a living document.
- Commit messages: imperative mood, explain *why*.
