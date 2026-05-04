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

## Follow-ups (not yet scheduled)

- **Missing block directives for numpy / scipy / IPython builds.**
  Audited 2026-04-30. The following directives are encountered when running
  `papyri gen` against these packages but have no handler; they fall through
  to a raw `Directive` node in the IR.

  *High priority* (very common; materially degrades output):
  - `code-block` — the primary RST code-fence directive. The
    `_code-block_handler` method name is invalid Python (hyphen), so it can
    never be wired up via the `"_" + name + "_handler"` convention. Must be
    added to the `_handlers` dict in `DirectiveVisiter.__init__`, delegating
    to the existing `_code_handler` logic.
  - `rubric` — unnumbered section heading (`.. rubric:: References`). Used
    in all three packages for headings that must not appear in the TOC. Should
    produce a lightweight `Section`-like node or an `Admonition`.

  *Medium priority* (structural / ref-resolution impact):
  - `only` — conditional content (`.. only:: html`). Content inside should be
    included at gen time (papyri targets HTML) or dropped with a log message.
  - `currentmodule` — `.. currentmodule:: numpy`. Sphinx directive that shifts
    the implicit module prefix for subsequent cross-refs. Gen has no hook for
    it; refs in sections that follow it silently fail to resolve.
  - `seealso` — block-level "See Also" admonition in RST narrative docs.
    Should be handled like `note` / `warning` (via `admonition_helper`).
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

- **Extract `walkBundle()` helper.** `src/lib/image-index.ts:1–127` and
  `src/pages/api/[pkg]/[ver]/nodes.json.ts:51–159` duplicate the
  module → docs → examples traversal; the file comments themselves
  acknowledge it. Move into `src/lib/bundle-walk.ts` and have both
  callers parameterise it with the node types they care about. This is also
  the natural home for the precomputed-index work (see next item).
- **Precompute bundle indices at ingest time.** PLAN's M9.2 already notes the
  `~25s /images/` scan; once `walkBundle` exists, move the work into the
  ingest pipeline as a `nodes_by_type` table so endpoints query rather than
  scan. Both the local SQLite and D1 backends benefit equally.
- **Shared API response utility.** `viewer/src/lib/bundle.ts:111` defines a
  `respond()` helper, but `bundles.json.ts`, `health.json.ts`,
  `search.json.ts`, and `nodes.json.ts` each hand-roll
  `new Response(JSON.stringify(...), …)` with mismatched error shapes (string
  vs JSON). Extract a small `api-utils.ts` and convert call sites.
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
