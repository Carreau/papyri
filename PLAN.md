# Papyri revival plan

This document captures the agreed scope and ordered work for bringing papyri
back to a maintainable state. Future sessions (human or agent) should treat
this as the source of truth; check items off and update the "Open questions"
section as answers arrive.

## Target shape

Papyri becomes a **Python IR producer + local graph store**, nothing more.
Rendering is punted to a future separate Node/React project that reads the
IR directly. The boundary is:

- `~/.papyri/data/<pkg>_<ver>/` — per-bundle IR (JSON + CBOR blobs,
  `papyri.json`, `toc.json`, `module/*.json`, `docs/`, `examples/`,
  `assets/`).
- `~/.papyri/ingest/papyri.db` — SQLite cross-link graph (schema in
  `papyri/graphstore.py`).

**Note:** the on-disk format is not pure JSON. `graphstore.py`,
`crosslink.py`, `common_ast.py`, and `take2.py` encode parts of the IR using
CBOR via the `cbor2` package. Any future JS consumer needs a CBOR library
(e.g. `cbor-x`) in addition to JSON parsing. Documenting and, if feasible,
converging on a single encoding is part of Phase 2.

## Scope cuts (to land as one big removal PR)

Everything below is out of scope and should be deleted outright. Future
sessions should not restore any of it.

### Directories to delete

- `papyri-lab/` — JupyterLab extension (separate Python + TypeScript
  scaffold).
- `frontend/` — stale 2023 React/craco scaffold that built into
  `papyri/app/`.
- `papyri/templates/` — Jinja templates used only by the Python HTML
  renderer.
- `papyri/static/` — MathJax + fontawesome bundled for the Python HTML
  renderer.
- `papyri/app/` — baked React build output from `frontend/`.
- `.github/workflows/papyri-lab-build.yml`.

### Files to delete

- `papyri/render.py` — ~53 KB HTML/ASCII renderer.
- `papyri/rich_render.py` — `rich` terminal renderer.
- `papyri/textual.py` — textual TUI renderer.
- `papyri/ipython.py` — IPython `?` extension.
- `papyri/jlab.py` — JupyterLab hook.

### CLI commands to remove (in `papyri/__init__.py`)

- `install` (remote bundle download from `pydocs.github.io/pkg`).
- `browse` (URWID — already dead-on-import; `papyri/browser.py` doesn't
  exist).
- `serve`, `serve-static` (Quart-trio live + static HTTP server).
- `rich`, `textual` (terminal renderers).
- `open` (webbrowser helper).

### Dependencies that should drop out of `pyproject.toml`

- `quart`, `quart-trio`, `hypercorn`, `httpx`, `trio` (remote install + live
  serve).
- `rich`, `textual` (terminal renderers).
- `jinja2`, `minify_html`, `flatlatex` (HTML rendering).
- `emoji` (used only in renderers — verify).
- `matplotlib`, `pygments`, `ipython` — **verify** before dropping; some may
  be needed by `gen` for example-execution and syntax highlighting in the
  IR. Audit each before removing.
- `tree-sitter-builds` — unused alongside `tree_sitter_languages`.

### Requirements files

- `requirements.txt` has a stray `there` package; drop it and sync the file
  with the trimmed `pyproject.toml`.

## Python version

- Minimum: **Python 3.14**. `requires-python = ">=3.14"`.
- CI matrix: `3.14` only to start. Add newer versions later; don't carry
  legacy ones.
- Local dev may only have 3.13 in some environments; CI is the source of
  truth for "does it work on 3.14".

## Dependency pins

- `tree_sitter_languages 1.10.2` is broken against `tree-sitter >= 0.22`
  because the `Language(ptr, name)` API changed. Either:
  1. Pin `tree-sitter < 0.22` (quick fix; `tree_sitter_languages` is
     unmaintained).
  2. **Preferred:** migrate to `tree-sitter-rst` from PyPI (actively
     maintained) and drop `tree_sitter_languages` entirely.
- `numpy`, `scipy`, `astropy`, `IPython` in the CI matrix drift frequently;
  the current numpy test failure is a canonical-path change for
  `numpy:array`. Either xfail with a reason or pin each matrix entry to a
  known-good version.

## Ordered phases

### Phase 0 — landed

- [x] README: current-state banner, known breakage, install workaround.

### Phase 1 — scope cuts and baseline

- [ ] Delete everything in "Scope cuts" above in a single PR.
- [ ] Trim `papyri/__init__.py` of dead CLI commands and their imports.
- [ ] Trim `pyproject.toml` and `requirements.txt` dependencies to match.
- [ ] Pin `tree-sitter < 0.22` in `pyproject.toml`.
- [ ] Bump `requires-python` to `>=3.14`; update CI to 3.14.
- [ ] Update the linter workflow (`lint.yml`) to 3.14 and keep
      `black` + `flake8` + `mypy`.
- [ ] Verify `papyri gen examples/papyri.toml --no-infer` and
      `papyri ingest ~/.papyri/data/papyri_<ver>` still work end-to-end.
- [ ] Update README to remove references to deleted commands and reflect
      the new scope.

### Phase 2 — IR surface stabilization

- [ ] Document the IR format in `docs/IR.md`: on-disk layout, JSON schema
      per file type, CBOR-encoded fields, `graphstore` SQLite schema.
- [ ] Decide whether to move everything to a single encoding (all JSON, or
      all CBOR) vs documenting the hybrid.
- [ ] Add a `papyri describe <qualname>` (or reuse `find`) as a
      maintainer-side debug command that prints an IR entry without a
      renderer.
- [ ] Replace `tree_sitter_languages` with direct `tree-sitter-rst` +
      `tree-sitter-python`.
- [ ] Fix circular import between `papyri/take2.py` and `papyri/myst_ast.py`
      so tests collect cleanly in isolation.
- [ ] Resolve or xfail the two known test failures
      (`test_take2.py::test_parse_blocks[numpy.linspace…]`,
      `test_gen.py::test_numpy[numpy…]`).

### Phase 3 — Node/React renderer (separate project)

- Not in this repo. Track it in a sibling repo that depends on the IR
  format documented in Phase 2.
- Minimum viable: list of pages, page detail, cross-references,
  backreferences. Read IR directly from `~/.papyri/data/…` and the SQLite
  graph.

## Open questions

- Do we keep `papyri install` as a thin "unzip a local bundle" command
  (since `papyri ingest` already takes directories), or delete it
  entirely? **Current decision: delete.**
- Do we want to re-publish to PyPI under a new version once Phase 1 is
  done, or keep it as "install from git" only for the foreseeable future?
- URL / ownership: `pyproject.toml` still has `Home =
  "https://github.com/Jupyter/papyri"`. Update to `carreau/papyri` as part
  of Phase 1.

## Out of scope (do not revive)

- `papyri.ipython` `?` extension.
- URWID `browse`.
- JupyterLab extension (`papyri-lab`).
- Remote bundle download (`pydocs.github.io/pkg`).
- Any Python-side HTML, terminal, or TUI renderer.
