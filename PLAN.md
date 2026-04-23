# Papyri plan

This document captures the agreed scope and ordered work. Future sessions
(human or agent) should treat this as the source of truth; check items off
and update the "Open questions" section as answers arrive.

## Why this project exists

Two specific problems in the Python documentation ecosystem:

**Problem 1 — Sphinx couples building and rendering.**
Updating an HTML template (e.g. for accessibility) requires a full rebuild
from source. Papyri separates IR *generation* (run once by the maintainer)
from *rendering* (stateless, redoable against the saved IR).

**Problem 2 — Documentation is fragmented across domains.**
Every library lives on its own subdomain with no real cross-linking.
Papyri's model (conda-forge style): maintainers publish DocBundles; a single
rendering service ingests many and serves them from one place.

## Target shape

- **`papyri gen`**: run per project, by each library maintainer in their own
  CI or build environment. Produces a self-contained DocBundle and uploads it.
- **`papyri ingest`**: run by the central service (or locally for dev) to
  wire multiple bundles into a cross-linked graph.
- **`viewer/`**: TypeScript/Astro renderer. Works locally for development
  and is being built with the centralized service in mind — it is the intended
  rendering frontend for the hosted service, not just a local debug tool.

The viewer lives in-tree while the IR is still in flux; co-locating producer
and consumer lets us iterate across breaking changes in one PR. Splitting into
a sibling repo remains an option once the IR schema stabilises.

The boundary between the two halves:

- `~/.papyri/data/<pkg>_<ver>/` — per-bundle IR (JSON + CBOR blobs,
  `papyri.json`, `toc.json`, `module/*.json`, `docs/`, `examples/`,
  `assets/`).
- `~/.papyri/ingest/papyri.db` — SQLite cross-link graph (schema in
  `papyri/graphstore.py`).

**Note:** the on-disk format is not pure JSON. `graphstore.py`,
`crosslink.py`, `node_base.py`, and `take2.py` encode parts of the IR using
CBOR via the `cbor2` package. Any future JS consumer needs a CBOR library
(e.g. `cbor-x`) in addition to JSON parsing. Documenting and, if feasible,
converging on a single encoding is part of Phase 2.

## Python version

- Minimum: **Python 3.14**. `requires-python = ">=3.14"`.
- CI matrix: `3.14` only to start. Add newer versions later; don't carry
  legacy ones.
- Local dev may only have 3.13 in some environments; CI is the source of
  truth for "does it work on 3.14".

## Dependency pins

- RST parsing uses `tree-sitter-language-pack` (the maintained successor
  of the abandoned `tree_sitter_languages`) on top of `tree-sitter >= 0.24`.
  Don't reintroduce `tree_sitter_languages`.
- `numpy`, `scipy`, `astropy`, `IPython` in the CI matrix drift frequently;
  the current numpy test failure is a canonical-path change for
  `numpy:array`. Either xfail with a reason or pin each matrix entry to a
  known-good version.

## Ordered phases

### Phase 0 — landed

- [x] README: current-state banner, known breakage, install workaround.

### Phase 1 — scope cuts and baseline

- [x] Land the big removal PR (stale scaffolds, unused renderers, dead CLI
      commands, JupyterLab extension, and their workflows / assets).
- [x] Trim `papyri/__init__.py` of dead CLI commands and their imports.
- [x] Trim `pyproject.toml` and `requirements.txt` dependencies to match.
      Note: `rich` is retained because `papyri/gen.py`, `papyri/crosslink.py`,
      `papyri/misc.py`, and `papyri/utils.py` use `rich.progress` /
      `rich.logging` in the core pipeline (not as a docstring renderer).
      Stripping it is a bigger refactor and is not required for Phase 1.
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

- [x] Document the IR format in `docs/IR.md`: on-disk layout, JSON schema
      per file type, CBOR-encoded fields, `graphstore` SQLite schema.
      Followup: JSON-Schema fragments per node + an `IR-CHANGELOG.md`.
- [x] Decide whether to move everything to a single encoding (all JSON, or
      all CBOR) vs documenting the hybrid. Done: gen-side bundles use CBOR
      for IR blobs; `papyri.json` / `toc.json` remain JSON as small
      configuration metadata.  **Ingest-side storage format is not
      mandated** — CBOR is used today as a space-saving measure before
      uploading to a central service, but the graphstore must not assume
      CBOR.  A future implementation (e.g. TypeScript) may use a different
      encoding.
- [x] Add a `papyri describe <qualname>` (or reuse `find`) as a
      maintainer-side debug command that prints an IR entry without a
      renderer. Implemented in `papyri/cli/describe.py` (registered
      onto the Typer app in `papyri/__init__.py`); accepts shorthand
      (`numpy.linspace`), kind-prefixed, and full `pkg/ver/kind/id`
      forms, plus `--kind` / `--package` / `--version` filters.
- [x] Replace `tree_sitter_languages` with direct `tree-sitter-rst`
      from PyPI (on top of `tree-sitter >= 0.24`). Python grammar was
      never used from `tree_sitter_languages`, so no
      `tree-sitter-python` dependency was needed.
- [x] Fix circular import between `papyri/take2.py` and `papyri/myst_ast.py`
      so tests collect cleanly in isolation. Done by merging `myst_ast.py`
      into `take2.py`; M-prefixed classes still exist pending a rename pass.
- [x] Resolve or xfail the known test failures. All prior xfails have
      been fixed (no `strict=False` xfails remaining):
      - `test_nodes.py::test_parse_blocks[numpy.linspace…]` — assertion
        switched from exact count to `>= 1` so numpy docstring drift
        doesn't break the test.
      - `test_gen.py::test_numpy[numpy…]` — updated to numpy 2.x paths
        (`_core` submodule) and dropped the undocumented
        `numpy.core._multiarray_tests:npy_sinh` entry.
      - `test_gen.py::test_self_2` — rewritten to assert `item_file`
        resolution instead of indexing into `papyri.__init__.__doc__`.
      - `test_gen.py::test_infer` — uses `pytest.importorskip("scipy")`
        so environments without scipy skip rather than fail.
      - `test_signatures.py::test_f1[function_with_annotation5]` and
        `test_gen.py::test_self` — expected annotation strings updated
        to Python 3.14's `X | Y` / `X | None` union format (was
        `Union[X, Y]` / `Optional[X]`).

### Phase 3 — Web viewer (in-tree under `viewer/`)

Tracked in [`viewer/PLAN.md`](viewer/PLAN.md). Summary:

- Lives in `viewer/` as an Astro + React + TypeScript app (see
  `viewer/PLAN.md` for the tech rationale).
- Reads the IR directly from the ingest store (`~/.papyri/ingest/`) and
  the SQLite graph; no new intermediate format.
- Milestones tracked in [`viewer/PLAN.md`](viewer/PLAN.md) "Milestones".
- CI: `.github/workflows/viewer.yml` runs `pnpm --filter papyri-viewer
  run check` and `pnpm build`; `.github/workflows/lint.yml` runs the
  ESLint + Prettier checks; `.github/workflows/ingest.yml` covers the
  sibling `papyri-ingest` workspace package.
- Originally planned as a separate sibling repo; now in-tree while the IR
  is still in flux. Splitting out remains an option once the IR schema
  stabilizes in Phase 2.

### Phase 4 — Narrative docs (IPython as reference target)

The skeleton already exists: `papyri gen` parses `.rst` files from
`docs_path`, `papyri ingest` converts `toc.json → toc.cbor`, and the
viewer has `docs/[...doc].astro` + sidebar TOC rendering. The gaps are
robustness and coverage holes.

**Phase A — make it build** (current focus)

- [x] Harden `toc.py:make_tree()` to not crash when there is no `index`
      root document. Fall back to a flat listing of all collected docs.
      IPython and other packages may root the docs tree at a key other
      than `"index"` or may have an empty toctree graph.
      Done: falls back to any unreferenced node, or the first key, with
      a log warning.
- [x] Fix `tree.py:_toctree_handler`: remove `assert not argument` (some
      builds pass a title); skip empty and comment lines; silently drop
      `:glob:` entries (we don't expand globs at gen time).
      Done: argument is silently ignored; blank/comment lines and glob
      patterns skipped; malformed entries logged as warnings.
- [x] Fix `tree.py:GenVisitor.visit_Section`: section target refs are
      currently registered against the hardcoded
      `RefInfo("papyri", "0.0.8", "docs", …)` regardless of which package
      is being built. Pass the real `(module, version)` pair through
      `GenVisitor` and use them here.
      Done: replaced with `LocalRef("docs", target)`, which inherits
      module/version from the bundle context at render time.
- [x] Update `examples/IPython.toml`: add `narrative_exclude` patterns
      to skip auto-generated API stubs (`api/generated/`) and Sphinx
      build artefacts that are not human-authored prose.
      Done: `api/generated`, `_build`, `config/api` are excluded.

**Phase B — make it useful in the viewer**

- [x] Fix narrative page `<h1>`: extract the first heading from
      `doc.arbitrary[0].title` instead of displaying the raw key
      (`config:details`).
      Done: `displayTitle = sections[0]?.title || doc.qa || docPath`.
      First section's h2 is suppressed when its title became the h1 to
      avoid duplication.
- [x] Add `id=` anchors to headings so within-doc navigation works.
      Done: `<section id={sectionId(s)}>` where `sectionId` prefers the
      RST target label and falls back to a slugified title. Added
      `scroll-margin-top` so fixed headers don't obscure jump targets.
- [x] Add a within-doc mini-TOC (sidebar or top-of-page) listing `<h2>`
      headings for long narrative pages.
      Done: `<nav class="doc-toc">` rendered above sections when ≥ 2
      titled sections remain after the h1 section.

**Phase C — `:doc:` cross-links**

- [x] Handle the `:doc:` Sphinx role in `GenVisitor`: emit a `CrossRef`
      with `kind="docs"` instead of verbatim text.
- [x] Resolve those refs in `IngestVisitor` (map to `Key(pkg, ver,
      "docs", path)`).
- [x] Warn and skip Sphinx-only directives that are not meaningful
      outside the Sphinx build environment: `.. autofunction::`,
      `.. autoclass::`, `.. automodule::`, `.. ipython::`.
      Emits `log.warning` and returns `[]` (no output node).

## Open questions

- Do we want to re-publish to PyPI under a new version once Phase 1 is
  done, or keep it as "install from git" only for the foreseeable future?
  **Still open.**

## Cross-version page change detection (landed)

`graphstore.put` records a 16-byte BLAKE2b fingerprint of every
canonical (re-encoded) blob in a new `nodes.digest` column. One query
method is exposed on `GraphStore`:

- `diff_versions(package, version_a, version_b)` — returns the added /
  removed / modified pages between two ingested versions, identified by
  `(category, identifier)`. Identical-digest pages are omitted; callers
  that only care about one category filter the returned list.

The digest is computed **post-encoder** so it reflects the canonical
form of the IR, not whatever bytes gen happened to write — which means
re-ingesting yields stable digests even before the gen pipeline is fully
canonicalized. The digest column is part of the schema for new
databases; existing databases need to be dropped (`papyri drop`) and
re-ingested.

CLI surfacing: `papyri diff <pkg> <va> <vb> [--summary]` prints the
added / removed / modified buckets.

The next iteration is a **semantic digest** (signature + section titles
+ collapsed text, ignoring source positions) so the viewer can
distinguish trivial whitespace churn from real content change. Add it as
a second column rather than replacing the raw digest. "Unchanged since
which version?" is deferred — it needs a clear story for version
ordering before it's worth wiring up.

## Follow-ups (not yet scheduled)

- **Directive handlers should not read global state.** `:ghpull:` and
  `:ghissue:` currently pull the GitHub slug from a module-level
  `_GITHUB_SLUG` in `tree.py`, set at gen start via `set_github_slug()`.
  That works for a single sequential `papyri gen` run but is a hazard
  for any future parallel/per-project codepath (the last setter wins).
  The registry should pass the active `Config` (or a narrower
  "directive context" carrying the relevant `[meta]` keys) into the
  handler call itself, so handlers can be pure functions of
  `(value, ctx)` again.
- **Per-reference version resolution in `crosslink.py`.** See
  `TODO-review.md`. A related dead assertion (`tree.py`, comparing a
  string to a list so the raise never fired) has been removed; the
  underlying "local reference should carry an explicit version"
  invariant still needs a real enforcement point once cross-package
  version data is threaded through.
- **Configurable doctest `optionflags`.** `ExampleBlockExecutor` hardcodes
  `doctest.ELLIPSIS`. Projects that need `NORMALIZE_WHITESPACE` or
  `IGNORE_EXCEPTION_DETAIL` have no knob. A `[global].doctest_optionflags`
  config key would suffice.
- **Module-docstring parse failures.** The visible ``"To remove in the
  future -- <qa>"`` placeholder has been replaced by the same empty
  shell used for modules with no docstring, so nothing leaks into
  rendered output. A proper sentinel that distinguishes "unparseable"
  from "genuinely empty" at render time is still a follow-up — the
  remaining ``ndoc-placeholder`` TODO in `gen.py` marks where it
  would plug in.
- Static export hardening for `viewer/dist/` deployment (the current
  build works; `viewer/DEPLOY.md` documents ready-to-use GitHub Actions
  workflows for GitHub Pages and Cloudflare Pages, plus SSR upgrade paths
  for other hosts — no hosting platform is locked in yet).
- Dark-adapted Shiki theme + dark-mode-aware KaTeX glyphs. The current
  M5 dark mode keeps the `github-light` Shiki palette on a dark
  surface, which is readable but not ideal.
- Per-bundle → global search. The current manifest is `<pkg>/<ver>/
  search.json`; a cross-bundle index would enable "find `linspace`
  across numpy and scipy".
- Cross-package ingest correctness: `papyri/crosslink.py` still has
  TODOs around version resolution for `Figure`/`RefInfo` across packages.
  See `TODO-review.md`.
- **`normalise_ref` validation could move to gen.**
  `ingest()` silently drops files whose `qa` fails `normalise_ref()`
  when `--check` is passed (`crosslink.py` ~line 379).  Since
  `normalise_ref` depends only on the qa string (no cross-package data),
  the check could be enforced at gen time so the bundle is
  self-consistent before it leaves the maintainer's machine.
- **`mod_root == root` assertion could move to gen.**
  `ingest()` asserts that every API item's root module matches the
  bundle's declared root (`crosslink.py` ~line 412).  Gen already knows
  both values; moving the check there makes the contract explicit and
  surfaces mistakes earlier.
- **Builtin ref resolution belongs at gen time, not ingest.**
  `resolve_()` currently has a special-case branch that recognises Python
  builtins (`int`, `str`, `list`, …) and returns a `missing` RefInfo for
  them.  This is gen-specific knowledge that does not belong in the
  ingest resolver.  The correct model: ship a **Python-builtins bundle
  shim** — a minimal DocBundle (generated once, checked in or published)
  that registers every builtin as a proper `RefInfo`.  `papyri gen` emits
  references to builtins as ordinary cross-refs; ingest resolves them
  against the shim bundle exactly like any other package.  No special
  casing in `resolve_()` at ingest time.
- **Core invariant: gen owns all ref classification; ingest only links.**
  A well-formed DocBundle must satisfy:
  - Every reference *within* the bundle is a `LocalRef` — no intra-bundle
    `RefInfo` nodes.  Gen is responsible for converting relative refs,
    aliases, and local names to `LocalRef` before writing the bundle.
  - Every cross-bundle reference is a `RefInfo` with a fully qualified
    `(package, version, kind, path)` — no fuzzy strings, no unresolved
    aliases.  This includes builtins (resolved via the shim bundle at gen
    time).
  Ingest then has a clearly bounded job:
  1. Resolve every `LocalRef` to a full key within the current bundle's
     namespace.  A `LocalRef` that cannot be resolved within the current
     bundle is promoted to a dangling `RefInfo`: the graphstore records
     the node with `has_blob=0` and stores the link edge immediately.
     When the target bundle is ingested later, `put()` flips the node to
     `has_blob=1` — the edge already exists, so cross-resolution
     completes without any re-processing pass.  This means incremental
     ingest works correctly without building a full ref map first.
  2. For every `RefInfo` already present in the bundle IR: check whether
     the target key exists in the graphstore.  If yes, the link is live;
     if not, record it as a dangling ref (same `has_blob=0` mechanism).
  3. Optionally run a **check pass** that asserts no `LocalRef` remains
     unresolved and that all dangling `RefInfo` targets are at least
     registered as known nodes.
  A two-step ingest (first pass: load all bundle metadata and build a
  complete ref map; second pass: resolve all bundles against that map) is
  an optimisation for the ambiguous-`LocalRef` case (where the target
  package is not known at gen time) and to avoid the ordering sensitivity
  of the current `relink()`.  It is not a requirement for the common case
  where gen has already fully attributed every cross-bundle ref.
- **RST substitutions are gen-time-only (done).**
  `SubstitutionDef` and `SubstitutionRef` nodes are resolved inside
  `ts.parse()` before any IR is written.  The IR must never contain
  either node type.  Non-`replace::` substitution types (image, unicode)
  are warned and dropped; support can be added per demand.
