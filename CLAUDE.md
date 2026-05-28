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
designed with the centralized service in mind. The hosted service runs as a
long-running Node.js server on a VPS. The storage layer is kept behind
abstractions (`BlobStore` / `GraphDb` / `RawStore`) so the backend can be
swapped later, but only the filesystem + SQLite implementations exist. An
earlier Cloudflare Workers (R2 + D1) target was abandoned because ingest
latency on it was far too high.

## Repo purpose, short version

- **`papyri gen`**: run per project, by each library maintainer in their own
  CI or build environment. Produces a self-contained DocBundle directory under
  `~/.papyri/data/<pkg>_<ver>/`.
- **`papyri pack`**: packs a DocBundle directory into a `.papyri` artifact
  (gzip-compressed CBOR). The artifact is the canonical shipping unit.
  `papyri unpack` is the inverse — it explodes a `.papyri` artifact back into
  a JSON DocBundle directory for inspection.
- **`papyri upload`**: ships a `.papyri` file, a `.zip` containing one, or a
  DocBundle directory to a viewer instance whose `/api/admin/bundle` endpoint
  (HTTP `PUT`) runs the TypeScript ingest pipeline server-side to wire bundles
  into the cross-linked graph. Auth: `$PAPYRI_UPLOAD_TOKEN` / `--token`;
  endpoint: `$PAPYRI_UPLOAD_URL` / `--url` (default
  `http://localhost:4321/api/admin/bundle`).
- **`ingest/`**: TypeScript `papyri-ingest` package — the canonical
  ingestion engine, invoked by the viewer's upload endpoint. There is no
  `papyri ingest` Python CLI; do not add one.
- **`viewer/`**: TypeScript web renderer (Astro + React islands). Runs as a
  long-running Node.js server (`@astrojs/node`, `output: "server"`) for both
  local dev (`pnpm dev`) and the hosted VPS deployment (`pnpm build` + `pnpm
  serve`). When building the viewer, think about what the hosted service will
  need.
- There is no Python-side rendering. Do not add any.

## Audience

- **Right now**: contributors to papyri itself.
- **Eventually**: Python library maintainers who publish DocBundles to a
  central service.

When writing docs, code, or CLI help text, speak to contributors first.
Don't design features for the hosted service yet — design so that a hosted
service *could* be built later without a breaking change to the IR.

## Ground rules for changes

0. **Pre-production: prefer deleting dead code over keeping it.** Nothing here
   is shipped to real users yet, there are no published bundles or external
   consumers to keep compatible, and we rebuild everything from the raw
   archives when the IR changes (see "Storage invariant" in `PLAN.md`). So when
   a change makes code, a CBOR tag, a schema entry, a render branch, or a CSS
   block unreachable, **delete it** rather than leaving it for
   backwards-compatibility. Don't add compat shims, legacy-format readers, or
   "just in case" fallbacks for old data — there is no old data that matters.
1. **Stay inside scope.** Before adding or fixing anything, check `PLAN.md`.
   If a task is not in the open work or follow-ups, stop and ask the user.
2. **Small focused PRs.** One logical change per commit.
3. **Don't add Python-side rendering, a `papyri ingest` CLI, or the
   JupyterLab extension.** Dangling references to `render.py`, `rich_render`,
   `textual`, `ipython`, `jlab`, `install`, `browse`, or `serve` should be
   deleted, not restored.
4. **Python 3.13+.** `requires-python = ">=3.13"`. CI runs on 3.14.
   Don't add shims for anything older than 3.13.
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
6. **Enable the pre-commit hook — required before your first commit.**
   The repo ships `.pre-commit-config.yaml` that runs every linter and
   formatter listed below automatically on `git commit`. Run this **once
   per clone** (or at the start of every session) before you make any
   commits:
   ```
   pre-commit install
   ```
   Without this step the hook is not wired into `.git/hooks/pre-commit`
   and nothing stops an unformatted commit from reaching CI.
   **Never bypass it with `--no-verify`.**

   The hook covers: ruff format + lint (Python), mypy (Python),
   Prettier + ESLint + tsc type-check (viewer and ingest).

   If a hook auto-fixes files (ruff, Prettier), re-stage those files and
   run `git commit` again — the hook passes once all files are clean.

   To run the checks manually without committing:
   ```
   pre-commit run --all-files
   ```

   For reference, the individual commands are:

   **Python** (always, even for viewer-only changes):
   ```
   ruff format papyri/
   ruff check papyri/
   mypy papyri/
   ```

   **Viewer** (when `viewer/` files changed):
   ```
   cd viewer
   pnpm install --frozen-lockfile   # only needed once / after lockfile changes
   pnpm run format                  # Prettier — rewrites files in place
   pnpm run lint                    # ESLint — fix any errors (warnings are OK)
   pnpm run check                   # TS type check — must report 0 errors
   ```

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
   layers stay abstracted behind the `BlobStore` / `GraphDb` / `RawStore`
   interfaces (in `ingest/src/`) so the backend can be swapped later, but the
   only implementations today are the filesystem + SQLite ones
   (`FsBlobStore` / `SqliteGraphDb` / `FsRawStore`).

## Repository layout

```
papyri/                   Python package (IR producer + CLI)
  __init__.py             CLI entry (typer app), wires commands from cli/
  cli/                    One file per subcommand: gen, upload, pack, unpack,
                          find, describe, diff, debug, about, bootstrap
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
    bundle.ts             Bundle Node validation (assertBundle)
    keys.ts               Key tuple (module/version/kind/path) + keyStr
    graph-db.ts           GraphDb interface + SqliteGraphDb
    blob-store.ts         BlobStore interface + FsBlobStore
    raw-store.ts          RawStore interface + FsRawStore
    inventory.ts          Intersphinx objects.inv parser (link to non-papyri projects)
  migrations/             SQL schema applied to the SQLite graph DB

viewer/                   TypeScript Astro web renderer
  src/
    lib/
      ir-reader.ts        Decode blobs → typed IR (shock absorber for IR changes)
      ir-types.ts         TypeScript types mirroring IR node shapes
      ir-schema.ts        Auto-generated IR field/type schema (drives IR-stats panel)
      backends.ts         getBackends() — builds BlobStore+GraphDb per adapter
      graph.ts            Graph queries (getBackrefs, getForwardRefs, …)
      bundle-walk.ts      Shared bundle traversal (walkBundle/walkAllBundles)
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
    pages/                Routes (Astro file-based routing). Layout is
                          URL-aligned with the admin/docs split: docs-
                          surface routes live at the root, admin-surface
                          routes live under `admin/` and `api/admin/`.
      index.astro         Bundle list (docs home)
      project/[pkg]/[ver]/  Per-bundle routes (docs)
        index.astro       Bundle overview
        [...slug].astro   Qualname pages
        docs/[...doc].astro  Narrative doc pages
        examples/[...ex].astro  Example pages
        images/           Image index
        nodes/            Per-bundle node browser
        text-search/      Per-bundle full-text search
      text-search/        Cross-bundle full-text search (docs)
      admin/              Admin surface (host-gated by middleware)
        index.astro       Admin dashboard
        login.astro       Login page
        nodes/            Global node browser
        ir-stats/         IR statistics dashboard
      api/                API endpoints
        bundles.json.ts   GET /api/bundles.json — bundle list (docs)
        search.json.ts    GET /api/search.json — qualname search (docs)
        text-search.json.ts  GET /api/text-search.json — fulltext (docs)
        health.json.ts    GET /api/health.json — health check (docs)
        [pkg]/[ver]/      Per-bundle data: nodes, raw, text-search (docs)
        admin/            Admin-surface APIs (host-gated)
          bundle.ts       PUT /api/admin/bundle — ingest endpoint
          reingest.ts     POST /api/admin/reingest — replay raw archive
          clear.ts, clear-raw.ts, stats.ts
          inventory.ts    Intersphinx inventory register/list
          nodes.json.ts, ir-stats.json.ts
          auth/login.ts, auth/logout.ts  Session login/logout
    layouts/              BaseLayout, BundleLayout
    styles/               global.css, ir-nodes.css
    middleware.ts         Auth session middleware
  tests/                  Vitest test suite
  PLAN.md                 Viewer-specific milestone tracker

examples/                 Example TOML configs for papyri gen
  papyri.toml             Self-gen config (papyri's own docs)
  numpy.toml, scipy.toml, matplotlib.toml, …
docs/                     Project-level documentation (RST)
  IR.md                   IR schema reference
  IR-NODE-AUDIT.md        Node audit log
```

## IR encoding

The **bundle directory** (`~/.papyri/data/<pkg>_<ver>/`) is a human-readable
staging area written by `papyri gen`. Keep it JSON — it is inspectable with
any text editor and `papyri debug`. Contents:
- `papyri.json` — manifest (JSON).
- `toc.json` — list of `TocTree` nodes (JSON, absent when empty).
- `module/<qa>.json` — one `GeneratedDoc` per API object (JSON).
- `docs/<name>` — `GeneratedDoc` per narrative page (JSON, no suffix).
- `examples/<name>` — `Section` per example (JSON, no suffix).
- `assets/<name>` — binary assets, stored as-is.

The **`.papyri` artifact** (output of `papyri pack`) is a single
gzip-compressed CBOR-encoded `Bundle` node — CBOR starts here, not before.
Do not add JSON serialization to the artifact or the ingest/viewer layers.
See `node_base.py`, `node_serializer.py`, `pack.py`.

The **graphstore is a derived cache** — the raw `.papyri.gz` archive stored
at `_raw/<pkg>/<ver>.papyri.gz` is the only authoritative IR. Everything in
the graphstore and blob store is rebuildable via `POST /api/admin/reingest`.

## Known environmental gotchas

- RST parsing uses `py-tree-sitter-rst` (PyPI) on top of `tree-sitter >= 0.24`.
  The parser is constructed via `tree_sitter.Parser(tree_sitter.Language(tree_sitter_rst.language()))`.
  Do not reintroduce `tree_sitter_languages` or `tree-sitter-language-pack`.
- The bundle directory (`papyri gen` output) is JSON — intentionally
  human-readable. CBOR starts at `papyri pack`. Do not write CBOR into the
  bundle directory, and do not write JSON into the `.papyri` artifact or
  the ingest/viewer layers.
- `papyri upload` sends `PUT` (not `POST`) to `/api/admin/bundle`. The upload CLI
  sets an `Origin` header matching the upload host (defensive — Astro's
  `checkOrigin` is disabled in `astro.config.mjs`, since the endpoint carries
  its own bearer-token check). Some reverse proxies / WAFs reject
  `Python-urllib/3.x`, so the CLI sends `papyri-upload/<version>` instead.
- Storage backends are chosen in `viewer/src/lib/backends.ts`. Only the
  filesystem + SQLite implementations exist (`FsBlobStore` / `SqliteGraphDb` /
  `FsRawStore`); the `BlobStore` / `GraphDb` / `RawStore` interfaces are kept
  so a different backend can be added later without touching the viewer.

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
| `PAPYRI_UPLOAD_URL` | `papyri upload` | Viewer endpoint (default `http://localhost:4321/api/admin/bundle`) |
| `PAPYRI_UPLOAD_TOKEN` | `papyri upload`, viewer | Bearer token for `PUT /api/admin/bundle` |
| `PAPYRI_INGEST_DIR` | viewer | Bundle data root (default `~/.papyri/ingest`) |
| `PAPYRI_INGEST_DB` | viewer | SQLite graph DB (default `~/.papyri/ingest/papyri.db`) |
| `PAPYRI_SITE` | viewer build | Canonical external origin for canonical-URL generation behind a reverse proxy. With the admin/docs domain split enabled, set to `https://$PAPYRI_DOCS_HOST` |
| `PAPYRI_DOCS_HOST` | viewer middleware | External hostname of the docs (read-only) surface, e.g. `docs.example.com`. Optional — setting either `PAPYRI_DOCS_HOST` or `PAPYRI_ADMIN_HOST` turns on the host-based gating in `src/middleware.ts` |
| `PAPYRI_ADMIN_HOST` | viewer middleware | External hostname of the admin surface (login, upload, all mutating endpoints), e.g. `admin.example.com`. Optional; same gating switch as above |
| `PAPYRI_USERNAME` / `PAPYRI_PASSWORD` | viewer middleware | Credentials for the session-cookie auth gate |
| `PAPYRI_VERSION` | `papyri upload` | Overrides the `papyri-upload/<version>` User-Agent string |
| `PAPYRI_BUILD_COMMIT` | viewer build | Git commit surfaced on the admin panel |
| `PAPYRI_BUILD_ADAPTER` | viewer build | Build adapter name surfaced on the admin panel |

## Viewer current state

The viewer runs as a long-running Node.js server (`@astrojs/node`,
`output: "server"`) on a VPS. Complete: async storage+graph layer
(`BlobStore` / `GraphDb` / `RawStore` abstractions, filesystem + SQLite
implementations), in-process bundle upload via `PUT /api/admin/bundle`, raw
bundle archive (`_raw/<pkg>/<ver>.papyri.gz`), and `POST /api/admin/reingest`.

The earlier Cloudflare Workers (R2 + D1) target was abandoned — ingest latency
on it was far too high (per-object subrequest fan-out against the Workers cap;
see `viewer/PLAN.md`). The storage abstractions are kept so a backend swap
stays possible, but there is no Cloudflare adapter, `wrangler.toml`, or
`build:cf` target anymore.

See `viewer/PLAN.md` for the detailed milestone tracker.

## Handy starting points

- CLI entry: `papyri/__init__.py` (typer app, wires `papyri/cli/*`).
- CLI subcommands: `papyri/cli/gen.py`, `upload.py`, `pack.py`, `unpack.py`,
  `find.py`, `describe.py`, `diff.py`, `debug.py`, `about.py`, `bootstrap.py`.
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
- PR descriptions: be concise. Two to four bullet points covering what
  changed and why. Do not describe how you verified the change — that is
  CI's job. No "I ran X and saw Y" narratives.
