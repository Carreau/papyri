# Papyri revival plan

Source of truth for scope, ground rules, and out-of-scope lists. Phase
histories have been compacted — check `git log` for the receipts.

## Target shape

Papyri is a **Python IR producer + local graph store** plus an in-tree
web viewer. The viewer lives in [`viewer/`](viewer/) and has its own
[`viewer/PLAN.md`](viewer/PLAN.md). Keeping it in-tree (rather than a
sibling repo) lets us iterate on the IR and its first consumer in one
PR while the format is still in flux; splitting remains an option once
the IR stabilises.

Boundary between the two halves:

- `~/.papyri/data/<pkg>_<ver>/` — per-bundle gen output
  (`papyri.json` + CBOR blobs under `module/`, `docs/`, `examples/`,
  plus `assets/`).
- `~/.papyri/ingest/papyri.db` — SQLite cross-link graph (schema in
  `papyri/graphstore.py`).
- `~/.papyri/ingest/<pkg>/<ver>/` — ingested CBOR blobs + `meta.cbor`
  + `meta/toc.cbor` + copied assets.

Encoding is **CBOR for IR** (via `cbor2`, registered tags in
`papyri/node_base.py`) and **JSON for small config metadata**
(`papyri.json`, `toc.json`). JS consumers need `cbor-x` + a JSON
parser.

## Python version + pins

- `requires-python = ">=3.14"`. CI runs 3.14 only.
- RST parsing uses the PyPI `tree-sitter-rst` wheel on top of
  `tree-sitter >= 0.24`. Don't reintroduce `tree_sitter_languages`.
- `numpy`/`scipy`/`astropy`/`IPython` drift frequently in CI; pin or
  xfail with a reason when they break.

## Status

All prior phases landed; see `git log` for the commits.

- **Phase 0** — banner / install workaround.
- **Phase 1** — big removal PR: `papyri-lab/`, `frontend/`, all
  Python-side renderers (`render.py`, `rich_render.py`, `textual.py`,
  `ipython.py`, `jlab.py`), dead CLI commands (`install`, `browse`,
  `serve`, `serve-static`, `rich`, `textual`, `open`), their deps, and
  the stale 3.14 bump / ruff + mypy wiring.
- **Phase 2** — IR surface: `docs/IR.md` written, CBOR everywhere for
  IR blobs, `papyri describe` shipped, tree-sitter migration done, take2
  / myst_ast circular import resolved, all xfails fixed.
- **Phase 3** — Web viewer under `viewer/`. M0–M6 landed (see
  `viewer/PLAN.md`). CI runs `pnpm check` / `pnpm test` / `pnpm build`
  on `viewer/**`.
- **Rename pass** — most of `TODO-renames.md` done through the R3 / R4
  / R5 / §1 commits; remaining destructive items (§2 `kind`, §3 SQL,
  §4 `RefInfo`/`Key` merge) are tracked there.

## Open

- **Re-publish to PyPI?** Currently install-from-git only. Not
  scheduled.
- **Static export deploy story** for `viewer/dist/`. Cloudflare Pages
  workflow was removed; needs a one-pager replacing it.
- **Cross-package ingest correctness** — `papyri/crosslink.py` still
  has prose TODOs around `Figure.RefInfo.version` populated at walk
  time vs serialisation time, and a stale `assert len(visitor.local)
  == 0` that would need a gen-time pre-pass to re-enable. See
  `TODO-review.md`.
- **Global cross-bundle search** for the viewer. Per-bundle manifest
  exists today.
- **Dark-adapted Shiki theme** + dark-mode-aware KaTeX glyphs.
- **`TODO-renames.md`** destructive items (§2 / §3 / §4) — each needs
  its own PR and a "re-ingest required" note.

## Out of scope (do not revive)

- `papyri.ipython` `?` extension.
- URWID `browse`.
- JupyterLab extension (`papyri-lab`).
- Remote bundle download (`pydocs.github.io/pkg`).
- Any Python-side HTML / terminal / TUI renderer. The viewer under
  `viewer/` is TypeScript-only and reads the IR directly.
