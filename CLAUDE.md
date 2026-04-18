# Instructions for Claude (or any agent) working on this repo

Read `PLAN.md` first. It is the agreed scope and roadmap. If anything here
contradicts `PLAN.md`, `PLAN.md` wins.

## Repo purpose, short version

Papyri parses Python library docstrings into an **intermediate
representation (IR)**, ingests many libraries' IR into a local cross-linked
graph, and historically rendered that graph to HTML/terminal/TUI.

**We are intentionally narrowing the scope** to "Python producer of IR +
local graph store", plus a TypeScript/Astro web viewer under `viewer/`
that reads the IR directly. All Python-side rendering has been removed.
Do not add Python rendering code and do not try to revive the deleted
renderers — the replacement lives under `viewer/` and has its own
`viewer/PLAN.md`.

## Ground rules for changes

1. **Stay inside scope.** Before adding or fixing anything, check `PLAN.md`.
   If a task touches something in the "Out of scope" list, stop and ask the
   user.
2. **Small focused PRs.** One logical change per commit. Phase 1 is a
   deliberate single big removal PR; after that, keep diffs minimal.
3. **Don't re-add removed features.** If you find a dangling reference to
   `render.py`, `rich_render`, `textual`, `ipython`, `jlab`, `install`,
   `browse`, `serve`, or the JupyterLab extension, delete the reference,
   don't restore the feature.
4. **Python 3.14+ only.** `requires-python = ">=3.14"`. Don't add
   conditional compat code for older Pythons.
5. **Verify locally before committing.** At minimum:
   ```
   pip install -e .
   pip install 'tree-sitter<0.22'   # until we migrate off tree_sitter_languages
   papyri gen examples/papyri.toml --no-infer
   papyri ingest ~/.papyri/data/papyri_<version>
   python -m pytest -m "not postingest"
   ```
   Run `python -m pytest` (not bare `pytest`) so the editable install's
   interpreter is used. If `papyri.db` complains about schema, `rm -rf
   ~/.papyri/ingest/` and re-ingest.
6. **Do not commit anything under `~/.papyri/`.** That's user data, not
   repo content.

## Known environmental gotchas

- `tree_sitter_languages 1.10.2` crashes on import against
  `tree-sitter >= 0.22` (`TypeError: __init__() takes exactly 1 argument
  (2 given)` at `papyri/ts.py:47`). Pin or migrate; don't paper over.
- `test_take2.py` has a `take2` ↔ `myst_ast` circular import that only
  manifests when collected in isolation (`pytest papyri/tests/test_take2.py`).
  The full-module collection path hides it.
- The IR uses **CBOR** (`cbor2`) in some places and JSON in others. Do not
  assume "the IR is JSON". See `graphstore.py`, `crosslink.py`,
  `common_ast.py`, `take2.py`.

## Code conventions

- Keep imports lazy inside CLI command functions (the existing pattern).
  `papyri --help` should stay fast.
- `ruff` (lint + format, config in `pyproject.toml` under `[tool.ruff]`) +
  `mypy` are wired in `.github/workflows/lint.yml`. Don't break them.
- No new runtime dependencies without a note in the PR body explaining
  why. Phase 1 is about removing deps, not adding them.

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
- Update `PLAN.md` when you finish a phase item (check the box) or
  discover a new constraint. Treat `PLAN.md` as a living document.
- Commit messages: imperative mood, explain *why*. Reference the phase
  from `PLAN.md` if relevant (e.g. "Phase 1: remove HTML renderer").
