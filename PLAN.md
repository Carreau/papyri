# Papyri plan

This document captures the agreed scope and ordered work. Future sessions
(human or agent) should treat this as the source of truth. Check items off
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
service ingests many and serves them from one place.

## Target shape

- **`papyri gen`**: run per project, by each library maintainer in their own
  CI or build environment. Produces a self-contained DocBundle on disk.
- **`papyri upload`**: ships the bundle to a viewer instance's
  `/api/bundle` endpoint, which runs the TypeScript ingest pipeline
  server-side to wire bundles into the cross-linked graph.
- **`viewer/`**: TypeScript web renderer. Works locally for development and
  is being built with the centralized service in mind — it is the intended
  rendering frontend for the hosted service, not just a local debug tool.
- **`ingest/`**: TypeScript `papyri-ingest` package — the canonical
  ingestion engine, invoked by the viewer's upload endpoint.

The viewer lives in-tree while the IR is still in flux; co-locating producer
and consumer lets us iterate across breaking changes in one PR. Splitting into
a separate repo remains an option once the IR schema stabilizes.

The boundary between the two halves:

- `~/.papyri/data/<pkg>_<ver>/` — per-bundle IR (`papyri.json`, `toc.json`,
  `module/`, `docs/`, `examples/`, `assets/`). The per-file encoding is an
  implementation detail; do not assume JSON or CBOR exclusively.
- Storage is abstracted: the viewer and ingest pipeline must not assume a
  specific on-disk layout or wire encoding. The current implementation uses
  SQLite for the cross-link graph and a filesystem store for blobs; the
  hosted service will use different backends (e.g. Cloudflare D1 + R2).

## Python version

- Minimum: **Python 3.14**. `requires-python = ">=3.14"`.
- CI matrix: `3.14` only. Add newer versions later; don't carry legacy ones.

## Dependency notes

- RST parsing currently uses `tree-sitter-language-pack` on top of
  `tree-sitter >= 0.24`. May switch to `tree-sitter-rst` directly from
  PyPI. Do not reintroduce `tree_sitter_languages`.
- `numpy`, `scipy`, `astropy`, `IPython` in the CI matrix drift frequently;
  pin each matrix entry to a known-good version or xfail with a reason.

## Open work

### Viewer — M9 (Cloudflare Workers)

Tracked in [`viewer/PLAN.md`](viewer/PLAN.md).

## Open questions

- Do we want to re-publish to PyPI under a new version, or keep it as
  "install from git" only for the foreseeable future? **Still open.**

## Follow-ups (not yet scheduled)

- **Directive handlers should not read global state.** `:ghpull:` and
  `:ghissue:` pull the GitHub slug from a module-level `_GITHUB_SLUG` in
  `tree.py`, set at gen start via `set_github_slug()`. The registry should
  pass the active `Config` into the handler call so handlers are pure
  functions of `(value, ctx)`.
- **Per-reference version resolution.** Local references should carry
  explicit versions; the invariant needs an enforcement point once
  cross-package version data is threaded through.
- **Configurable doctest `optionflags`.** `ExampleBlockExecutor` hardcodes
  `doctest.ELLIPSIS`. A `[global].doctest_optionflags` config key would suffice.
- **Module-docstring parse failures.** A sentinel distinguishing "unparseable"
  from "genuinely empty" at render time is needed — the `ndoc-placeholder`
  TODO in `gen.py` marks where it would plug in.
- **Per-bundle → global search.** The current manifest is per-bundle; a
  cross-bundle index would enable "find `linspace` across numpy and scipy".
- **`normalise_ref` validation could move to gen.** Since `normalise_ref`
  depends only on the qa string (no cross-package data), the check could be
  enforced at gen time so the bundle is self-consistent before upload.
- **`mod_root == root` assertion could move to gen.** Gen already knows both
  values; moving the check surfaces mistakes earlier.
- **Builtin ref resolution belongs at gen time.** Ship a Python-builtins
  bundle shim — a minimal DocBundle that registers every builtin as a proper
  `RefInfo`. `papyri gen` emits references to builtins as ordinary cross-refs;
  ingest resolves them against the shim exactly like any other package. No
  special-casing in the ingest resolver.
- **Core invariant: gen owns all ref classification; ingest only links.**
  - `LocalRef` means *this bundle*, always. Gen converts every relative ref,
    alias, and local name to a `LocalRef` before writing the IR.
  - Every cross-bundle reference is a `RefInfo` with a fully qualified
    `(package, version, kind, path)`. No fuzzy strings, no unresolved aliases.
  - Ingest: resolve `LocalRef`s to full keys; record live or dangling
    `RefInfo` links. A two-step ingest (build a ref map from all bundle
    metadata first) is an optimisation, not a correctness requirement.
- Rename `crosslink.py` to something that reflects its current read-only role
  (`ingested_doc.py`?), or fold `IngestedDoc` into `nodes.py`.
- Audit `papyri/graphstore.py`: the write-side methods are no longer called
  by the Python side. Decide whether to slim it to a read-only interface.
- Decide the future of `papyri find` / `describe` / `diff` / `debug`: they
  work against the store written by the TypeScript pipeline, but the viewer
  is the user-facing replacement.
- **RST substitution invariant.** The IR must never contain `SubstitutionDef`
  or `SubstitutionRef` nodes. Non-`replace::` substitution types (image,
  unicode) are warned and dropped; support can be added per demand.
- Static export hardening for `viewer/dist/` deployment.
- Dark-adapted Shiki theme + dark-mode-aware KaTeX glyphs.
- Cross-package ingest correctness: TODOs around version resolution for
  `Figure`/`RefInfo` across packages (see `crosslink.py`).
