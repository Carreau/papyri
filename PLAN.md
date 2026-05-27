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
  panel, and any per-user management UI should run as isolated processes on
  separate subdomains. Keeping them isolated limits blast
  radius: a vulnerability in the upload path cannot reach admin state, and
  per-user surfaces cannot touch other users' bundles. Design URL structure
  and routing with this separation in mind so the hosted service is not baked
  into a monolithic app. Track this when the hosting design firms up.

- **Track raw upload timestamps independently of bundle metadata.**
  The `_raw/<pkg>/<ver>.papyri.gz` archive should record when a bundle was
  *received* (server wall-clock time), kept separate from any timestamps
  embedded in the bundle itself (which are controlled by the uploader and
  cannot be trusted for audit purposes). Store as a lightweight metadata
  sidecar (e.g. `_raw/<pkg>/<ver>.meta.json`) or a dedicated index table.
  Enables audit logs, "most-recently-uploaded" sorting, and TTL / eviction
  policies without trusting generator-side clocks.

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

- **Viewer: Unresolved link warnings** (designed 2026-05-04; banner half done).
  The version status banner (`viewer/src/components/VersionBanner.astro`,
  `viewer/src/lib/version-utils.ts`) is already shipped. What remains is the
  outgoing unresolved-ref surface:

  - **Inline warnings**: Display special styling (strikethrough, error color)
    on `CrossRef` nodes where `.exists === false`.
  - **Report page** (`/[pkg]/[ver]/validate`): List all unresolved refs in a
    bundle grouped by location and kind.

  *Design notes:*
  - Link validation leverages `CrossRef.exists` property computed by gen.
  - Reuses existing `.admonition` styling patterns and warn/error color tokens.
  - Render-time only; defer CLI/background validation tooling.

  *Files to create/modify (when implemented):*
  - CrossRef rendering lives in `viewer/src/lib/render-node.ts` (string
    helpers), not a `CrossRef.tsx` component — add the unresolved styling there.
  - `viewer/src/styles/ir-nodes.css` — the `.xref.unresolved` class already
    exists (`ir-nodes.css:172,186`); wire `render-node.ts` to emit it when
    `.exists === false`.
  - `viewer/src/pages/[pkg]/[ver]/validate.astro` — report page (does not exist
    yet).

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
- **Replace assertion-based arg validation in `Node.__init__`**
  (`node_base.py:53`). Use `TypeError`/`ValueError` so behaviour does not
  change under `python -O`. (While here: `_invalidate` at `node_base.py:199`
  builds its error path as `f"{k}.{sub}." + sub`, interpolating `sub` twice —
  inconsistent with the dict/list branches that use `ii`; looks like a bug.)
- **Fix stale `papyri ingest` reference.** `describe.py:85` tells the user
  "Have you run `papyri ingest` yet?" — but there is no `papyri ingest` CLI
  (it was removed; CLAUDE.md forbids re-adding it). Point the message at
  `papyri upload` / the viewer's ingest endpoint instead.

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

- **Type-safe key parsing.** `visitor.ts` still hand-builds key strings
  (`${module}/${version}/${kind}/${path}`) with silent `?? ""` fallbacks
  (`visitor.ts:73–96, 117–127`) instead of reusing `keyStr` (`keys.ts:16`), and
  there is no inverse. Reuse `keyStr` and add a `parseKeyStr(s) → Key` helper so
  any key containing `/` fails loudly instead of silently truncating.
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
- **Admonition styling.** `Admonition` nodes render as a single generic
  `aside.admonition` (`render-node.ts`, `ir-nodes.css`) regardless of kind
  (note / warning / tip / seealso / …). Look at
  https://sphinx-immaterial.readthedocs.io/en/latest/admonitions.html for
  per-kind color tokens and icons to model richer admonition styling on.
- **Auth is intentional but minimal.** `middleware.ts` uses a two-tier model:
  - *Always public*: `/login`, `/api/auth/`, `/api/bundle` (upload endpoint uses
    its own bearer-token check).
  - *Admin-only* (requires session): `/admin`, `/nodes`, `/ir-stats`, and their
    backing API endpoints (`/api/nodes.json`, `/api/ir-stats.json`, `/api/clear`,
    `/api/clear-raw`, `/api/reingest`, `/api/inventory`, `/api/stats`). These
    are gated because they are computationally expensive (full corpus walks) or
    destructive. Unauthenticated page requests redirect to `/login`; API
    requests get a JSON 403.
  - *Guest-accessible*: everything else — bundle index, all qualname/doc/example
    pages, text search, assets. Guests can browse documentation without an
    account.

  Credentials come from `PAPYRI_USERNAME` / `PAPYRI_PASSWORD` env vars
  (see `api/auth/login.ts`). The hardcoded-single-user model is not the
  long-term answer for a multi-tenant hosted service. Track when the hosting
  design firms up.

### Cross-cutting

- Several items above (schema loader, ref resolution, key parsing) reflect a
  larger pattern: `ingest/` and `viewer/` independently maintain near-copies
  of the graph layer. Once the schema stabilises, consider promoting the
  shared bits into the `papyri-ingest` package and having the viewer import
  from it rather than re-implementing.
