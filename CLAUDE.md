# Instructions for Claude (or any agent) working on this repo

Read `PLAN.md` first. It's the scope + out-of-scope source of truth; if
anything here contradicts it, `PLAN.md` wins.

## Repo purpose, short version

Papyri parses Python library docstrings into an **intermediate
representation (IR)**, ingests many libraries' IR into a local
cross-linked graph, and renders the result via an in-tree web viewer
under `viewer/`. **All Python-side renderers have been removed.** Do
not add Python rendering code and do not revive `render.py`,
`rich_render.py`, `textual.py`, `ipython.py`, `jlab.py`, or the
`install`/`browse`/`serve` CLI commands.

## Ground rules

1. **Stay inside scope.** If a task touches anything in `PLAN.md`'s
   "Out of scope" list, stop and ask.
2. **Small focused PRs.** One logical change per commit. Destructive
   schema/format migrations get their own PR with a "re-ingest required"
   note in the body.
3. **Delete dangling refs, don't revive features.** Stale references to
   removed modules or CLI commands should be cleaned up, not restored.
4. **Python 3.14+ only.** `requires-python = ">=3.14"`. No compat
   shims for older versions.
5. **Verify before committing.** At minimum:
   ```
   python -m ruff check papyri
   python -m ruff format --check papyri
   mypy papyri
   python -m pytest -m "not postingest"
   ```
   For viewer-touching changes, also run `pnpm check && pnpm test` in
   `viewer/`. Structural changes: `pnpm build` too.

   Run `python -m pytest` (not bare `pytest`) so the editable install's
   interpreter is used. If `papyri.db` complains about schema, `rm -rf
   ~/.papyri/ingest/` and re-ingest.
6. **Do not commit anything under `~/.papyri/`.** It's user data.

## Known environmental gotchas

- RST parsing uses the PyPI `tree-sitter-rst` wheel on top of
  `tree-sitter >= 0.24`. Don't re-add `tree_sitter_languages`.
- The IR uses **CBOR** (`cbor2`) for node graphs and **JSON** only for
  small bundle metadata (`papyri.json`, `toc.json`). Don't assume "the
  IR is JSON".

## Code conventions

- Keep CLI imports lazy so `papyri --help` stays fast.
- `ruff` (lint + format) + `mypy` are wired in
  `.github/workflows/lint.yml`. Don't break them — the hook at CI level
  is unforgiving on import-order drift after renames.
- No new runtime dependencies without a one-line justification in the
  PR body.

## Handy starting points

- CLI entry: `papyri/__init__.py` (typer app).
- IR gen: `papyri/gen.py`.
- Cross-link / ingest: `papyri/crosslink.py`, `papyri/graphstore.py`.
- Node classes + CBOR tag registry: `papyri/nodes.py`, `papyri/node_base.py`.
- Serde: `papyri/serde.py` (internally-tagged JSON),
  `papyri/node_serializer.py` (the externally-tagged variant).
- RST parsing: `papyri/ts.py`, `papyri/tree.py`, `papyri/numpydoc_compat.py`.
- Example TOML configs: `examples/*.toml`.
- Tests: `papyri/tests/`.

## Communication

- When a task is ambiguous, read `PLAN.md`, then ask. Don't guess scope.
- Update `PLAN.md` / `viewer/PLAN.md` when you discover a new constraint
  or finish something that was tracked there. Treat them as living docs.
- Commit messages: imperative mood, explain *why*. Reference the phase
  or `TODO-renames.md` item number when relevant.
