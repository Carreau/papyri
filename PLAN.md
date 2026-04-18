# Papyri revival plan

This document captures the agreed scope and ordered work for bringing papyri
back to a maintainable state. Future sessions (human or agent) should treat
this as the source of truth; check items off and update the "Open questions"
section as answers arrive.

## Target shape

Papyri is a **Python IR producer + local graph store**, plus an in-tree web
viewer that reads the IR directly. The viewer lives in [`viewer/`](viewer/)
and has its own [`viewer/PLAN.md`](viewer/PLAN.md) — consult that for
viewer-specific scope, milestones, and tech choices.

Rationale for keeping the viewer in-tree (revised from the original plan,
which punted rendering to a separate repo): the IR is still in heavy
development and Phase 2 hasn't stabilized it yet. Co-locating the IR
producer and its first consumer lets us iterate on both in a single PR
instead of juggling two repos across breaking changes. Splitting into a
sibling repo remains an option once the IR schema is documented and stable.

The boundary between the two halves:

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

- [x] Delete everything in "Scope cuts" above in a single PR.
- [x] Trim `papyri/__init__.py` of dead CLI commands and their imports.
- [x] Trim `pyproject.toml` and `requirements.txt` dependencies to match.
      Note: `rich` is retained because `papyri/gen.py`, `papyri/crosslink.py`,
      `papyri/miscs.py`, and `papyri/utils.py` use `rich.progress` /
      `rich.logging` in the core pipeline (not as a docstring renderer).
      Stripping it is a bigger refactor and is not required for Phase 1.
- [x] Pin `tree-sitter < 0.22` in `pyproject.toml`.
- [x] Bump `requires-python` to `>=3.14`; update CI to 3.14.
- [x] Update the linter workflow (`lint.yml`) to 3.14 and keep
      `black` + `flake8` + `mypy`. (Later migrated to `ruff` + `mypy`.)
- [x] Verify `papyri gen examples/papyri.toml --no-infer` and
      `papyri ingest ~/.papyri/data/papyri_<ver>` still work end-to-end.
      (Verified locally on 3.11 via `--ignore-requires-python`; CI on
      3.14 is the source of truth.)
- [x] Update README to remove references to deleted commands and reflect
      the new scope.

### Phase 2 — IR surface stabilization

- [ ] Document the IR format in `docs/IR.md`: on-disk layout, JSON schema
      per file type, CBOR-encoded fields, `graphstore` SQLite schema.
- [x] Decide whether to move everything to a single encoding (all JSON, or
      all CBOR) vs documenting the hybrid. Done: CBOR everywhere for IR
      (gen bundle + ingest store); `papyri.json` / `toc.json` remain JSON
      because they're small configuration metadata, not IR.
- [ ] Add a `papyri describe <qualname>` (or reuse `find`) as a
      maintainer-side debug command that prints an IR entry without a
      renderer.
- [ ] Replace `tree_sitter_languages` with direct `tree-sitter-rst` +
      `tree-sitter-python`.
- [x] Fix circular import between `papyri/take2.py` and `papyri/myst_ast.py`
      so tests collect cleanly in isolation. Done by merging `myst_ast.py`
      into `take2.py`; M-prefixed classes still exist pending a rename pass.
- [x] Resolve or xfail the known test failures. Currently xfailed
      (`strict=False`, with reasons pointing back here):
      - `test_nodes.py::test_parse_blocks[numpy.linspace…]` — numpy
        docstring drifted, now emits 1 `UnprocessedDirective` instead of 2.
      - `test_gen.py::test_numpy[numpy…]` — numpy 2.x moved the canonical
        path for `numpy:array`.
      - `test_gen.py::test_self_2` — `papyri/__init__.py` module docstring
        was rewritten in Phase 1 and no longer has the definition list this
        test indexes into; needs rewriting against the new docstring or
        repointing at another module.
      Follow-up: replace these xfails with real fixes (pin numpy in the
      test matrix, rewrite the self-doc test).

### Phase 3 — Web viewer (in-tree under `viewer/`)

Tracked in [`viewer/PLAN.md`](viewer/PLAN.md). Summary:

- Lives in `viewer/` as an Astro + React + TypeScript app (see
  `viewer/PLAN.md` for the tech rationale).
- Reads the IR directly from `~/.papyri/data/…` and the SQLite graph; no
  new intermediate format.
- Milestones: M0 scaffolding (bundle list) → M1 single-page render → M2
  crosslinks + backrefs → M3 examples/math/highlighting → M4 static export
  → M5 polish.
- Originally planned as a separate sibling repo; now in-tree while the IR
  is still in flux. Splitting out remains an option once the IR schema
  stabilizes in Phase 2.

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
- Any Python-side HTML, terminal, or TUI renderer. The web viewer under
  `viewer/` is TypeScript-only and reads the IR directly; do not add
  Python rendering code to replace it.
