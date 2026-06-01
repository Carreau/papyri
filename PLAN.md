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
  SQLite for the cross-link graph and a filesystem store for blobs.

## Storage invariant: the graphstore is a derived cache

The DocBundle (the `.papyri.gz` artifact produced by `papyri gen` and
archived verbatim in the `_raw/` zone — see "Raw bundle archive" below) is
the **only** authoritative IR. Everything the viewer's graphstore + blob
store contains is a derived projection of those raw bundles, rebuildable at
any time via `POST /api/reingest`.

Consequence: **what ingest writes into the graphstore is not required to be
the IR.** Ingest may freely denormalize, precompute, rewrite, resolve refs
into concrete keys, drop fields the renderer doesn't consume, or split a
single IR node across several tables. The only contracts are:

1. The raw archive (`_raw/<pkg>/<ver>.papyri.gz`) remains byte-identical to
   the upload.
2. The renderer's input shape (what page templates read) stays stable, or
   migrates in lockstep with the renderer.

This unlocks several items already listed below — precomputed
`nodes_by_type` tables, resolved-ref storage, image indices, search
indices — which can land without preserving any IR-shape invariant in the
store. It also means the "graphstore write-side audit" should not try to
preserve round-trip-to-IR fidelity; the round-trip is via re-ingest from
the raw archive, not via reading the graphstore back.

## Python version

- Minimum: **Python 3.13**. `requires-python = ">=3.13"`.
- CI matrix: `3.14` only. Add newer versions later; don't carry legacy ones.

## Dependency notes

- RST parsing uses `py-tree-sitter-rst` (PyPI) on top of `tree-sitter >= 0.24`.
  Do not reintroduce `tree_sitter_languages` or `tree-sitter-language-pack`.
- `numpy`, `scipy`, `astropy`, `IPython` in the CI matrix drift frequently;
  pin each matrix entry to a known-good version or xfail with a reason.

## Open work

### Viewer — hosting

The viewer is deployed as a long-running Node.js server on a VPS. An
earlier Cloudflare Workers (R2 + D1) target was abandoned because ingest
latency on Workers/R2/D1 was far too high (per-object subrequest fan-out
against the Workers cap; see `viewer/PLAN.md`). The storage abstractions
(`BlobStore` / `GraphDb` / `RawStore`) are kept so a backend swap stays
possible, but only the filesystem + SQLite implementations exist.

Tracked in [`viewer/PLAN.md`](viewer/PLAN.md).

## Open questions

- Do we want to re-publish to PyPI under a new version, or keep it as
  "install from git" only for the foreseeable future? **Still open.**

- **Per-bundle crossref tables instead of one global `links` table?**
  Today the graphstore keeps every crossref in a single `links(source,
  dest)` table over a global `nodes` table (see
  `ingest/migrations/0000_init.sql`). `getBackrefs`
  (`viewer/src/lib/graph.ts`) computes incoming edges with a join across
  `links` + two copies of `nodes`, filtered by `(package, identifier)`.

  Alternative shape to consider:
    1. A per-bundle table of *outgoing* refs — the refs that bundle
       actually emits — keyed by source qualname → target
       `(pkg, kind, identifier)`. Naturally partitioned by bundle, so
       re-ingesting a bundle is a single table drop+rebuild instead of
       deleting rows by `source` from a global table.
    2. A small coarse-grained bundle-to-bundle index (`from_bundle,
       to_bundle`, maybe with a count) that says which bundles refer to
       which.
    3. Backrefs computed lazily at view time: use the coarse index to
       find candidate bundles that mention the target package, then
       union the relevant per-bundle outgoing tables, filtering for the
       target identifier.

  Things to think about before committing to it:
  - **Cost model.** The global `links` table makes backref lookup one
    indexed query; the per-bundle shape makes it `O(N_bundles_pointing_at_pkg)`
    queries (or a `UNION ALL` over them). For a hot package like numpy
    where almost everything points at it, that fan-out could be larger
    than the current single join. But the per-bundle tables would each
    be small, so the *total* row count scanned might still be lower.
  - **Cache friendliness.** Per-bundle tables are append-only during a
    single ingest; the global `links` table is write-amplified across
    every concurrent upload. The per-bundle shape probably wins where
    write contention matters.
  - **Re-ingest semantics.** Today removing a bundle means deleting from
    `nodes` (and `links` cascades). Per-bundle tables make
    `POST /api/reingest` and bundle eviction trivially atomic per bundle
    — drop the table.
  - **Wildcard-version stubs.** `getBackrefs` already matches
    `version IN ('?','*')` for cross-package refs whose target version
    is unresolved at ingest. The per-bundle scheme needs to preserve
    that behavior — either by storing the wildcard at the per-bundle
    level, or by resolving it lazily when the backref is materialized.
  - **Schema-per-bundle vs. partition column.** "Per-bundle table" can
    mean a literal `refs_<pkg>_<ver>` table (clean partitioning, ugly
    DDL churn) or one `refs` table partitioned by `(from_pkg,
    from_ver)` with a covering index. Per-bundle DDL churn is best
    avoided; one table with a partition column is probably the realistic
    shape.
  - **Interaction with the "graphstore is a derived cache" invariant.**
    This is purely a denormalization choice — no IR contract changes,
    no raw-archive impact — so it's exactly the kind of change the
    invariant says we're free to make. The question is just whether it
    pays off.

  Not a decision yet; capture and revisit when backref latency or
  ingest write contention becomes a measured problem.

## Follow-ups (not yet scheduled)

### Viewer preferences

- **Inline class members (methods and attributes).**
  Add a per-page (or per-bundle) toggle that expands each class's methods and
  attributes inline on the class page, rendering their full docstrings,
  signatures, and parameter tables directly rather than showing only a summary
  table with links to individual qualname pages.

  *Design notes:*
  - The class page already fetches member qualname blobs for the summary table
    (`viewer/src/lib/qualname-page.ts`). Inlining reuses those same blobs; no
    new data fetching is required.
  - Toggle state can live in a `?inline-members=1` query-string flag (shareable
    URL) with a client-side React island to flip it without a full navigation.
  - The toggle should default to collapsed (current behaviour) so existing URLs
    are unaffected.
  - Consider a persistent user preference via `localStorage` so the user's
    choice survives navigation; the URL flag takes precedence when present.

- **Inline module-level functions.**
  Add a per-page (or per-bundle) toggle that renders the full docstring,
  signature, and parameter tables of every function defined directly in a
  module, inline on the module overview page, rather than showing only the
  summary listing.

  *Design notes:*
  - Mirrors the class-member inlining above. Module pages already enumerate
    their functions; inlining fetches and expands the same qualname blobs.
  - Same URL-flag + `localStorage` pattern as above (`?inline-functions=1`).
  - For large modules (e.g. `numpy`) the expanded view can be very long;
    consider a "collapse all" shortcut and anchor links to each function so the
    page stays navigable.
  - Both toggles (class members, module functions) should share a single
    rendering component so the inline layout is consistent.

- **C extension (clinic) signatures: use as fallback ObjectSignature for types.**
  `Gen.extract_docstring` now strips the Python C clinic prefix
  (`FuncName(args)\n--\n`) before RST/numpydoc parsing (fixed 2026-05-21).
  The stripped signature string is discarded, but it is the only structured
  source of parameter information for many C extension types where
  `inspect.signature()` raises `ValueError`/`TypeError`.

  *What to do:*
  - Change `strip_clinic_signature` (or add a sibling
    `extract_clinic_signature`) to return both the clinic signature string
    (or `None`) and the stripped body, instead of the body alone.
  - In `extract_docstring`, when the object is a `type` and we stripped a
    clinic prefix, attempt `Signature.from_str(clinic_sig)` (already exists
    in `papyri/signature.py`) and use the result as the `sig` argument to
    `APIObjectInfo` instead of `None`.
  - Fall back to `sig = None` if `from_str` raises (malformed clinic string).
  - Note: for numpy.dtype specifically, `inspect.signature()` already works
    (returns the correct sig), but the class branch in `extract_docstring`
    hardcodes `sig = None` without calling it. A broader fix would also try
    `inspect.signature()` for classes and only fall back to the clinic string
    — but that is a separate, larger change.
  - Add a test in `papyri/tests/test_gen.py` covering a C-extension type
    whose docstring starts with a clinic signature.

- **Missing block directives for numpy / scipy / IPython builds.**
  Audited 2026-04-30. The following directives are encountered when running
  `papyri gen` against these packages but have no handler. As of the
  unhandled-directive change, an unregistered directive can no longer be
  serialized: gen emits a transient `Directive` node carrying the name, and
  serialization (CBOR or JSON) raises with that name, so the bundle cannot be
  produced until a handler is registered (`papyri.directives:drop` to discard,
  `papyri.directives:code_handler` to keep verbatim, or a real handler). The
  directives below therefore need a handler registered — in `papyri.toml`'s
  `[global.directives]` table or, for the common ones, as built-in defaults in
  `tree.py` — before these packages will gen cleanly.

  *High priority* (very common; materially degrades output):
  - `rubric` — unnumbered section heading (`.. rubric:: References`). Used
    in all three packages for headings that must not appear in the TOC. Should
    produce a lightweight `Section`-like node or an `Admonition`.
  - sphinx-design (`grid`, `grid-item`, `grid-item-card`, `card`,
    `card-carousel`, `tab-set`, `tab-item`, `dropdown`, `button-link`,
    `button-ref`) — *landed as silent drops.* numpy / scipy build their root
    `doc/source/index.rst` as a PyData-theme landing page out of these, and
    losing the root index page collapses the entire toc to a single fallback
    leaf via `make_tree`'s root-not-found path. Added to
    `_SPHINX_ONLY_DIRECTIVES`. If a hosted DocBundle ever needs to render
    these (probably not — they are pure layout around links the toctree
    already provides), revisit with proper IR nodes.
  - `automodule` — was missing from the autodoc family in
    `_SPHINX_ONLY_DIRECTIVES`; now added next to `autofunction` / `autoclass`.

  *Medium priority* (structural / ref-resolution impact):
  - `only` — conditional content (`.. only:: html`). Content inside should be
    included at gen time (papyri targets HTML) or dropped with a log message.
  - `currentmodule` — `.. currentmodule:: numpy`. Sphinx directive that shifts
    the implicit module prefix for subsequent cross-refs. Gen has no hook for
    it; refs in sections that follow it silently fail to resolve.
  - `testcleanup` / `testcode` / `testoutput` — doctest infrastructure
    directives used in numpy / scipy narrative docs. Should be added to
    `_SPHINX_ONLY_DIRECTIVES` (silently dropped), not emitted as IR nodes.
    (`testsetup` is already handled.)

  *Low priority* (infrequent or render-only):
  - `highlight` — sets the default code-highlight language for a section.
    Safe to ignore or silently drop.
  - `literalinclude` — includes a source file verbatim. Needs filesystem
    access at gen time; drop with a warning for now.
  - `csv-table` — structured table directive (scipy). `list-table` now has a
    full handler and Table IR node; `csv-table` still needs one.
  - `function` / `class` / `method` / `attribute` / `data` / `exception` /
    `module` (Sphinx py-domain, no `auto` prefix) — appear in handwritten
    numpy / scipy API reference `.rst` pages. Could be added to
    `_SPHINX_ONLY_DIRECTIVES` or given lightweight handlers.

- **Directive handlers should not read global state.** `:ghpull:` and
  `:ghissue:` pull the GitHub slug from a module-level `_GITHUB_SLUG` in
  `tree.py`, set at gen start via `set_github_slug()`. The registry should
  pass the active `Config` into the handler call so handlers are pure
  functions of `(value, ctx)`.
- **Stateful directives need a proper context-injection API.** The
  `make_image_handler` factory is a workable stopgap: it closes over
  `doc_path`, `asset_store`, `module`, and `version` to give the handler
  access to bundle state. But any future directive that needs similar
  context (e.g. one that resolves paths, emits assets, or reads config)
  must repeat this factory pattern. A cleaner design would define an
  explicit `DirectiveContext` object (carrying at minimum `doc_path`,
  `asset_store`, `module`, `version`, and the active `Config`) and pass
  it as a second argument to every handler: `handler(argument, options,
  content, ctx)`. Handlers that need no context simply ignore it; those
  that do have a typed, discoverable surface instead of an ad-hoc closure.
  This overlaps with the "no global state" item above and should be tackled
  together.
- **Per-reference version resolution.** Local references should carry
  explicit versions; the invariant needs an enforcement point once
  cross-package version data is threaded through.
- **Unify the "version unknown" cross-package ref marker (`"*"` vs `"?"`).**
  *Done.* Gen now emits `RefInfo(version="?", kind="module")` directly
  (`papyri/tree.py`); the `kind="api" + version="*"` → `kind="module" + version="?"`
  normalization in `ingest/src/visitor.ts` is gone; `viewer/src/lib/graph.ts` now
  uses `version = '?'` (not `IN ('?','*')`). A reingest from raw archive is needed
  for any bundles generated before this change.
- **Configurable doctest `optionflags`.** *Done.* `config_loader.py` exposes
  `doctest_optionflags: Sequence[str] = ("ELLIPSIS",)` and `gen.py` reads it.
- **Module-docstring parse failures.** A sentinel distinguishing "unparseable"
  from "genuinely empty" at render time is needed — the `ndoc-placeholder`
  TODO in `gen.py` marks where it would plug in.
- **Per-bundle → global search.** The current manifest is per-bundle; a
  cross-bundle index would enable "find `linspace` across numpy and scipy".
- **`normalise_ref` validation could move to gen.** Since `normalise_ref`
  depends only on the qa string (no cross-package data), the check could be
  enforced at gen time so the bundle is self-consistent before upload.
- **`mod_root == root` assertion could move to gen.** *Stale — `mod_root` no
  longer appears in the codebase; this item is resolved by removal.*
- **External (intersphinx) linking — landed.** The viewer can now resolve a
  cross-package `RefInfo` that points at a non-papyri project (numpy, the
  stdlib, …) to a real external URL. An admin registers a project by pointing
  `POST /api/inventory` at its Sphinx `objects.inv`; the parser lives in
  `ingest/src/inventory.ts`, the rows are stored via the
  `0001_external_inventory.sql` migration, and `resolveExternalRefs`
  (`viewer/src/lib/xref.ts`) consults them at render time for refs the local
  graph can't resolve. Admin UI: `ExternalInventoryPanel.tsx`. This covers a
  broad slice of the "link to projects that don't publish a DocBundle" need.
- **Builtin ref resolution belongs at gen time.** Ship a Python-builtins
  bundle shim — a minimal DocBundle that registers every builtin as a proper
  `RefInfo`. `papyri gen` emits references to builtins as ordinary cross-refs;
  ingest resolves them against the shim exactly like any other package. No
  special-casing in the ingest resolver. (Note: the intersphinx inventory above
  already handles stdlib links via the CPython `objects.inv`; the shim is the
  gen-time alternative for builtins specifically.)
- **Core invariant: gen owns all ref classification; ingest only links.**
  This invariant applies to the IR in the raw archive, not to the
  graphstore's internal representation (see "Storage invariant" above) —
  ingest may store refs in whatever resolved/denormalized form is
  convenient.
  - `LocalRef` means *this bundle*, always. Gen converts every relative ref,
    alias, and local name to a `LocalRef` before writing the IR.
  - Every cross-bundle reference is a `RefInfo` with a fully qualified
    `(package, version, kind, path)`. No fuzzy strings, no unresolved aliases.
  - Ingest: resolve `LocalRef`s to full keys; record live or dangling
    `RefInfo` links. A two-step ingest (build a ref map from all bundle
    metadata first) is an optimisation, not a correctness requirement.
- Rename `crosslink.py`. *Done.* Renamed to `ingested_doc.py`.
- **Audit `papyri/graphstore.py`. *Done.*** Removed write-side methods
  (`put`, `put_meta`, `remove`, `_maybe_insert_node`); `GraphStore` is now
  read-only. TypeScript ingest owns all writes. Schema creation removed from
  `__init__`; the graphstore is a derived cache (see "Storage invariant"
  above), so the Python side has no reason to write into it.
- Decide the future of `papyri find` / `describe` / `diff` / `debug`: they
  work against the store written by the TypeScript pipeline, but the viewer
  is the user-facing replacement.
- **RST substitution invariant.** The IR must never contain `SubstitutionDef`
  or `SubstitutionRef` nodes. Non-`replace::` substitution types (image,
  unicode) are warned and dropped; support can be added per demand.
- **Separate domains/processes for upload, admin, and user surfaces.**
  In a hosted deployment the upload endpoint (`POST /api/bundle`), any admin
  panel, and any per-user management UI should run as isolated processes on
  separate subdomains. Keeping them isolated limits blast
  radius: a vulnerability in the upload path cannot reach admin state, and
  per-user surfaces cannot touch other users' bundles. Design URL structure
  and routing with this separation in mind so the hosted service is not baked
  into a monolithic app. Track this when the hosting design firms up.

- **Track raw upload timestamps independently of bundle metadata.**
  *Done.* `FsRawStore.put()` writes `_raw/<pkg>/<ver>.meta.json` sidecar
  immediately after archiving the compressed bundle, capturing server wall-clock
  time as ISO 8601. `RawStore` interface gains `getMeta(pkg, ver)` returning
  `RawMeta | null`. Enables audit logs, "most-recently-uploaded" sorting, and
  TTL / eviction policies without trusting uploader-controlled timestamps.

- **Images are likely a volatile field for bundle hashes.**
  *Partially landed:* `papyri upload` now computes a SHA-256 over the whole
  `.papyri` artifact and skips the upload when the viewer already holds that
  exact content for `(module, version)` (stored as `bundles.content_hash`;
  served via `GET /api/bundle`; `--force` bypasses). This artifact-level hash
  deliberately includes image bytes, so a re-`papyri gen` with churned images
  triggers a redundant re-upload — safe (never a false "already uploaded"),
  but coarse. The refinement below — a *content-identity* hash over IR
  structure + text + asset references but **not** image bytes — remains open.

  *Follow-up — make `content_hash` `NOT NULL`.* The column is nullable today
  only as a migration cushion (`ALTER TABLE ADD COLUMN`, plus pre-existing
  rows). Now that the *only* ingest input is a packed `.papyri` artifact
  (the directory-based ingest path is gone — see "Drop directory-based
  ingest" below), every ingest knows its compressed bytes and always
  computes a hash, so a NULL is no longer reachable on the write path. We're
  not production-ready, so it's fine to do a full wipe + re-ingest from the
  raw archive at some point and recreate `bundles` with `content_hash TEXT
  NOT NULL` (fold it into a future migration squash rather than carrying the
  nullable form forever).

  If/when we content-address bundles (e.g. a SHA over the IR for dedup,
  caching, or change detection), image assets should almost certainly be
  excluded from the hashed payload — especially autogenerated ones (matplotlib
  `plot` directive output, rendered figures, etc.). They are non-deterministic
  across matplotlib / freetype / Agg / OS versions and across runs (timestamps,
  font hinting, antialiasing), so including them makes every rebuild look like
  a content change even when the documented API is unchanged. Treat images as
  a *volatile* sidecar: hash the IR structure + text + asset *references*, but
  not the image bytes. Open question: do we still want a separate per-asset
  hash so the viewer can cache-bust individual images? Probably yes, but kept
  out of the bundle-identity hash.

- **Drop directory-based ingest.** *Landed.* The TypeScript `Ingester` had two
  inputs: a `papyri gen` bundle *directory* (`ingest(dirPath)`, with its own
  per-item `_put` write path and `_ingest*Dir` helpers) and a decoded
  `Bundle` Node (`ingestBundle(node)`, the optimized two-phase write used by
  `PUT /api/bundle`). The directory path was legacy (it even read CBOR, not
  the JSON `papyri gen` actually writes) and only the standalone
  `papyri-ingest` CLI used it. `ingestBundle` (decoded packed `.papyri`
  artifact) is now the sole ingest contract: `ingest()`, `_put`,
  `_getForwardRefs`, the `_ingest*Dir` helpers, `IngestOptions.check`, and the
  unused `explodeBundleToDir` (Bundle → directory) are removed. The standalone
  `papyri-ingest` CLI (`ingest/src/cli.ts`, the `bin` entry) existed only to
  drive that directory path and has been removed too — `papyri-ingest` is now
  a library consumed by the viewer's `PUT /api/bundle`, which is the one ingest
  entry point. Consequence: the `--check` / `normalise_ref` skip that only
  existed on the directory path is gone — re-introduce it at gen time (see
  "`normalise_ref` validation could move to gen" above) if still wanted.

- **`papyri pack` strict mode and bundle linting.**
  *`papyri lint` subcommand: done.* `papyri/cli/lint.py` + `lint_bundle()` in
  `pack.py` check SubstitutionRef/SubstitutionDef nodes and missing Figure assets.
  Tests in `papyri/tests/test_pack.py`.
  *`--strict` flag: done.* `papyri pack --strict` / `-s` now promotes orphan-doc
  warnings to hard `BundleError`, gated behind the flag so non-strict mode is
  unchanged. Useful in CI to catch toctree regressions before publishing. Remaining
  open:
  - Lint check for empty module-docstring sentinel placeholder.

  *Partial landing — silent-drop → hard pack failure:* lenient `papyri gen`
  used to swallow per-object failures (a narrative page that failed to
  validate, an API qa whose introspection raised) with a `log.warning` and
  produce a quietly-degraded bundle. Now every such failure is recorded
  under `errors` in `papyri.json` (`Gen._record_error` / `_gen_errors` in
  `papyri/gen.py`, mirroring `ErrorCollector._unexpected_errors` for the API
  side), and `papyri pack`'s `_check_no_gen_errors` refuses to produce an
  artifact while any are present.

- **Toc ↔ narrative consistency checks.**
  *Forward direction landed:* `papyri pack` now fails (via `_check_toc_refs`
  in `pack.py`, run from `read_bundle_dir`) if any toc entry points at a
  document that isn't in the bundle — a dangling toc ref leaves the rendered
  page empty and the nav full of dead links. A regression in narrative
  collection (e.g. fail-fast on an unhandled directive dropping most numpy
  pages) is what motivated it. `papyri/tests/test_pack.py` covers the check
  plus a skip-guarded `test_numpy_toc_has_enough_items` smoke test that flags
  a numpy build whose toc has collapsed to a handful of entries.

  *Reverse direction landed (as a warning):* `find_orphan_docs` /
  `_warn_orphan_docs` in `pack.py` (run from `read_bundle_dir`) flag every
  narrative doc no toc entry points at. An orphaned doc — present in
  `narrative/` but listed under no toctree root — renders fine at its URL but
  is invisible in navigation, so the bundle looks "mostly empty" even though
  the pages exist (a large crop usually means a toctree root failed to parse,
  stranding everything it would have linked). It is a *warning*, not a hard
  pack error, because papyri's IR does not yet capture Sphinx `:orphan:`
  markers, so an intentionally-unlisted page can't be told apart from an
  accidental one. `test_numpy_narrative_docs_mostly_reachable` (skip-guarded,
  like the toc-count test) asserts the orphan ratio of a real numpy build
  stays low.

  *Still open:* once the IR carries an `:orphan:` flag (gen would read the
  Sphinx field-list metadata at the top of a page), promote accidental
  orphans to a hard pack error and exclude the flagged ones. Until then,
  decide whether the canonical-`index`-root vs. any-root distinction matters
  (today reachability is "appears anywhere in the toc tree", which is
  equivalent since the toc is a validated tree).

- Static export hardening for `viewer/dist/` deployment.
- Dark-adapted Shiki theme + dark-mode-aware KaTeX glyphs. *Largely done — dual
  Shiki themes already active; KaTeX `.katex-html` `color: inherit` rule added.*
- Cross-package ingest correctness: TODOs around version resolution for
  `Figure`/`RefInfo` across packages (see `ingested_doc.py`).
- **Viewer: crossrefs should default to latest-version-only.** *Done.*
  `bucketBackrefs` in `viewer/src/lib/qualname-page.ts` now filters to the
  latest *linking* version per source package (uses `compareVersionsDesc` from
  `ir-reader.ts`). Wildcard versions (`"?"`, `"*"`) are always kept. Tests in
  `viewer/tests/qualname-page.test.ts`. Precomputed table and PEP 440
  pre-release exclusion are still open follow-ups.

- **Viewer: Unresolved link warnings** *Landed.*
  - **Inline warnings**: `render-node.ts` already emits `<span class="xref
    unresolved" ...>` when the xref resolver returns null; `.xref.unresolved`
    styling is in `ir-nodes.css`. No further change needed.
  - **Report page** (`/project/[pkg]/[ver]/validate`): *Landed.* Walks every
    doc in the bundle, batch-resolves all CrossRefs (papyri graph + external
    inventory), and groups the still-unresolved ones by page. Added
    `collectXrefsDetailed` to `xref.ts` to carry display values alongside
    ref tuples.

- **Bundle staging area** (captured 2026-05-20).
  Support uploading a bundle into a *staging* zone that is isolated from the
  main cross-linked graph — no backrefs computed, easy to drop atomically.

  *Use cases:*
  - Review a PR's documentation before merging: upload the PR build to staging,
    browse it, discard it when the PR is merged or closed.
  - Release-candidate review: publish a `1.2.0rc1` bundle to staging so
    maintainers can check rendered output before cutting the final release.
  - The staged bundle should never appear in cross-package "Referenced by"
    lists or pollute the global search index.

  *Design notes:*
  - Staging is a namespace, not a separate pipeline. The ingest engine runs
    the same parsing logic but writes into a `_staging/<pkg>/<ver>/` zone
    (raw archive) and a separate `staging_*` set of graphstore tables (or a
    `staging` flag column on the existing tables).
  - No backrefs are computed for staged bundles. Ingest may resolve *outgoing*
    refs from the staged bundle against the main graph (so maintainers see
    which of their own cross-refs are still live), but the main graph's
    backref tables are not updated.
  - Drop semantics: deleting a staged bundle is a single table/row drop with
    no cascading side-effects on other bundles.
  - Upload endpoint: `POST /api/bundle?staging=1` (or a separate
    `POST /api/bundle/staging`). The viewer should make the staging zone
    visually distinct (e.g. a persistent "STAGING" banner, excluded from the
    default bundle list on the home page).
  - Promotion path (later, not required for v1): an explicit
    `POST /api/bundle/staging/<pkg>/<ver>/promote` that moves the raw
    archive to the main zone and re-ingests it into the full graph.
  - Staging bundles are not subject to the "only latest backrefs" dedup rule
    since they have no backrefs; that simplifies staging-aware backref logic.
  - Auth: staging upload should require the same credentials as normal upload;
    viewing staged bundles may optionally require login (prevents leaking
    pre-release content to unauthenticated visitors).

  *Open questions:*
  - TTL / automatic eviction: should staged bundles auto-expire after N days,
    or require an explicit delete? Lean toward explicit delete for v1.
  - Whether `GET /[pkg]/[ver]/` for a staged bundle shows a warning banner
    (probably yes, reuse the version-status-banner infrastructure from above).

  *Files to create/modify (when implemented):*
  - `ingest/src/ingest.ts` — `staging` flag; skip backref writes when set
  - `viewer/src/pages/api/bundle/[...path].ts` — pass flag to ingest
  - `viewer/src/lib/graphstore.ts` — `listStagingBundles`, `dropStagingBundle`
  - `viewer/src/pages/[pkg]/[ver]/index.astro` — staging banner
  - `viewer/src/pages/staging.astro` — list of all staged bundles (admin view)

- **Incoming broken-link report page** *Landed.*
  `/project/[pkg]/[ver]/backref-validate` lists every incoming cross-reference
  from other bundles that points at a node in `(pkg, ver)` with `has_blob=0`
  (a placeholder that was never ingested — i.e. the symbol no longer exists).
  Results are grouped by source bundle and capped at 500 rows. The bundle
  index page (`/project/[pkg]/[ver]/`) shows a count badge for broken incoming
  refs (via `countBrokenBackrefs`) and links to both diagnostic pages.
  `getBrokenBackrefs` / `countBrokenBackrefs` live in `graph.ts`.

  *Still open:* precompute the count at ingest time into a `bundle_stats` row
  so the badge is a single row lookup rather than a COUNT query on startup.

### Gen-time diagnostics

- **Warnings should be promotable to errors, and most should be errors by
  default — configurable per fully-qualified target.**
  Today `papyri gen` emits a wide range of warnings (unresolved refs, malformed
  docstring sections, unparseable signatures, broken doctest blocks, etc.) and
  the run keeps going. For maintainers who want their bundle to be
  *actually* clean, a warning is just noise that scrolls past in CI. The
  proposal:

  1. Give every diagnostic a stable *warning code* (e.g. `W-unresolved-ref`,
     `W-bad-section`, `W-doctest-syntax`, …), surfaced in the message and in
     the manifest's error report.
  2. Each code has a default severity. **Most should default to `error`** —
     a malformed docstring is a bug the maintainer wants to know about, not a
     warning to be ignored. A small allowlist (e.g. "missing extended
     summary") stays at `warning` or `info`.
  3. Severity is overridable from the project's `papyri.toml`, both globally
     and on a **per-fullqual** basis, so a maintainer can downgrade a single
     stubborn symbol without weakening the whole project. Sketch:

     ```toml
     [tool.papyri.diagnostics]
     # global default override (optional)
     "W-unresolved-ref" = "error"

     [tool.papyri.diagnostics.per-target]
     "numpy.ma.MaskedArray.*" = { "W-unresolved-ref" = "warning" }
     "scipy.special._ufuncs.*" = { "W-bad-section" = "ignore" }
     ```

     Matching is by glob on the fully-qualified name of the object whose doc
     produced the diagnostic (module / class / function / parameter / narrative
     doc page). Narrative pages match on their doc path.
  4. `papyri gen` exits non-zero if any diagnostic resolved to `error` (after
     per-target overrides). A `--no-error-on-warning` / `--max-severity`
     escape hatch keeps the legacy "warn and continue" behaviour available for
     incremental adoption.
  5. The error report already embedded in the manifest gains the resolved
     severity per entry, so the viewer can render a real "0 errors / N
     warnings" badge per bundle and drill down by code.

  *Why this matters:*
  - Aligns papyri with the rest of the Python toolchain (ruff, mypy,
    pytest) where the maintainer picks the strictness, not the tool.
  - Per-fullqual overrides are the realistic adoption path for big projects
    (numpy, scipy) where some legacy corners cannot be fixed in one pass but
    the rest of the project should still gate on clean docs.
  - Stable codes make the override file diff-reviewable and grep-able.

  *Open questions:*
  - Whether codes live in a single enum in `error_collector.py` or alongside
    the site that raises them.
  - Whether per-target overrides should also support a `[[per-target]]`
    array-of-tables form for ordered, first-match-wins semantics (more like
    `.gitignore`) instead of a dict.
  - Interaction with `--no-infer`: some diagnostics only fire with inference
    on; the default severity table should make that explicit.

  *Files to create/modify (when implemented):*
  - `papyri/error_collector.py` — diagnostic codes + severity resolution.
  - `papyri/config.py` / `papyri/config_loader.py` — `[tool.papyri.diagnostics]`
    schema, glob matcher.
  - `papyri/cli/gen.py` — non-zero exit on resolved errors, `--max-severity`
    flag.
  - `papyri/gen.py` and `papyri/tree.py` — tag each `error_collector` call
    site with its code.
  - `docs/` — document the codes and the override file.

## Codebase cleanup follow-ups (audited 2026-05-01)

Items below come from a full-tree review (Python / TS ingest / viewer). Each
is intended to be its own small PR. Items already covered elsewhere in this
file are cross-referenced rather than duplicated.

### Cross-format

- **CBOR-encode the manifest at pack time.** The bundle directory (what
  `papyri gen` writes) is a human-readable staging area — JSON is fine there.
  CBOR lives only in the packed `.papyri` artifact. The manifest is already
  embedded in the CBOR-encoded `Bundle` node, but via a JSON read
  (`_read_meta` in `pack.py`). A future cleanup: represent the manifest as a
  typed struct inside `Bundle` rather than a freeform JSON-derived dict, so
  the round-trip is fully typed from `pack.py` onward. The corresponding
  change in `ingest.ts` is the `PapyriMeta` reader. The on-disk `papyri.json`
  stays JSON — it is intentionally human-readable.

### Python (`papyri/`)

- **LRU-cache `ts.parse()` results** (`ts.py:1132`; callers in `gen.py` around
  lines 557/578/1012/1441/1704). The parser is invoked many times per gen run;
  even if duplication is rare, an LRU around `ts.parse()` is cheap insurance and
  removes a per-call cost. Note the contrasting case in `tree.py` where
  `@lru_cache` was *removed* because mutated nodes broke equality — `ts.parse()`
  operates on raw strings and produces fresh trees, so it does not have that
  hazard.
- **Decompose `Gen.collect_api_docs`** (`gen.py:1763`, ~315 lines).
  Split into module-walk / doc-extract / IR-emit so each step is testable in
  isolation.
- **Directive handler registry redesign** — *partially done.* An explicit
  registry dict now exists (`tree.py:690` `self._handlers`, keyed by the exact
  directive name so hyphenated names like `code-block` work). But the legacy
  `"_" + name + "_handler"` getattr convention is still the *first* dispatch
  path (`tree.py:958`, falling back to `self._handlers.get(...)` at line 960),
  and `_autosummary_handler` / `_toctree_handler` still rely on it. Finish the
  job by removing the getattr dispatch so the dict is the only mechanism.
  Combine with the "no global state" / `DirectiveContext` work above.
- **Fix stale `papyri ingest` reference.** *Landed.* `describe.py` now points
  at `papyri upload` and `POST /api/reingest` instead of the removed
  `papyri ingest` CLI.

(Resolved and removed: "Document the two serialization paths" — both
`node_serializer.py` and `serde.py` now carry module-level docstrings that
cross-reference each other.)

(Already tracked above and not repeated here: `_GITHUB_SLUG` global,
`DirectiveContext` injection, graphstore write-side audit, missing
directives.)

### TypeScript ingest (`ingest/`)

(Resolved and removed: "Extract shared schema bootstrap" and "Deduplicate ref
resolution" are moot — `viewer/src/lib/graphstore.ts` no longer exists. Schema
bootstrap lives only in `ingest/src/ingest.ts`, and forward/back-ref queries
moved to `viewer/src/lib/graph.ts`; `_getForwardRefs` is gone with the
directory-ingest path. "Async fs in `ingest()`" is also resolved — the
directory `ingest()` pipeline was deleted; the surviving `readFileSync` is only
in the one-time synchronous `loadSchemaFromDisk` DB-init path.)

- **Type-safe key parsing.** *Landed.* `visitor.ts` now uses `keyStr` from
  `keys.ts` for all key-string construction. `parseKeyStr(s) → Key` added to
  `keys.ts` as a validated inverse that fails loudly if the string has fewer
  than four `/`-separated segments; `path` may itself contain `/`.
- **Unify forward-ref collection.** `collectForwardRefs` (`visitor.ts:45`) and
  `collectForwardRefsFromSection` (`visitor.ts:105`) walk the same node types
  with slight differences. Parameterize the input subtrees so the walker is
  shared; today the `Figure`-handling branch only exists in `collectForwardRefs`.

### Viewer (`viewer/`)

- **Precompute bundle indices at ingest time.** The shared `walkBundle` /
  `walkAllBundles` helper now exists (`viewer/src/lib/bundle-walk.ts`) and is
  used by `image-index.ts` and the node-browser endpoint, but the `~25s
  /images/` scan is still a live scan. The remaining work: move it into the
  ingest pipeline as a `nodes_by_type` table so endpoints query rather than
  scan. Per the "Storage invariant" section, these tables are free to hold
  whatever shape the endpoint wants — they need not mirror IR node structure,
  since re-ingest can rebuild them from the raw archive.
- **CSS dead-code audit.** `global.css` has grown to ~1563 lines and
  `ir-nodes.css` to ~536. The previously-flagged selectors (`.sidebar-flat` /
  `.sidebar-qualnames`, `.bundle-index-card*`) turned out to be live — all are
  still referenced by `BundleSidebar.astro` and the bundle index page, so they
  are NOT dead. A general audit/consolidation pass on the grown stylesheets may
  still be worthwhile, but start from a fresh unused-selector check rather than
  the old (now-stale) list.
- **Admonition styling.** *Done.* `render-node.ts` now emits
  `admonition-${kind}` per-kind CSS class; `ir-nodes.css` has per-kind color
  tokens and SVG icons for note, warning, tip, deprecated, versionadded,
  versionchanged, seealso, danger, caution, hint, etc.
- **Auth is intentional but minimal.** `middleware.ts` uses a three-tier model:
  - *Always public*: `/login`, `/api/auth/`, `/api/bundle` (upload endpoint uses
    its own bearer-token check).
  - *Admin-only* (requires a session whose user has `is_admin`): `/admin`,
    `/nodes`, `/ir-stats`, and their backing API endpoints (`/api/nodes.json`,
    `/api/ir-stats.json`, `/api/clear`, `/api/clear-raw`, `/api/reingest`,
    `/api/inventory`, `/api/stats`, `/api/users`, `/api/projects`). These are
    gated because they are computationally expensive (full corpus walks),
    destructive, or manage accounts / project membership. A signed-in non-admin
    is redirected (`/`) or gets a JSON 403.
  - *Signed-in (any role)*: `/settings`, `/api/account/*` — self-service account
    management (change password, mint/revoke personal upload tokens).
  - *Guest-accessible*: everything else — bundle index, all qualname/doc/example
    pages, text search, assets. Guests can browse documentation without an
    account.

  Unauthenticated page requests redirect to `/login`; API requests get a JSON
  403. The middleware *validates* the session token against the auth store
  (looks it up and checks expiry), not merely its presence.

  **User/session store (landed).** Accounts and sessions live in a real SQLite
  database (`viewer/src/lib/auth-db.ts`), separate from the graph store so the
  derived-cache wipe/reingest never touches them (`PAPYRI_AUTH_DB`, default
  `~/.papyri/auth.db`). Passwords are hashed with Argon2id (`@node-rs/argon2`)
  and verified in constant time; sessions are opaque random tokens stored
  server-side with `created_at` + `expires_at` (7-day TTL), so logout and user
  deletion revoke them and expired tokens are rejected and pruned. On first run
  an initial admin is seeded from `PAPYRI_USERNAME`/`PAPYRI_PASSWORD` *only when
  no users exist*; with neither set, login fails closed (no `admin`/`password`
  fallback) — except under `pnpm dev`, where a throwaway demo admin
  (`admin`/`password`, surfaced on the login page) is seeded for convenience.
  That dev seed is gated by `PAPYRI_DEV_SEED` (`1` forces it on even in a
  build, `0` disables it; unset defaults to `import.meta.env.DEV`) and never
  fires in a production build by default. Admins manage accounts from the admin panel
  (`UserManagementPanel.tsx` → `/api/users`). This resolves the three "auth
  hardening" TBD items below (default creds, unsigned/never-expiring session,
  constant-time compare) for the login path; the upload bearer-token compare in
  `PUT /api/bundle` now also uses `crypto.timingSafeEqual` (see below).

  **Per-user upload authorization (landed).** Users carry an `is_admin` flag
  (`users.is_admin`); a logged-in non-admin can manage their own account but
  not the admin tools (`middleware.ts` gates `ADMIN_ONLY_PREFIXES` on the
  role). An admin creates *projects* — a project is a package/module name —
  and assigns users to them (`projects` / `project_members` tables, managed via
  `/api/projects` and `/admin/projects`). Each user mints personal upload
  tokens (`upload_tokens`, shown once, only the SHA-256 stored) from
  `/settings` via `/api/account/tokens`. `PUT /api/bundle` authenticates the
  bearer to a principal (global `PAPYRI_UPLOAD_TOKEN` → any project; personal
  token → its user; no token + no global token + zero users → open local-dev)
  and then authorizes it for the bundle's `module`: admins and the global token
  may upload anything, a user only the projects they are a member of (resolved
  live, so revoking membership takes effect immediately). The global
  `PAPYRI_UPLOAD_TOKEN` is retained as a CI / local-dev escape hatch. Viewing
  bundles remains open to guests; only the *upload* scope is enforced per user.

### Cross-cutting

- Several items above (schema loader, ref resolution, key parsing) reflect a
  larger pattern: `ingest/` and `viewer/` independently maintain near-copies
  of the graph layer. Once the schema stabilises, consider promoting the
  shared bits into the `papyri-ingest` package and having the viewer import
  from it rather than re-implementing.

## Security review follow-ups (audited 2026-05-27)

A multi-agent review of the whole tree surfaced the items below. The
path-traversal and `javascript:`/`data:` URL items were fixed in the same
pass; the rest are recorded here as TBD so the next PR can pick them up.

### Fixed in this pass

- **Path traversal in the FS stores.** `FsBlobStore`/`FsRawStore` now route
  every on-disk path through `safeJoin` (`ingest/src/fs-safe.ts`), which
  refuses any key whose resolved path escapes the store root. This closes both
  the ingest write vector and the unauthenticated read vector in
  `viewer/src/pages/api/[pkg]/[ver]/raw.json.ts` (it uses the same
  `FsBlobStore`). `papyri unpack` got the equivalent guard (`_safe_child` in
  `pack.py`) for untrusted artifact keys.
- **`javascript:`/`data:` URLs in Link/Image.** A shared scheme allowlist
  (`ingest/src/url-safety.ts`, `isSafeUrl`) is enforced at three layers: the
  renderer blanks unsafe `href`/`src` (`render-node.ts`, the guaranteed
  defense), and both ingest (`assertSafeUrls`) and `papyri pack`
  (`_assert_safe_urls`) reject a bundle that carries one. Pack/ingest can't be
  assumed to have run on a given bundle, which is why the renderer sanitises
  too.
- Smaller correctness fixes: `tree.py` interpreted-text split
  (`split(" <", 1)`); `node_base._invalidate` list/dict branch + error-path
  string; dedup pre-check now has a finite HTTP timeout
  (`_DEDUP_TIMEOUT_S`); the viewer bundle endpoint no longer echoes raw
  backend errors to the client (logs server-side instead).

### TBD — auth hardening (viewer)

- **Default credentials.** *Done.* Login no longer ships `admin`/`password`.
  Auth is backed by a real user store (`viewer/src/lib/auth-db.ts`); with no
  users and no `PAPYRI_USERNAME`/`PAPYRI_PASSWORD` seed, every login fails
  closed and a warning is logged.
- **Session token is unsigned and never expires server-side.** *Done.* Sessions
  are now opaque random tokens persisted server-side with `created_at` +
  `expires_at`; the middleware looks the token up and enforces expiry (instead
  of the old unverified `base64(user:timestamp)` cookie). Expired tokens are
  rejected and pruned; logout / user-delete revoke them. (An HMAC-signed
  stateless cookie was the original suggestion, but a server-side session table
  was chosen so sessions can be revoked and audited.)
- **Constant-time comparison.** *Done.* Login password verification uses
  Argon2's constant-time verify, with a decoy hash compared on unknown
  usernames so timing does not leak account existence. The bundle upload
  bearer-token check in `PUT /api/bundle` now compares the global
  `PAPYRI_UPLOAD_TOKEN` with `crypto.timingSafeEqual` (`timingSafeEqualStr` in
  `api/bundle.ts`); personal upload tokens are looked up by SHA-256 hash, not
  string-compared.

### TBD — upload / ingest robustness

- **Streaming PUT has no timeout.** *Done.* `_UPLOAD_IDLE_TIMEOUT_S = 300` wired
  into the PUT at `upload.py:363`; `TimeoutError` caught alongside the existing
  `HTTPError`/`URLError` handlers.
- **Zip-bomb guard on upload.** *Done.* `_load_from_zip` has a 256 MiB ceiling
  checked against `ZipInfo.file_size` and the actual read (`read(_MAX_BUNDLE_BYTES + 1)`).
- **`assertBundle` validates shape shallowly.** *Done.* `ingest/src/bundle.ts`
  validates non-empty `module`/`version` strings and all record fields (`api`,
  `narrative`, `examples`, `aliases`, `extra`, `toc`, `assets`) as non-null objects.
- **`inflateZlib` corrupt-body handling** (`ingest/src/inventory.ts`). A
  malformed `objects.inv` body rejects the decompression stream and throws to
  the caller, despite the "skip bad lines" comment. Wrap parse/inflate and
  surface a clean error.

### TBD — SSRF (viewer, matters for the hosted service)

- **Intersphinx inventory fetch** (`viewer/src/pages/api/inventory.ts`,
  `ingest/src/inventory.ts`). The endpoint fetches an admin-supplied
  `inventory_url`/`base_url` with no host restriction — `isHttpUrl` permits
  internal/link-local hosts (e.g. `http://169.254.169.254/…`). Admin-gated
  today, so low risk, but on the multi-tenant hosted service this is a
  metadata-endpoint SSRF vector. Block private/link-local ranges and disable
  redirects to them before hosting.

### TBD — minor

- **Dead `Signature` properties** (`papyri/signature.py`). *Resolved — not
  present.* `is_generator`, `is_async_generator`, `is_async_function` were
  absent from the code when audited; no change needed.
- **`removedRefStrs` reparses keys by `/`-split** (`ingest/src/ingest.ts`).
  *Resolved — not present.* `existingRefs` already stores `Key` objects as
  values; `removedRefs` is `Key[]` with no string re-parsing needed.
