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
the rendering side. It is used for development and debugging, **not** as the
production central service — that is the long-term goal. The architecture is
intentionally shaped to support a future hosted service.

## Repo purpose, short version

- **`papyri gen`**: run per project, by each library maintainer in their own
  CI or build environment. Produces a self-contained DocBundle.
- **`papyri ingest`**: run by the central service (or locally for dev) to
  wire multiple bundles into a cross-linked graph.
- **`viewer/`**: TypeScript/Astro renderer. Works locally for development
  today, and is being designed with the centralized service in mind — it is
  the intended rendering frontend, not just a debug tool. When building the
  viewer, think about what the hosted service will need.
- All Python-side rendering has been removed. Do not add it back.

## Audience

- **Right now**: contributors to papyri itself.
- **Eventually**: Python library maintainers who publish DocBundles to a
  central service.

When writing docs, code, or CLI help text, speak to contributors first.
Don't design features for the hosted service yet — design so that a hosted
service *could* be built later without a breaking change to the IR.

## Ground rules for changes

1. **Stay inside scope.** Before adding or fixing anything, check `PLAN.md`.
   If a task touches something in the "Out of scope" list, stop and ask the
   user.
2. **Small focused PRs.** One logical change per commit.
3. **Don't re-add removed features.** Dangling references to `render.py`,
   `rich_render`, `textual`, `ipython`, `jlab`, `install`, `browse`, `serve`,
   or the JupyterLab extension should be deleted, not restored.
4. **Python 3.14+ only.** `requires-python = ">=3.14"`. No compat shims for
   older versions.
5. **Verify locally before committing.** At minimum:
   ```
   pip install -e .
   papyri gen examples/papyri.toml --no-infer
   papyri ingest ~/.papyri/data/cbor/papyri_<version>
   python -m pytest -m "not postingest"
   ```
   Run `python -m pytest` (not bare `pytest`) so the editable install's
   interpreter is used. If `papyri.db` complains about schema, `rm -rf
   ~/.papyri/ingest/` and re-ingest.
6. **Do not commit anything under `~/.papyri/`.** That's user data, not
   repo content.
7. **Viewer design should anticipate the hosted service.** When working on
   `viewer/`, consider what a centralized multi-bundle service will need (URL
   structure, bundle switching, cross-package search). Don't add server
   infrastructure, auth, or upload endpoints yet — but don't make design
   choices that would require a rewrite when those land.

## Known environmental gotchas

- RST parsing uses `tree-sitter-language-pack` (the maintained successor
  of the abandoned `tree_sitter_languages`) on top of `tree-sitter >= 0.24`.
  Get the parser via `get_parser("rst")`. Don't re-add `tree_sitter_languages`.
- `test_take2.py` has a `take2` ↔ `myst_ast` circular import that only
  manifests when collected in isolation (`pytest papyri/tests/test_take2.py`).
  The full-module collection path hides it.
- The IR uses **CBOR** (`cbor2`) in some places and JSON in others. Do not
  assume "the IR is JSON". See `graphstore.py`, `crosslink.py`,
  `node_base.py`, `take2.py`.

## Code conventions

- Keep imports lazy inside CLI command functions (the existing pattern).
  `papyri --help` should stay fast.
- `ruff` (lint + format, config in `pyproject.toml` under `[tool.ruff]`) +
  `mypy` are wired in `.github/workflows/lint.yml`. Don't break them.
- No new runtime dependencies without a note in the PR body explaining why.

## Handy starting points

- CLI entry: `papyri/__init__.py` (typer app).
- IR gen: `papyri/gen.py`.
- Cross-link / ingest: `papyri/crosslink.py`, `papyri/graphstore.py`.
- RST parsing via tree-sitter: `papyri/ts.py`, `papyri/tree.py`.
- Example TOML configs: `examples/*.toml`.
- Tests: `papyri/tests/`.

## Communication

- When a task is ambiguous, read `PLAN.md`, then ask the user. Don't guess
  scope.
- Update `PLAN.md` when you finish a phase item (check the box) or discover
  a new constraint. Treat `PLAN.md` as a living document.
- Commit messages: imperative mood, explain *why*. Reference the phase from
  `PLAN.md` if relevant (e.g. "Phase 1: remove HTML renderer").
