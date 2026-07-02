# Papyri plan

Source of truth for scope and ordered work. Future sessions (human or agent)
should keep it current: delete finished items keep **Open work** actionable, and update **Open questions** as
answers arrive. If this file contradicts `CLAUDE.md`, this file wins on scope.

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
  CI or build environment. Produces a self-contained DocBundle on disk. The
  DocBundle at this stage is intentionally left as JSON and lenient on
  errors/completeness, so other tools can operate on it for flexibility.
- **`papyri pack`**: packs the DocBundle into the final IR artifact for
  upload. This packed form is what should be standardized and exchangeable;
  it must be linted and contain no errors.
- **`papyri upload`**: ships the bundle to a viewer instance's
  `/api/bundle` endpoint, which runs the TypeScript ingest pipeline
  server-side to wire bundles into the cross-linked graph.
- **`viewer/`**: TypeScript web renderer. Works locally for development and
  is built with the centralized service in mind — the intended rendering
  frontend for the hosted service, not just a local debug tool. Deployed as a
  long-running Node.js server on a VPS. Milestone tracker: [`viewer/PLAN.md`](viewer/PLAN.md).
- **`ingest/`**: TypeScript `papyri-ingest` package — the canonical
  ingestion engine, invoked by the viewer's upload endpoint.

`papyri gen` is the *reference* producer, not the only intended one. The
bundle format (schema + the invariants below) is the ecosystem contract;
other producers may emerge — e.g. working from Markdown/MyST sources — and
anything that emits a valid, linted bundle is a first-class citizen. Ingest
validates and may reject (see invariants); it does not care who produced
the bundle.

The viewer lives in-tree while the IR is still in flux; co-locating producer
and consumer lets us iterate across breaking changes in one PR. Splitting into
a separate repo remains an option once the IR schema stabilizes.

The boundary between the two halves:

- `~/.papyri/data/<pkg>_<ver>/` — per-bundle IR (`papyri.json`, `toc.json`,
  `module/`, `docs/`, `examples/`, `assets/`). The per-file encoding is an
  implementation detail; do not assume JSON or CBOR exclusively.
- Storage is abstracted: the viewer and ingest pipeline must not assume a
  specific on-disk layout or wire encoding. The current implementation uses
  SQLite for the cross-link graph (`SqliteGraphDb`) and a filesystem store for
  blobs (`FsBlobStore` / `FsRawStore`). The `BlobStore` /
  `GraphDb` / `RawStore` interfaces exist kept so a backend swap stays possible,
  but this is the only implementations today.

## Invariants

These must hold; treat a change that breaks one as a bug, not a trade-off.

**Storage: the graphstore is a derived cache.**
The DocBundle (`.papyri.gz` artifact produced by `papyri gen` and `papyri pack`, archived
verbatim at `_raw/<pkg>/<ver>.papyri.gz`) is the **only** authoritative IR.
Everything in the viewer's graphstore + blob store is a derived projection,
rebuildable via `POST /api/reingest`. Consequence: **what ingest writes into
the graphstore is not required to be the IR** — it may denormalize, precompute,
resolve refs into concrete keys, drop fields the renderer doesn't consume, or
split a node across tables. The only contracts are (1) the raw archive stays
byte-identical to the upload, and (2) the renderer's input shape stays stable
or migrates in lockstep with the renderer. Do not try to preserve
round-trip-to-IR fidelity in the store; the round-trip is via re-ingest from
the raw archive.

**Gen owns all ref classification; ingest only links. Ingest can _fail_ if it disagree and believe the uploaded bundle is incorrect.**
Applies to the IR in the raw archive (not the graphstore's internal form).
- `LocalRef` means *this bundle*, always. Gen converts every relative ref,
  alias, and local name to a `LocalRef` before writing the IR.
- Every cross-bundle reference is a `RefInfo(package, version, kind, path)`.
  The *name* half (`package`, `kind`, `path`) must be fully resolved — no
  fuzzy strings, no unresolved aliases. The *version* field is late-bound:
  `"?"` (resolve to the best available version at serve time) is the expected
  value for the overwhelming majority of refs. An explicit version is an
  opt-in **pin** for the rare doc that genuinely targets one release;
  version-exact refs are *not* a goal, and gen must not bind refs to
  whatever version happens to be installed in the build environment.
- Ingest resolves `LocalRef`s to full keys and records live or dangling
  `RefInfo` links and an optimisation. A two-step ingest (build a ref map first) is an
  optimisation, not a correctness requirement.

**No raw HTML in the IR.**
The IR is semantic: producers express content as IR nodes, never as embedded
HTML/CSS islands. Raw HTML breaks every non-HTML consumer (terminal /
Jupyter rendering), cross-linking, and theming — it is one of the two
failure modes that made building on docutils/MyST output intractable the
first time (the other: links resolved too early; see the ref-classification
invariant). Directives that only produce HTML get unwrapped, dropped by
explicit policy, or handled by a registered IR-producing handler — never
passed through as markup, and never smuggled in as raw directives either
(see the directive invariant below). This applies to *any* producer, not
just `papyri gen`.

**RST substitutions never reach the IR.**
The IR must never contain `SubstitutionDef` or `SubstitutionRef` nodes.
Non-`replace::` substitution types (image, unicode) are warned and dropped;
support can be added per demand.

**No directive reaches the packed IR; none is silently discarded.**
Directives are a source-format construct (an RST-ism — MyST has its own):
they must not leak into the packed artifact, for the same reason
Python-isms must not leak into the wire encoding. Target state: gen keeps
unhandled directives verbatim in the *lenient* bundle directory
(`Directive.from_unprocessed` — inspectable, available to tooling), and
`papyri pack` / `papyri lint` fail while any `Directive` node remains.
(Current code differs: `Directive` is an `UnserializableNode` with
`_reject_at_validate`, so gen hard-fails instead — the strictness sits one
stage too early; see the enforcement item below.)
Every directive must be explicitly handled by pack time: by a built-in handler,
a project-registered handler (see the `DirectiveContext` plugin API), or an
explicit maintainer decision to unwrap or drop (via config). Dropping is
legitimate when *chosen* — never as a silent default. The "not silently
discarded" guarantee is enforced at the strict boundary (pack/lint), not by
preserving raw directives in the artifact.

**Encoding boundary.**
The bundle directory (`papyri gen` output) is JSON — intentionally
human-readable, inspectable with `papyri debug`. CBOR starts at `papyri pack`
and is the only encoding in the `.papyri` artifact and the ingest/viewer
layers. Do not write CBOR into the bundle directory or JSON into the artifact.

## Python version

- Minimum: **Python 3.13**. `requires-python = ">=3.13"`.
- CI matrix: `3.14` only. Add newer versions later; don't carry legacy ones.

## Dependency notes

- RST parsing uses `py-tree-sitter-rst` (PyPI) on top of `tree-sitter >= 0.24`.
  Do not reintroduce `tree_sitter_languages` or `tree-sitter-language-pack`.
- `numpy`, `scipy`, `astropy`, `IPython` in the CI matrix drift frequently;
  pin each matrix entry to a known-good version or xfail with a reason.

---

## Open questions (need a decision before the work is scoped)

- **PyPI republish?** Re-publish under a new version, or keep "install from
  git" only for the foreseeable future? Still open.
- **Pinned-ref semantics at serve time.** When a `RefInfo` pins a version the
  store doesn't hold: hard dangling link, or fall back to the best available
  version with a "pinned to X, showing Y" indicator? (Lean fallback +
  indicator — a pin expresses authorial intent, not a guarantee about what a
  given service instance holds.) Related: does the pin stay an exact version,
  or eventually admit a PEP 440 specifier ("changed in numpy 2.0" is `>=2.0`,
  not `==2.0.1`)? *(2026-07: explicitly deferred until the pin path is
  implemented. Note: no pin pathway exists anywhere in gen today — no role
  syntax, directive option, or config knob — deferred by design; recorded
  so the invariant isn't read as implying one exists.)*
- **Second-producer experiment (MyST- or docutils-based).** An earlier
  attempt to build papyri on top of docutils/MyST failed on two things:
  links resolved too early, and content collapsing into HTML. Both are now
  explicit producer requirements (the ref-classification and no-raw-HTML
  invariants), and the coming schema gives an external producer something
  concrete to target — so a retry becomes viable *as an alternative
  producer* (a Sphinx builder or mystmd plugin emitting bundles for
  Markdown/MyST-source projects), not as papyri's base. Worth attempting
  once the schema exists; the IR → MyST exporter provides the round-trip
  check.
- **Terminal / Jupyter client architecture.** Terminal + JupyterLab rendering
  is deferred, not dead, and it is on the critical path of the IPython
  adoption wedge (`?` showing rich cross-linked docs is the demo nobody else
  can match). When it comes back: thin client of the hosted service's JSON
  API, or reader of a local store? Thin-client avoids reimplementing ingest
  in Python but promotes the viewer's JSON endpoints to a public contract —
  design them accordingly either way. *(2026-07 lean: deferred; offline is
  desirable, but relying on the central service is acceptable if it's
  solid — decide when the work starts.)*
- **Future of `papyri find` / `describe` / `diff` / `debug`.** They work
  against the store the TypeScript pipeline writes, but the viewer is the
  user-facing replacement. Keep, trim, or drop?
- **Per-bundle crossref tables instead of one global `links` table?**
  Today every crossref lives in a single `links(source, dest)` table over a
  global `nodes` table (`ingest/migrations/0000_init.sql`); `getBackrefs`
  (`viewer/src/lib/graph.ts`) joins `links` + two copies of `nodes` filtered by
  `(package, identifier)`. Alternative: a per-bundle table of *outgoing* refs
  (partitioned by bundle → re-ingest/eviction is a drop+rebuild) plus a coarse
  bundle→bundle index, with backrefs computed lazily at view time.
  Trade-offs to weigh before committing:
  - *Cost model.* Global table = one indexed query. Per-bundle =
    `O(N_bundles_pointing_at_pkg)` queries / a `UNION ALL`. For a hot package
    (numpy) the fan-out could exceed the single join, though each per-bundle
    table is small so total rows scanned may still be lower.
  - *Write contention.* Per-bundle tables are append-only during one ingest;
    the global `links` table is write-amplified across concurrent uploads.
  - *Wildcard-version stubs.* `getBackrefs` matches `version = '?'` for
    unresolved cross-package targets; the per-bundle scheme must preserve that
    (store the wildcard, or resolve lazily).
  - *Shape.* Prefer one `refs` table partitioned by `(from_pkg, from_ver)` with
    a covering index over literal `refs_<pkg>_<ver>` tables (DDL churn).
  - Pure denormalization — no IR/raw-archive impact, exactly what the storage
    invariant permits. Revisit when backref latency or write contention is a
    *measured* problem.

## Open work — Gen (Python)

- **`DirectiveContext` injection (context, not globals).** Directive handlers
  reach bundle state through ad-hoc closures (`make_image_handler` &c.) and,
  historically, module globals. Define an explicit `DirectiveContext` (at least
  `doc_path`, `asset_store`, `module`, `version`, active `Config`, and the
  `Diagnostics` collector) and pass it as a second argument to every handler:
  `handler(argument, options, content, ctx)`. Handlers that need nothing ignore
  it. This subsumes the remaining "handlers should not read global state" work
  (the `:ghpull:`/`:ghissue:` half is already done) and would let the
  factory-bound `warn` callbacks (malformed-directive diagnostics) become plain
  `ctx.warn`. Config-supplied handlers (`obj_from_qualname`) make the signature
  change the delicate part. **End goal (decided 2026-07): this is the
  foundation of a public registration API** — projects register their own
  IR-producing handlers for their custom directives (via `papyri.toml` /
  entry points): Sphinx's ahead-of-time registration model with the
  HTML-output target fixed. `_SPHINX_ONLY_DIRECTIVES` and the built-in
  handler set are a stopgap until third-party registration exists.
  2026-07 review specifics: real closure usage shows ctx needs, beyond the
  minimum list above, `doc_root` (image/figure/include), `qa` (plot + every
  warn emission), the `execute` flag (plot), and the invoked directive's
  *name* (fixes the old TODO in `directives.py`; lets one handler serve
  several names). Config-registered handlers currently receive *zero*
  bundle state — not even the `warn` callback built-ins get via `partial` —
  so pass ctx at the single dispatch site in `replace_UnprocessedDirective`
  rather than partial-binding at registration. Add error isolation at
  dispatch: a failing user handler should emit a coded diagnostic
  (`E-directive-handler-failed`) and fall back to
  `Directive.from_unprocessed`, not abort gen (which `early_error=True`
  does today). Resolve and validate the handler registry once per gen run —
  today `obj_from_qualname` re-imports/re-instantiates per documented
  object and never checks callability — which is also where entry-point
  registered handlers merge in later. Move the module globals onto ctx:
  `_plot_counter` (non-reproducible `fig-plot-N.png` asset names across
  runs in one process) and `_MISSING_DIRECTIVES`.
- **`ts.py` diagnostics wiring.** The unparseable interpreted-text / hyperlink
  fallbacks in `ts.py` still `log.warning` plainly. Blocked on a design
  wrinkle: `ts.parse()` is `@functools.lru_cache`'d, so diagnostics emitted
  during parsing fire only on a cache *miss*, and `parse()` has no handle to the
  Gen's `Diagnostics`. Correct fix: have the cached parse return its warnings
  alongside the nodes so `parse()` re-emits them on every call — a real refactor
  of the TS visitor. The 2026-07 review upgraded this from cleanup to
  **correctness bug**: the cache returns shared *mutable* node trees with no
  defensive copy, and `TreeReplacer.generic_visit` (`tree.py`) plus the
  include handler (`_resolve_nested_includes`, `directives.py`) mutate
  `children` in place — two documents with byte-identical source text share
  one tree, and the second sees the first's visited state. Also
  `_parse_cached` constructs `TSVisitor(text, "")`, so qa context is lost
  even on cache *misses* and parse warnings always print `in ()`. Extended
  fix shape: the cached function returns an immutable `(sections, warnings)`
  payload; `parse(text, qa, warn=…)` deep-copies (or rebuilds) the tree
  before handing it to mutating visitors and re-emits each warning with qa
  attached, routing to Diagnostics when a warn callback is passed.
- **Per-reference version pins.** `"?"` is the expected version on almost all
  refs (see the ref-classification invariant); what's missing is the opt-in
  path for a doc to *pin* a specific version when it means one, plus an
  enforcement point that pins are well-formed once cross-package version data
  is threaded through.
- **Enforce the directive invariant.** Four parts, sharpened by the
  2026-07 gen conformance review.
  (a) Invert the strictness boundary first: make `Directive` a normal
  registered, JSON-serializable staging node (drop `_reject_at_validate`
  and the fail-fast docstring in `nodes.py`), then add a leftover-Directive
  scan to `lint_bundle`'s node loop and run it on the pack path — today the
  check is unimplementable because a `Directive` can never be read back
  from disk. A check on bundle *content*, not gen-time error records (the
  reverted gate in the done log gated on stale records; this doesn't).
  (b) Config: teach the `[global.directives]` value parser (the
  `obj_from_qualname` loop in `tree.py`) to accept literal `"drop"` /
  `"unwrap"` — the unwrap primitive already exists (`container_handler`,
  `directives.py`); `"drop"` maps to a diagnostics-emitting drop handler.
  (c) Triage the built-in defaults in `_SPHINX_ONLY_DIRECTIVES`, which
  conflates three cases: truly meta → drop (`highlight`, `currentmodule`,
  `testsetup`/`testcleanup`, the `auto*` family); layout containers →
  unwrap via `container_handler` (`grid*`, `card*`, `tab-set`/`tab-item`,
  `dropdown`, `button-*`) — tabs and dropdowns routinely hold unique prose
  (per-OS install instructions are the classic); handwritten py-domain
  directives (`py:function` &c. and the bare `function`/`class`/… forms)
  carry API documentation that exists nowhere else in the bundle — at
  minimum unwrap (argument as signature line + parsed body), eventually
  real handling. `testcode`/`testoutput` render as visible code blocks in
  Sphinx → map to the existing `code_handler`, not drop (the set's comment
  currently asserts the opposite).
  (d) No drop is silent: register a `W-dropped-directive` diagnostic and
  emit it for every `_SPHINX_ONLY_DIRECTIVES` hit (today: bare `log.info`),
  and give `raw_handler`/`only_handler` the same `warn=` binding as the
  other free-function handlers so their drops reach Diagnostics too.
- **See-also refs ship placeholder RefInfo into the packed IR.** `doc.py`
  emits `RefInfo("current-module", "current-version", "to-resolve", name)`
  and gen replaces it only for same-bundle targets; every cross-package
  see-also keeps the fake literals through pack, and the viewer
  special-cases them (`xref.ts`). The `CrossRef` docstring also promises an
  "ingest relink pass" that does not exist anywhere in `ingest/src`. Fix:
  classify in gen (emit `RefInfo(pkg, "?", "module", path)` via the import
  solver; a well-defined missing form otherwise), have pack/lint reject
  `kind="to-resolve"`, rewrite the docstring, then delete the viewer
  special-cases. Clearest current violation of "no fuzzy strings".
- **`resolve_` emits `RefInfo(None, None, …)`; ingest repairs it.** The
  "missing"/"local" branches return None module/version; the "local" ones
  reach the IR (module=None never matches the LocalRef conversion) and TS
  ingest papers over gen's Nones with `?? "?"` (`visitor.ts`). Gen should
  emit the canonical forms itself (LocalRef for same-bundle, a defined
  missing shape otherwise) so ingest can *fail* on malformed refs instead
  of fixing them, per the invariant. Related doc rot: `pack.py` cites
  `Gen._relink_dangling_local_refs`, which doesn't exist, and `LocalRef`'s
  "guaranteed to exist" docstring is not upheld by any gen-side pass.
- **Figure/asset refs stamp the build-environment version.** Four sites
  (`gen.py` ×2, `directives.py` ×2) emit
  `RefInfo(module, <concrete version>, "assets", name)` for assets that are
  same-bundle by construction, making the bundle digest depend on its own
  version number — exactly what `_ref_to_crossref` avoids for other
  intra-bundle refs. Change `Figure.value` to accept `LocalRef`, emit
  `LocalRef("assets", name)` at all four sites, update the Figure check in
  `pack.py`, and delete the stale "todo: add version number here" comment
  in `tree.py`.
- **Raw-markup passthroughs.** Three places copy unparsed RST source into
  content nodes, against the no-raw-markup direction: `autosummary` renders
  its own directive markup as a visible `Code` block
  (`_block_verbatim_helper` — drop it like the rest of the `auto*` family,
  or give it a real LocalRef-list handler, then delete the helper);
  grid/simple RST tables become verbatim-source `Code` blocks (`ts.py` —
  parse into the existing table nodes, or at minimum emit a coded
  diagnostic so the degradation is tracked); `|x| replace::` substitution
  bodies are spliced in as raw source `Text` (roles like
  ``:class:`numpy.ndarray``` inside a substitution bypass inline parsing
  and ref classification — run them through the inline parser).
- **Builtin ref resolution at gen time.** Ship a Python-builtins bundle shim (a
  minimal DocBundle registering every builtin as a `RefInfo`); `papyri gen`
  emits builtin refs as ordinary cross-refs and ingest resolves them against the
  shim like any package — no special-casing in the resolver. (The intersphinx
  inventory already covers stdlib links via CPython's `objects.inv`; the shim is
  the gen-time alternative for builtins specifically.)
- **Remaining pack/lint unification.** The core of the 2026-07 review
  finding is closed: `make_artifact_from_dir` now runs the lint checks
  (substitution nodes always fail — invariant; missing Figure assets and
  `DocstringSentinel` placeholders warn by default, fail under
  `--strict`). Still open from that finding: share `_assert_safe_urls`
  with `papyri lint` (today it runs only on the pack path); give `papyri
  lint` a `--strict` flag and fix its help text (it advertises a
  dangling-LocalRef check that non-strict `read_bundle_dir` only warns
  about); add a count of `Unimplemented` nodes (verbatim unparsed source
  rides into artifacts untracked) and a heuristic raw-HTML scan over
  string leaves (warn; `--strict` error) so the no-raw-HTML invariant is
  enforced at the boundary for *any* producer, not only by gen's handler
  table.
- **Inline images in phrasing content (image substitutions).** matplotlib's
  docstrings define `image`-type substitutions (`.. |m30| image:: …` used in
  marker/mathtext tables); gen warns and drops them because `Image` is
  FlowContent only — a `SubstitutionRef` inside a `Paragraph` has no legal
  replacement. Supporting them means admitting `Image` into
  `StaticPhrasingContent` (nodes.py union + ir-types/ir-schema + renderer) and
  routing the substitution body through the image handler. IR schema change —
  batch with the next schema-touching PR.
- **Custom role mapping in config.** matplotlib's `:mpltype:`color`` role
  (1.5k+ hits) and similar project-local roles have no handler and warn as
  unresolved. Add a `[global.roles]` config table mirroring
  `[global.directives]` so projects can map custom roles (drop / plain-code /
  link template).
- **numpydoc section fragments that tree-sitter cannot re-parse (#361).**
  `numpy.ma.core:MaskedArray.resize` stays excluded: the full docstring parses
  fine, but the numpydoc-section fragment gen re-parses trips
  TreeSitterParseError. Fix is in how gen splits/re-parses section content.
- **`:orphan:` flag in the IR.** Orphan-doc detection currently only *warns*
  because the IR can't tell an intentionally-unlisted page from an accidental
  one. Once gen reads the Sphinx field-list `:orphan:` metadata, promote
  accidental orphans to a hard `pack` error and exclude flagged ones. Then
  decide whether canonical-`index`-root vs. any-root reachability matters.
- **Rewrite `docs/IR.md` — it documents the wrong encoding.** It claims
  CBOR `module/<qualname>.cbor` blobs, a `tree`/`titles` toc shape, and
  that JS consumers of the bundle dir need a CBOR library; gen writes
  all-JSON (`module/<qa>.json` — pack *requires* the suffix) and a
  list-shaped `toc.json`. CLAUDE.md and PLAN.md match the code; IR.md is
  the stale document. Also fix its dead pointers (`DocBundler.write` is at
  ~1220 not ~1540; `GeneratedDoc` lives in `doc.py`, not `gen.py`).
- **Typed manifest struct through pack.** `papyri.json` stays JSON, but the
  manifest is read into `Bundle` via a freeform dict (`_read_meta` in
  `pack.py`). Represent it as a typed struct inside `Bundle` so the round-trip
  is fully typed from `pack.py` onward (mirror in `ingest.ts`'s `PapyriMeta`).

## Open work — IR schema / encoding (cross-cutting)

Decided (2026-07): the IR gets a machine-readable schema as the single
source of truth, replacing "grep for `@register`" plus the hand-maintained
mirrors in `encoder.ts` / `ir-types.ts` — settle this before a third IR
consumer (the future terminal renderer) exists. Direction accepted in
principle; firm up details when implementation starts:

- **Schema.** One JSON Schema document — a fragment per node type,
  discriminated union on a `"type"` field. `ir-types.ts` is generated from
  it (`json-schema-to-typescript` or similar); the Python node classes are
  either generated or conformance-tested against it. CI runs a golden
  corpus of fixture documents that both languages must round-trip.
- **Wire format — what goes is the private tag registry, not necessarily
  CBOR.** RFC 8949 standardizes the envelope; tags 4000–4444 are a private
  vocabulary a consumer can only learn from an out-of-band map. Firm
  decision: string-keyed maps with a `"type"` discriminator
  (`{"type": "Paragraph", …}`), no custom tags — the IR data model becomes
  JSON-isomorphic and the schema validates the decoded tree, so `pack
  --strict` and ingest share one validator and `ir-reader.ts` simplifies
  (resolves the viewer's "encoding convergence" question). Open until
  implementation: JSON bytes vs *tagless* CBOR bytes for the IR files.
  JSON's edge: unzip-and-grep inspectability, zero-dependency consumers.
  CBOR's edge: RFC 8949 §4.2 deterministic encoding gives canonical bytes
  for the content-identity hash (JSON's counterpart is JCS / RFC 8785);
  size is a wash after gzip. Lean JSON; decide when the schema lands.
- **Artifact container.** The `.papyri` artifact becomes a plain container
  (zip or tar.gz): `manifest.json`, per-doc IR files, assets as raw
  members. Raw-member assets beat in-band byte strings whichever IR
  encoding wins: per-asset extraction and caching without decoding the
  whole IR graph, `papyri unpack` becomes near-trivial, and keeping image
  bytes out of the IR payload is what makes the content-identity hash
  ("hash structure + text, not nondeterministic figures") natural.
- **Tuple vs list (tag 4444) — already done by construction.** The 2026-07
  review verified at the byte level that the tag is never emitted:
  `Node.cbor` converts tuple fields to lists before encoding, and decode
  restores tuples from annotations (`_coerce_field`) — exactly the
  schema-driven coercion this bullet asked for. Remaining work is deletion:
  drop `register(4444)(tuple)` (`nodes.py`), the `TUPLE_TAG` branch in
  `ingest/src/encoder.ts`, and the stale tag-4444 row in `docs/IR.md`
  (which wrongly claims the tag round-trips tuples).
- **Boundary invariant rewrite.** When this lands, restate the "Encoding
  boundary" invariant: the gen-dir vs artifact boundary was never really
  JSON-vs-CBOR — it is *lenient staging output* vs *strict, linted,
  schema-validated artifact*. That is the boundary worth enforcing.
- **Node-shape pre-work (do before freezing schema fragments).** 2026-07
  review findings: rename `SeeAlsoItem.type` — a *data* field that hijacks
  the discriminator slot (it serializes as `{"type": null}` today, so the
  node carries no class identity on the wire); replace
  `GeneratedDoc._content` + `_ordered_sections` with a single ordered
  sections sequence (kills `_OrderedDictProxy`, the underscore wire keys,
  the unreachable `| None` arm, and the one map whose key order is
  semantic); fix `node_serializer` to use the ClassVar-filtered
  `get_type_hints` — the `sections` ClassVar constant currently leaks into
  every JSON doc but not into CBOR, so the two encodings disagree on
  `GeneratedDoc`'s field set; collapse `SigParam.annotation`/`default`'s
  three-valued `str | NoneType | Empty` (Python class names leak onto the
  wire as `{"type": "NoneType"}`; the NoneType arm is unreachable from
  gen); delete `UnimplementedInline` (zero remaining producers); exclude
  `UnserializableNode` subclasses (`Directive`, `UnprocessedDirective`)
  from persisted-node unions, which would poison generated schema
  fragments; tighten `FieldListItem`'s annotations to what its `validate()`
  actually enforces.
- **IR → MyST AST export: yes (decided 2026-07).** A one-way exporter is a
  small tree transform once the JSON encoding lands; schedule it after the
  schema exists. It doubles as a conformance tool if a MyST-based producer
  emerges (round-trip testing between exporter and producer).
- The schema is also what makes third-party *producers* possible (see
  Target shape): a bundle is valid because it validates against the schema
  and passes lint — not because `papyri gen` wrote it.

Old raw archives in the CBOR format are re-generated, not migrated
(pre-production rule: no old data matters).

## Open work — Viewer / ingest

- **"0 errors / N warnings" badge per bundle.** Gen records resolved
  diagnostics under `papyri.json`'s `diagnostics` key, but it's a list of dicts
  and `pack._read_meta` only lifts *scalar* manifest keys into `Bundle.extra`,
  so it never reaches the artifact or the viewer. Either add scalar
  `diagnostic_{error,warning}_count` manifest keys (flow through `extra` →
  `meta.cbor`) or carry the full records as a typed `Bundle` field, then render
  the badge on the bundle index/overview. 2026-07 review wrinkles:
  `_read_meta` drops the `diagnostics` list *silently* and stringifies the
  scalars it does lift (`str(v)` — count keys would arrive as `"3"`, so the
  viewer would have to parse), and `_manifest_dict`'s round-trip docstring
  is wrong today (gen-dir → pack → unpack loses the key). Prefer the
  typed-field route; make `_read_meta` log dropped manifest keys either way.
- **Inline class members (methods & attributes).** Per-page/per-bundle toggle
  that expands each class's members inline (full docstrings, signatures, param
  tables) instead of a summary table of links. Reuses the member qualname blobs
  the class page already fetches (`viewer/src/lib/qualname-page.ts`) — no new
  fetching. `?inline-members=1` query flag (shareable) + a React island +
  optional `localStorage` persistence; default collapsed.
- **Inline module-level functions.** Mirror of the above for functions defined
  directly in a module (`?inline-functions=1`). Large modules (numpy) get very
  long — add "collapse all" + per-function anchors. Both toggles should share
  one rendering component.
- **Bundle staging area.** Upload into an isolated staging zone (no backrefs
  computed, atomically droppable) for PR-doc review and RC review. Staged
  bundles never appear in cross-package "Referenced by" lists or the global
  search index.
  - *Design.* Staging is a namespace, not a separate pipeline: same parsing,
    writing into a `_staging/<pkg>/<ver>/` raw zone and `staging_*` tables (or a
    `staging` flag column). Ingest may resolve *outgoing* refs against the main
    graph (so maintainers see live cross-refs) but does not update the main
    graph's backref tables. Drop = single table/row drop, no cascade. Endpoint
    `POST /api/bundle?staging=1`; visually distinct (persistent banner, excluded
    from the default home list). Later: an explicit `…/promote` that moves the
    raw archive to the main zone and re-ingests. Staged bundles skip the
    "latest backrefs only" dedup (they have none). Same upload auth as normal;
    viewing may optionally require login.
  - *Open.* Whether a staged `GET /[pkg]/[ver]/` shows a warning banner
    (probably yes, reuse the version-status banner). Eviction: TTL /
    auto-eviction is required, not optional — see "Adoption / CI
    integration" below (PR-preview load makes staging storage unbounded).
  - *Files.* `ingest/src/ingest.ts` (flag, skip backref writes),
    `viewer/src/pages/api/bundle/[...path].ts`, graph-layer
    `listStagingBundles`/`dropStagingBundle`,
    `viewer/src/pages/[pkg]/[ver]/index.astro` (banner),
    `viewer/src/pages/staging.astro` (admin list).
- **Cross-package Figure/RefInfo version resolution.** TODOs in
  `ingested_doc.py` around version resolution for `Figure`/`RefInfo` across
  packages.
- **Per-bundle → global search.** The manifest is per-bundle; a cross-bundle
  index would enable "find `linspace` across numpy and scipy".
- **Ingest-time precomputation (perf).** Two count queries still run at view
  time: precompute the broken-incoming-refs count into a `bundle_stats` row
  (badge on `/project/[pkg]/[ver]/`), and precompute the latest-linking-version
  backref table (`filterToLatestVersionPerPkg` in `qualname-page.ts`).
- **Promote the shared graph layer into `papyri-ingest` (cross-cutting).**
  `ingest/` and `viewer/` maintain near-copies of graph-layer logic. Once the
  schema stabilises, move the shared bits into the package and have the viewer
  import them rather than re-implement.

## Open work — Adoption / CI integration

PR doc previews are the adoption wedge: a project that adds the papyri
GitHub Action gets rendered previews of its own docs on every PR —
single-player value, no other bundles required — and cross-package linking
accrues as projects join for the previews. The build cost (imports, doctest
execution, figure rendering, per-PR) lands on GitHub's free public-repo
minutes; the service pays only for ingest + serve, which the VPS
architecture already makes cheap. This is the structural cost advantage over
central-build services (Read the Docs' largest cost is per-build — notably
per-PR — compute). First adoption target: IPython. Operation/governance:
personal VPS for now; revisit once IPython plus a few packages are live.
Caveat: the free-compute
argument holds for public repos on github.com; private repos and non-GitHub
CI use the token path and pay their own compute.

- **`papyri` GitHub Action.** One copy-pasteable job: install papyri +
  project, `gen`, `pack`, `upload` to a viewer instance. Does not exist yet
  (no `action.yml` anywhere in the repo). The bar is "works on the first try
  in a repo whose tests already pass in CI" — every configuration knob is
  adoption friction.
- **OIDC (trusted-publishing-style) upload auth.** Fork PRs cannot see
  repository secrets, so bearer-token upload silently fails for the most
  common contribution flow, and `pull_request_target` is a known footgun.
  Follow PyPI's trusted-publisher model: `PUT /api/bundle` verifies GitHub's
  OIDC claim (repo, workflow, ref) and maps it to a project via a
  `project → allowed claims` table in the auth DB; per-project tokens stay
  as the non-GitHub fallback. Design this before the token scheme calcifies.
- **Staging eviction is launch-blocking under PR-preview load.** Every push
  to every PR of every enrolled repo uploads a bundle → unbounded storage.
  Needs TTL / auto-eviction, one staging slot per PR (replaced on push,
  dropped on merge/close), and a version naming scheme that can never shadow
  a real release (e.g. `<base-version>+pr<N>.<sha>`). This supersedes the
  "lean explicit delete for v1" note in the staging-area item above.

## Open work — Security / hosting

- **SSRF: intersphinx inventory fetch.** `viewer/src/pages/api/inventory.ts` /
  `ingest/src/inventory.ts` fetch an admin-supplied `inventory_url`/`base_url`
  with no host restriction (`isHttpUrl` permits internal/link-local hosts, e.g.
  `http://169.254.169.254/…`). Admin-gated today (low risk), but a
  metadata-endpoint SSRF vector on the multi-tenant hosted service. Block
  private/link-local ranges and disable redirects to them before hosting.
- **Separate domains/processes for upload, admin, and user surfaces.** In a
  hosted deployment, run the upload endpoint, admin panel, and per-user
  management UI as isolated processes on separate subdomains to limit blast
  radius. Design URL structure and routing with this separation in mind so the
  hosted service isn't baked into a monolith. Firm up with the hosting design.
- **Bundle content-identity hash (excluding image bytes).** `papyri upload`
  already skips re-upload when the viewer holds the same SHA-256 over the whole
  `.papyri` artifact (`bundles.content_hash`; `--force` bypasses). That hash
  includes image bytes, so a re-`gen` with churned images triggers a redundant
  (but safe) re-upload. Refinement: a *content-identity* hash over IR structure
  + text + asset *references* but **not** image bytes — autogenerated figures
  (matplotlib, Agg/freetype) are non-deterministic across runs/OSes, so hashing
  them makes every rebuild look changed. Open: keep a separate per-asset hash
  for cache-busting individual images (probably yes, out of the identity hash).
  - *Follow-up:* make `content_hash` `NOT NULL`. It's nullable only as a
    migration cushion; every write path now computes it. Fold into a future
    migration squash + wipe/re-ingest from the raw archive.

---

## Done log

Terse, grep-able record of what exists so future work doesn't re-derive it.
Newest areas first; each line names the key symbol/file.

### Sphinx-fidelity pass (2026-07 example sweep)
- Ref resolution: leading-`!` suppression → plain `InlineCode`, no warning;
  trailing `()` stripped before resolve (display keeps parens); scope walk
  most-specific-first *including the current scope*; colon-form qa
  ("numpy:any") normalized before scope derivation — all in `tree.py`
  (`replace_InlineRole` / `resolve_`).
- Narrative↔API cross-linking: `Gen._scan_narrative_sources()` (cached first
  pass) gives API visitors the narrative `doc_targets`/`external_targets`
  maps (`:ref:` from docstrings resolves) and narrative visitors get the API
  `known_refs` (`Gen._known_refs`); narrative doc keys resolve refs against
  the package root (`DirectiveVisiter._resolve`).
- `:doc:` role resolved through the visitor (`_resolve_doc_path`) → doc-key
  LocalRefs ("api:axes_api", not "/api/axes_api"); free-function
  `py_doc_handler` deleted.
- plot directive: external-script arguments embedded (doc_path/doc_root),
  doctest-format bodies execute with prompts stripped, exec namespace
  pre-seeded with np/plt (matplotlib `plot_pre_code` default); `doc_root`
  threaded into API visitors for `/`-rooted image paths.
- numpydoc leniency: unknown section headings fall through to upstream
  warn+skip (was: ValueError → sentinel/object drop); backticked See Also
  entries (`numpy.polynomial`) accepted (`numpydoc_compat.py`).
- Import solver: objects `full_qual()` cannot name (method descriptors,
  numpy.ufunc.reduce) fall back to longest-imported-module-prefix qualname.
- `W-unresolved-default-role` (default `info`): bare-backtick lookup misses
  split off from `W-unresolved-ref` (Sphinx autolink degrades silently).
- Doctest-execution `catch_warnings()` now actually encloses the run, so
  example code cannot leak warning-filter mutations into gen.
- Pack lint enforcement: `_check_lint` in the pack path — Substitution nodes
  always fatal (IR invariant); missing Figure assets + `DocstringSentinel`
  warn by default, error under `--strict`; sentinel check added to
  `lint_bundle` (closes the former "pack strict-mode / lint gaps" item).
- examples/numpy.toml exclusions pruned to just MaskedArray.resize (#361).
- Examples collected *after* API docs and their visitor now gets
  `known_refs` + narrative target maps, so example pages cross-link.

### Gen-time diagnostics
- Core framework: `Severity`, `DIAGNOSTICS` registry, `DiagnosticConfig`
  resolver (default → global → first-match per-target glob), `Diagnostics`
  collector — all in `error_collector.py`. Config `[global.diagnostics]` +
  `per-target` sub-table (`from_raw`, unknown codes/severities fail the run);
  `Config.diagnostics` / `error_on_warning`. `papyri gen` logs a per-severity
  summary, records into `papyri.json` `diagnostics`, and exits non-zero on any
  `error` (`--no-error-on-warning` escape hatch). Docs: `configuration.rst`.
- Codes: `W-unresolved-ref`, `W-unsupported-substitution`,
  `W-malformed-directive`, `W-missing-github-slug` (tree.py); `W-doctest-syntax`,
  `W-doctest-exec`, `W-numpydoc-parse`, `W-module-docstring` (gen.py).
- `directives.py` malformed-directive wiring: `list-table`/`csv-table`/`image`/
  `figure`/`include`/`plot` route recoverable failures through a `warn`
  callback the visitor binds to `DirectiveVisiter._directive_warn`
  (`W-malformed-directive`); handlers built outside gen still log plainly.
- `:ghpull:`/`:ghissue:` de-globalized: resolved in `replace_InlineRole`
  against a per-visitor `github_slug` (from `[meta].github_slug`),
  `W-missing-github-slug` when unset. `_GITHUB_SLUG`/`set_github_slug()` gone.

### Gen / Python
- Clinic signatures as fallback `ObjectSignature` for `type`s
  (`strip_clinic_signature` → `extract_docstring`, `gen.py`).
- Missing block directives audit (2026-04-30/05-01) closed: `rubric`, `only`,
  `literalinclude`, `csv-table` handled; sphinx-design / `automodule` /
  `currentmodule` / `testcode`&c. / `highlight` / py-domain `function`/`class`
  in `_SPHINX_ONLY_DIRECTIVES` (silent drop). No known remaining directives.
- Unified "version unknown" marker: gen emits `RefInfo(version="?",
  kind="module")`; `visitor.ts` normalization gone; `graph.ts` uses `'?'`.
- Configurable doctest `optionflags` (`config_loader.py` / `gen.py`).
- Module-docstring parse failures → `DocstringSentinel` (tag 4072) + warning,
  recorded in `failure_collection`; encoder/IR/renderer updated.
- `LocalRef` dangling-ref policy: gen does not rewrite; `pack` surfaces it.
- Deleted dead code: `normalise_ref` (+ its test), `mod_root`.
- Renamed `crosslink.py` → `ingested_doc.py`.
- `graphstore.py` write-side removed (`put`/`put_meta`/`remove`/
  `_maybe_insert_node`, schema creation) — read-only; TS ingest owns writes.
- `ts.parse()` LRU-cached (`_parse_cached(bytes)`, maxsize 512).
- `Gen.collect_api_docs` decomposed (`_collect_and_filter_items`,
  `_process_one_api_item`).
- Directive-handler registry: `self._handlers` dict is the sole dispatch path;
  legacy getattr path removed.
- Stale `papyri ingest` reference in `describe.py` fixed → `papyri upload` /
  `POST /api/reingest`.
- Serialization paths documented (`node_serializer.py` ↔ `serde.py`).

### Pack / lint
- `papyri lint` subcommand + `lint_bundle()` (SubstitutionRef/Def, missing
  Figure assets); tests in `test_pack.py`.
- `pack --strict`: orphan-doc warnings → hard `BundleError`.
- Dangling local refs: `_check_local_refs` (warn; `--strict` errors); viewer
  renders `.xref.unresolved.broken-local`; `/…/validate` lists them.
- Toc↔narrative: `_check_toc_refs` (hard fail on dangling toc entry);
  `find_orphan_docs`/`_warn_orphan_docs` (warn); numpy smoke tests.
- Silent-drop→hard-pack-failure gate tried and reverted (gen/pack are separate
  steps; pack must not gate on a stale gen-time error record).

### Ingest (TypeScript)
- Dropped directory-based ingest: `ingestBundle(node)` (decoded packed
  `.papyri`) is the sole contract; `ingest()`/`_put`/`_ingest*Dir`/
  `explodeBundleToDir`/`IngestOptions.check` and the standalone
  `papyri-ingest` CLI removed. `papyri-ingest` is now a library.
- Raw upload timestamps: `FsRawStore.put()` writes `<ver>.meta.json` sidecar;
  `RawStore.getMeta()`.
- Type-safe key parsing: `keyStr`/`parseKeyStr` in `keys.ts`.
- Unified forward-ref collection: single `forwardRefKeys(subtree)` path.
- `assertBundle` deep shape validation (`bundle.ts`).

### Viewer
- Async storage+graph layer: `BlobStore`/`GraphDb`/`RawStore`, built per-request
  by `backends.ts`; pages call `getBackends()`; xref batched per page.
- In-process upload `PUT /api/bundle` (gunzip → CBOR decode → `ingestBundle`);
  raw archive `_raw/<pkg>/<ver>.papyri.gz`; `POST /api/reingest` (NDJSON,
  `?pkg=`/`?ver=`).
- Precomputed `node_index` table (migration `0006`) for image-index /
  node-browser; falls back to `walkBundle` for pre-migration bundles.
- CSS dead-code audit (only `.sidebar-stub` was dead); per-kind admonition
  styling (`admonition-${kind}` + tokens/icons).
- Dual Shiki themes + dark-aware KaTeX (`.katex-html { color: inherit }`).
- Crossrefs default to latest linking version per source package
  (`bucketBackrefs`/`filterToLatestVersionPerPkg`; PEP 440 pre-release
  exclusion; wildcards always kept).
- Unresolved-link warnings: inline `<span class="xref unresolved">` +
  `/…/validate` report (`collectXrefsDetailed`).
- Incoming broken-link report `/…/backref-validate` + count badge
  (`getBrokenBackrefs`/`countBrokenBackrefs`).
- Content-hash dedup: `papyri upload` skips when the viewer holds the same
  `bundles.content_hash` (`--force` bypasses).

### Auth / security
- User/session store in a separate SQLite DB (`auth-db.ts`, `PAPYRI_AUTH_DB`):
  Argon2id passwords (constant-time verify + decoy on unknown user), opaque
  server-side sessions with `created_at`/`expires_at` (7-day TTL, revocable),
  fail-closed when unseeded (`PAPYRI_USERNAME`/`PAPYRI_PASSWORD`); dev-only demo
  admin gated by `PAPYRI_DEV_SEED`. Three-tier middleware (public / admin-only /
  signed-in / guest-browsable).
- Per-user upload authz: `users.is_admin`, `projects`/`project_members`,
  personal `upload_tokens` (SHA-256 stored) minted at `/settings`; `PUT
  /api/bundle` authenticates bearer → principal, authorizes per `module`
  (global `PAPYRI_UPLOAD_TOKEN` = escape hatch).
- Path traversal closed via `safeJoin` (`fs-safe.ts`) in `FsBlobStore`/
  `FsRawStore`; `_safe_child` in `pack.py` for `papyri unpack`.
- `javascript:`/`data:` URL blocking: `isSafeUrl` (`url-safety.ts`) enforced at
  renderer (`render-node.ts`), ingest (`assertSafeUrls`), pack
  (`_assert_safe_urls`).
- Upload robustness: streaming PUT idle timeout (`_UPLOAD_IDLE_TIMEOUT_S`);
  zip-bomb ceiling (`_MAX_BUNDLE_BYTES`, 256 MiB); `inflateZlib` corrupt-body
  try/catch in `parseObjectsInv`.
- External (intersphinx) linking: `POST /api/inventory` +
  `ingest/src/inventory.ts` parser + `0001_external_inventory.sql` +
  `resolveExternalRefs` (`xref.ts`); admin UI `ExternalInventoryPanel.tsx`.
