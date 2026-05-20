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

- Minimum: **Python 3.14**. `requires-python = ">=3.14"`.
- CI matrix: `3.14` only. Add newer versions later; don't carry legacy ones.

## Dependency notes

- RST parsing uses `py-tree-sitter-rst` (PyPI) on top of `tree-sitter >= 0.24`.
  Do not reintroduce `tree_sitter_languages` or `tree-sitter-language-pack`.
- `numpy`, `scipy`, `astropy`, `IPython` in the CI matrix drift frequently;
  pin each matrix entry to a known-good version or xfail with a reason.

## Open work

### Phase 6b — gen-side encoding

Keep `papyri gen` writing a per-file directory tree as today, but consider
switching the on-disk encoding to JSON so that standard tooling (`jq`,
`diff`, text grep) and custom maintainer workflows can inspect and verify the
intermediate output before `pack` runs. The contract `pack` produces stays
the binary `.papyri` artifact; the per-file form is a debugging and
customization surface, not a publication format.

Explicitly *not* in scope: making `gen` produce a `.papyri` directly —
that would close off the inspect-and-modify workflow.

### Viewer — M9 (Cloudflare Workers)

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
    every concurrent upload. The per-bundle shape probably wins on the
    hosted service (D1) where write contention matters.
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
    from_ver)` with a covering index. D1 doesn't love DDL churn; one
    table with a partition column is probably the realistic shape.
  - **Interaction with the "graphstore is a derived cache" invariant.**
    This is purely a denormalization choice — no IR contract changes,
    no raw-archive impact — so it's exactly the kind of change the
    invariant says we're free to make. The question is just whether it
    pays off.

  Not a decision yet; capture and revisit when backref latency or
  ingest write contention becomes a measured problem.

## Follow-ups (not yet scheduled)

- **Missing block directives for numpy / scipy / IPython builds.**
  Audited 2026-04-30. The following directives are encountered when running
  `papyri gen` against these packages but have no handler; they fall through
  to a raw `Directive` node in the IR.

  *High priority* (very common; materially degrades output):
  - `rubric` — unnumbered section heading (`.. rubric:: References`). Used
    in all three packages for headings that must not appear in the TOC. Should
    produce a lightweight `Section`-like node or an `Admonition`.

  *Medium priority* (structural / ref-resolution impact):
  - `only` — conditional content (`.. only:: html`). Content inside should be
    included at gen time (papyri targets HTML) or dropped with a log message.
  - `currentmodule` — `.. currentmodule:: numpy`. Sphinx directive that shifts
    the implicit module prefix for subsequent cross-refs. Gen has no hook for
    it; refs in sections that follow it silently fail to resolve.
  - `testsetup` / `testcleanup` / `testcode` / `testoutput` — doctest
    infrastructure directives used in numpy / scipy narrative docs. Should be
    added to `_SPHINX_ONLY_DIRECTIVES` (silently dropped), not emitted as IR
    nodes.

  *Low priority* (infrequent or render-only):
  - `highlight` — sets the default code-highlight language for a section.
    Safe to ignore or silently drop.
  - `plot` — matplotlib's plot directive; requires a live matplotlib build.
    Add to `_SPHINX_ONLY_DIRECTIVES`.
  - `literalinclude` — includes a source file verbatim. Needs filesystem
    access at gen time; drop with a warning for now.
  - `list-table` / `csv-table` — structured table directives (scipy). No IR
    table node exists yet; emit verbatim `Code` as a stopgap.
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
- Rename `crosslink.py` to something that reflects its current read-only role
  (`ingested_doc.py`?), or fold `IngestedDoc` into `nodes.py`.
- Audit `papyri/graphstore.py`: the write-side methods are no longer called
  by the Python side (TypeScript ingest is the sole writer). Slim it to a
  read-only interface — the viewer's store is a derived cache (see "Storage
  invariant" above), so the Python side has no reason to write into it.
- Decide the future of `papyri find` / `describe` / `diff` / `debug`: they
  work against the store written by the TypeScript pipeline, but the viewer
  is the user-facing replacement.
- **RST substitution invariant.** The IR must never contain `SubstitutionDef`
  or `SubstitutionRef` nodes. Non-`replace::` substitution types (image,
  unicode) are warned and dropped; support can be added per demand.
- **Separate domains/processes for upload, admin, and user surfaces.**
  In a hosted deployment the upload endpoint (`POST /api/bundle`), any admin
  panel, and any per-user management UI should run as isolated processes (or
  Workers routes) on separate subdomains. Keeping them isolated limits blast
  radius: a vulnerability in the upload path cannot reach admin state, and
  per-user surfaces cannot touch other users' bundles. Design URL structure
  and routing with this separation in mind so the hosted service is not baked
  into a monolithic app. Track this when the M9 / hosting design firms up.

- **Track raw upload timestamps independently of bundle metadata.**
  The `_raw/<pkg>/<ver>.papyri.gz` archive should record when a bundle was
  *received* (server wall-clock time), kept separate from any timestamps
  embedded in the bundle itself (which are controlled by the uploader and
  cannot be trusted for audit purposes). Store as a lightweight metadata
  sidecar (e.g. `_raw/<pkg>/<ver>.meta.json`) or a dedicated index table.
  Enables audit logs, "most-recently-uploaded" sorting, and TTL / eviction
  policies without trusting generator-side clocks.

- **`papyri pack` strict mode and bundle linting.**
  Add a `--strict` flag to `papyri pack` that promotes warnings to errors,
  useful in CI to block publishing a bundle with known issues. Add a `--lint`
  flag (or a `papyri lint` subcommand) that checks IR consistency without
  fully packing: unresolved local refs, assets referenced but absent from the
  asset store, `SubstitutionRef`/`SubstitutionDef` nodes that should have been
  resolved, empty module-docstrings holding a sentinel placeholder rather than
  a parse failure marker. A `--strict --lint` step in maintainer CI gives fast
  feedback before upload.

- Static export hardening for `viewer/dist/` deployment.
- Dark-adapted Shiki theme + dark-mode-aware KaTeX glyphs.
- Cross-package ingest correctness: TODOs around version resolution for
  `Figure`/`RefInfo` across packages (see `crosslink.py`).
- **Viewer: crossrefs should default to latest-version-only.**
  The "Referenced by" section on a qualname page currently lists one row per
  source `(pkg, ver)` that links here. When several versions of the same
  package have been uploaded, the same logical reference shows up N times
  (e.g. numpy 1.26 and numpy 2.0 both linking to a scipy symbol). Users
  almost always want a single row per source package, pointing at its
  latest version.

  *Where this lives in the code:*
  - `viewer/src/lib/graph.ts:109` `getBackrefs` — SQL that fetches every
    incoming `(pkg, ver, kind, path)`. Cheapest place to filter, but the DB
    doesn't know what "latest" is.
  - `viewer/src/lib/qualname-page.ts:75` `bucketBackrefs` — view-model layer
    that already dedupes; the natural place for a render-time filter.
  - `viewer/src/lib/ir-reader.ts:35,61` already have `compareVersionsDesc`
    and `listIngestedPackages` (which knows the latest version per package);
    reuse those rather than reimplementing PEP 440 sort logic.

  *Design — open questions to settle before implementing:*
  1. **What is "latest"?** Use `listIngestedPackages(...).latest` (latest
     ingested, including pre-releases) for now. A future refinement could
     exclude `.dev` / `rc` / `alpha` / `beta` per PEP 440, matching the
     version-status-banner classifier in the next item.
  2. **Filter scope.** Group backrefs by source `pkg`, keep only the row
     whose `ver` equals that package's latest. Cross-package and same-package
     buckets get the same treatment.
  3. **What if the link only exists in an older source version?** (e.g.
     numpy 1.26 references a symbol that numpy 2.0 has dropped.) Two
     options: (a) drop the ref entirely — clean but hides real signal;
     (b) keep the latest *version that actually links here* per package —
     preserves signal at the cost of a slightly fuzzier "latest" rule.
     Recommendation: (b), since the alternative silently loses information.
  4. **Toggle.** Add a "show all versions" affordance (querystring
     `?all-versions=1` or a small toggle) so the raw list is still
     reachable for debugging and for the validate page.
  5. **Where to filter.** Render-time in `bucketBackrefs` is simplest and
     keeps the graphstore generic. A precomputed `latest_backrefs` table is
     a later optimization once the rule is stable (see "Storage invariant"
     — derived tables are free to denormalize).

  *Tests to add (`viewer/src/lib/qualname-page.test.ts` or equivalent):*
  - Same package, two versions both linking → one row, latest version's URL.
  - Same package, only the older version links → that row is kept (rule b).
  - Multiple source packages, each with multiple versions → one row per
    source pkg, each pointing at its latest linking version.
  - Pre-release vs. stable: `2.0.0rc1` vs. `1.26.4` — document the chosen
    behaviour and pin it with a test (will need updating when the PEP 440
    refinement in (1) lands).
  - Wildcard-version stubs (`?` / `*`) that `getBackrefs` already emits for
    unresolved cross-package refs: decide whether they count as "latest" or
    are always shown / always hidden, and lock it in a test.
  - `?all-versions=1` (or whatever toggle): returns the unfiltered list,
    matching today's behaviour.

  *Out of scope for the first PR:* PEP 440 pre-release exclusion (item 1),
  precomputed table (item 5). Land the render-time filter + tests first.

- **Viewer: Version status banners and link validation warnings** (designed 2026-05-04).
  Help users understand documentation state with banners and link warnings.
  
  *Features to implement:*
  - **Version status banner** (top of page, dismissible): Show when browsing non-latest,
    dev, or pre-release versions. Use PEP 440 pattern matching (`.dev`, `rc`, `alpha`,
    `beta`) to classify versions. Include "Go to latest" link for old versions.
  - **Unresolved link warnings** (inline + optional report page): Display special styling
    (strikethrough, error color) on CrossRef nodes where `.exists === false`. Optional
    `/[pkg]/[ver]/validate` page shows all unresolved refs in a bundle grouped by
    location and kind.
  
  *Design notes:*
  - Version detection uses string patterns, no IR schema changes needed.
  - Banner dismissal persists in `sessionStorage` (clears on browser close).
  - Reuses existing `.admonition` styling patterns and warn/error color tokens.
  - Link validation leverages `CrossRef.exists` property computed by gen.
  - Render-time detection only; defer CLI/background validation tooling.
  
  *Alternative approaches considered:*
  - Version detection: metadata flags in bundle (no, for backward compat)
    vs. config file (no, too complex for multi-project)
  - Banner placement: sidebar (less discoverable) vs. breadcrumb (easy to miss)
    vs. floating widget (non-standard) — top-of-page chosen for visibility
  - Link warnings: inline-only (no overview) vs. report-only (proactive nav needed)
    vs. prevent-upload (blocks legitimate forward refs) — both chosen for balance
  - Link validation: ingest-time (slower, redundant) vs. hybrid (complex schema)
    — render-time chosen for simplicity
  
  *Files to create/modify (when implemented):*
  - `viewer/src/lib/version-utils.ts` — version status classification
  - `viewer/src/components/VersionBanner.astro` — banner component
  - `viewer/src/layouts/BundleLayout.astro` — inject banner
  - `viewer/src/components/CrossRef.tsx` — add unresolved styling
  - `viewer/src/styles/ir-nodes.css` — `.unresolved-ref` styles
  - `viewer/src/pages/[pkg]/[ver]/validate.astro` — optional report page

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

- **Incoming broken-link report page** (captured 2026-05-20).
  A per-bundle report page at `/[pkg]/[ver]/backref-validate` (or similar)
  that lists every *incoming* cross-reference from other bundles that no
  longer resolves — i.e. another package links to an identifier or page that
  this bundle no longer exports.

  *Why this matters:*
  - When a maintainer renames or removes a public API symbol, all other bundles
    that referenced the old name now have dangling links. Today this is silent.
  - The report lets maintainers audit the real-world breakage before releasing,
    and lets downstream maintainers discover that the API they depend on has
    moved.

  *Data model:*
  - At ingest time the graph already stores `(source_pkg, source_ver,
    source_path, dest_pkg, dest_ver, dest_kind, dest_identifier)` in the
    `links` table (or per-bundle refs table if that design lands).
  - A broken incoming link is one where `dest_identifier` no longer exists in
    the current `nodes` table for `(dest_pkg, dest_ver)`.
  - The query is straightforward: `SELECT * FROM links WHERE dest_pkg = ? AND
    dest_ver = ? AND NOT EXISTS (SELECT 1 FROM nodes WHERE pkg = dest_pkg AND
    ver = dest_ver AND identifier = dest_identifier)`.
  - Results are grouped by `(source_pkg, source_ver)` and by kind
    (module-level ref vs. parameter ref vs. narrative-doc ref).

  *Design notes:*
  - This is a read-only, render-time query — no IR changes needed.
  - The page is linked from the bundle's index page (e.g. a small
    "N unresolved incoming refs" badge) so maintainers can find it without
    knowing the URL.
  - Distinct from the *outgoing* unresolved-ref report (`/validate`) which
    shows links this bundle makes to others that don't resolve. Both pages
    are useful; they answer different questions (am I breaking others? vs. am
    I referring to something that no longer exists?).
  - For staging bundles, run the same query against the staging graph —
    useful for verifying that a PR's doc changes don't introduce new broken
    incoming links before merging.
  - Pagination or truncation at ~500 rows for large packages (e.g. numpy) to
    avoid unbounded page loads.

  *Open questions:*
  - Whether to surface the report in the main navigation or only via the badge
    link — start with badge-only to keep noise down.
  - Whether ingest should eagerly precompute the broken-backref count and
    store it as a `bundle_stats` row so the badge renders without an
    additional query per page load.

  *Files to create/modify (when implemented):*
  - `viewer/src/lib/graph.ts` — `getBrokenBackrefs(pkg, ver)` query
  - `viewer/src/pages/[pkg]/[ver]/backref-validate.astro` — report page
  - `viewer/src/pages/[pkg]/[ver]/index.astro` — broken-backref count badge

## Codebase cleanup follow-ups (audited 2026-05-01)

Items below come from a full-tree review (Python / TS ingest / viewer). Each
is intended to be its own small PR. Items already covered elsewhere in this
file are cross-referenced rather than duplicated.

### Python (`papyri/`)

- **LRU-cache `ts.parse()` results** (`gen.py:534/555/979/1349/1610`). The
  parser is invoked many times per gen run; even if duplication is rare, an
  LRU around `ts.parse()` is cheap insurance and removes a per-call cost. Note
  the contrasting case in `tree.py:54` where `@lru_cache` was *removed*
  because mutated nodes broke equality — `ts.parse()` operates on raw strings
  and produces fresh trees, so it does not have that hazard.
- **Decompose `Gen.collect_api_docs`** (`gen.py:1667–1978`, ~280 lines).
  Split into module-walk / doc-extract / IR-emit so each step is testable in
  isolation.
- **Directive handler registry redesign** (`tree.py:597–821`). Replace the
  `"_" + name + "_handler"` string-key convention with an explicit registry
  dict. The current scheme cannot express directive names containing
  hyphens (e.g. `code-block`) without ad-hoc wiring. Combine with the
  "no global state" / `DirectiveContext` work already listed above.
- **Replace assertion-based arg validation in `Node.__init__`**
  (`node_base.py:31`). Use `TypeError`/`ValueError` so behaviour does not
  change under `python -O`.
- **Document the two serialization paths.** `node_serializer.py` (CBOR-side,
  internally tagged) and `serde.py` (generic dataclass round-trip, JSON or
  CBOR) coexist and are not duplicates. Add a short module-level comment in
  each pointing at the other so contributors know which to extend.

(Already tracked above and not repeated here: `_GITHUB_SLUG` global,
`DirectiveContext` injection, graphstore write-side audit, missing
directives.)

### TypeScript ingest (`ingest/`)

- **Extract shared schema bootstrap.** `migrationsDir`, `loadSchemaFromDisk`,
  `splitStatements`, and the `PRAGMAS` constant are duplicated between
  `ingest/src/ingest.ts:86–107` and `viewer/src/lib/graphstore.ts:60–91`.
  Move into a shared module (most natural home: a new export from the
  `papyri-ingest` package consumed by the viewer).
- **Deduplicate ref resolution.** `_getForwardRefs` (`ingest.ts:455–475`)
  duplicates `getForwardRefs` / `getBackRefs` (`viewer/src/lib/graphstore.ts:277–322`).
  Parameterize direction and share the row-mapping helper.
- **Type-safe key parsing.** `visitor.ts:78/90/122` and
  `viewer/src/lib/graphstore.ts:215` use `split("/")` with silent `?? ""`
  fallbacks. Add a `parseKeyStr(s) → Key` helper alongside `keyStr` so any
  key containing `/` fails loudly instead of silently truncating.
- **Unify forward-ref collection.** `collectForwardRefs` and
  `collectForwardRefsFromSection` in `visitor.ts:45–131` walk the same node
  types with slight differences. Parameterize the input subtrees so the
  walker is shared; today the `Figure`-handling branch only exists in one of
  the two.
- **Async fs in `ingest()`.** `ingest.ts:487–489` uses `readFileSync` inside
  an async pipeline; switch to `fs/promises` to avoid blocking the loop.

### Viewer (`viewer/`)

- **Precompute bundle indices at ingest time.** PLAN's M9.2 already notes the
  `~25s /images/` scan; once `walkBundle` exists, move the work into the
  ingest pipeline as a `nodes_by_type` table so endpoints query rather than
  scan. Both the local SQLite and D1 backends benefit equally. Per the
  "Storage invariant" section, these tables are free to hold whatever shape
  the endpoint wants — they need not mirror IR node structure, since
  re-ingest can rebuild them from the raw archive.
- **CSS dead-code audit.** `global.css` (~1113 lines) + `ir-nodes.css`
  (~283 lines) carry alternate trees (`.sidebar-flat` vs
  `.sidebar-qualnames`) and feature-specific blocks (`.bundle-index-card*`)
  that look stale. Audit and consolidate.
- **Auth is intentional but minimal.** `middleware.ts` gates everything
  except `/login`, `/api/auth/`, `/api/bundle` behind a session cookie, and
  credentials come from `PAPYRI_USERNAME` / `PAPYRI_PASSWORD` env vars
  (see `api/auth/login.ts`). This is the v0 deploy gate and should stay,
  but the hardcoded-single-user model is not the long-term answer for a
  multi-tenant hosted service. Track when M9 / hosting design firms up.

### Cross-cutting

- Several items above (schema loader, ref resolution, key parsing) reflect a
  larger pattern: `ingest/` and `viewer/` independently maintain near-copies
  of the graph layer. Once the schema stabilises, consider promoting the
  shared bits into the `papyri-ingest` package and having the viewer import
  from it rather than re-implementing.
