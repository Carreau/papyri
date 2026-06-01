# Maintainability Review — 2026-05-31

> **Scope.** A multi-agent review focused on three axes — **simplicity**,
> **code deduplication**, and **performance** — with the explicit goal of
> improving maintainability. Changes to the IR to make nodes more *homogeneous*,
> and renaming, are in scope. Four read-only review agents covered the Python IR
> node layer, the Python gen/tree pipeline, the TypeScript `ingest/` package, and
> the TypeScript `viewer/src/lib/` rendering library. **No code was changed** —
> this document is the deliverable. All `file:line` citations hold as of HEAD on
> 2026-05-31.
>
> This complements `REVIEW_2026-05-28.md` (correctness/architecture concerns).
> Where the two overlap (the Python↔TS IR seam, `collect_api_docs` decomposition,
> `ts.parse` caching) the items are cross-referenced.

---

## The through-line

One root cause radiates through every layer: **the IR has many node types that
are structurally identical and differ only by name.** That redundancy is then
mirrored *by hand* in four more places —

- `papyri/nodes.py` (the node classes),
- `papyri/serde.py` + `papyri/node_serializer.py` (two recursive serializers),
- `ingest/src/encoder.ts` (`FIELD_ORDER`, ~60 hand-copied entries),
- `viewer/src/lib/ir-types.ts` + `viewer/src/lib/render-node.ts`,

— and each mirror can drift silently. **Homogenizing the IR is the keystone
change**: it shrinks all four layers at once. The per-layer dedup/perf items
below are independently valuable and lower-risk, and are sequenced first.

The structural families the agents independently identified:

| Family | Members | Shared shape |
|---|---|---|
| children-only | `Paragraph, Emphasis, Strong, BulletList, ListItem, Blockquote, Section, Parameters, DefList, Table, AdmonitionTitle` (~11) | `{ children }` |
| value-only leaf | `Text, InlineCode, InlineMath, Math, SubstitutionRef, Figure, NumpydocExample, NumpydocSeeAlso, NumpydocSignature` (~9) | `{ value }` |
| labelled-ref pairs | `Citation`/`CitationReference`, `Footnote`/`FootnoteReference` | label + back-anchor, differ only by prefix string |
| def/field list items | `DefListItem` (`dt`/`dd`), `FieldListItem` (`name`/`body`) | same shape, different field names |
| image | `Image` (`url: str`), `Figure` (`value: RefInfo`) | image src carried two ways |

---

## Findings grouped into actionable slices

Slices are ordered low-risk → high-risk so each can be a small, independently
verifiable commit (one logical change per commit, per `CLAUDE.md` ground rule 2).

### A. Dead-code deletions (zero behavior risk, ground rule 0)

- **`GeneratedDoc.slots()`** — `papyri/doc.py:186-205`. Zero callers anywhere
  (`papyri/`, `ingest/`, `viewer/`); duplicates `__slots__` + annotation order.
  Its docstring claims it's "for ingest readers" but ingest is TS and reads CBOR.
- **`Leaf` base class** — `papyri/nodes.py:178-180`. Only subclass
  `SubstitutionRef` (199) re-declares `value: str`, so the base contributes
  nothing; `Leaf` is unregistered and never instantiated.
- **Unread `title` class attrs** on `NumpydocExample`/`NumpydocSeeAlso`/
  `NumpydocSignature` — `papyri/nodes.py:761-784`. No consumer in any layer.
- **~9 unused `Signature` members** — `papyri/signature.py`: `SigParam.to_parameter`
  (57-67), `SignatureNode.to_signature` (86-87), `Signature.param_default`
  (213-214), `annotations` (216-218), `is_public` (229-231),
  `positional_only_parameter_count` (233-245), `keyword_only_parameter_count`
  (247-259), `to_dict` (261-273), `to_json` (275-279). No production or test
  callers (only `from_str`, `to_node`, `__str__`, `parameters`,
  `return_annotation` are live). The `to_dict`/`to_json` Griffe-compat pair is a
  whole unused serialization path.
- **No-op `hash(local_refs)`** — `papyri/tree.py:205` (result discarded).
- **Stale "mirrors ir-reader.ts" comments** — `ingest/src/encoder.ts:1-12, 41`.
  The viewer does *not* keep its own field table; `viewer/src/lib/ir-reader.ts:12`
  imports `decode` directly from `papyri-ingest`. The comments imply a second
  copy that no longer exists.
- **Over-broad export** — `viewer/src/lib/xref.ts:66` `collectXrefs` is exported
  but only used inside `xref.ts:100`. Drop the `export`.

### B. Bugs surfaced by the review

- **`Node.__hash__` is broken** — `papyri/node_base.py:105-112`. It walks
  `dir(self)` and wraps every field value in `tuple(...)`, which raises
  `TypeError` for any scalar field (`int level`, `bool ordered`). It only avoids
  blowing up because three nodes override it (`InlineRole` 104, `CrossRef` 174,
  `SeeAlsoItem` 1086) and most nodes are never hashed. Fix: make `__hash__`
  consistent with `__eq__` (hash the `get_type_hints` field tuple), then delete
  the three overrides that exist only to dodge it.
- **`Text` tag mismatch** — `viewer/src/lib/ir-reader.ts:179` synthesizes
  `Text` as tag `4043`, but Python registers `Text` at `4046`
  (`papyri/nodes.py:340`, and `encoder.ts:113` agrees). Any code that
  round-trips that synthesized node through `encode()` would mis-tag it. Import
  the tag from a shared constant rather than the literal.

### C. Deduplication (no IR change required)

- **Two recursive serializers** — `papyri/serde.py:92-160` (`serialize`) and
  `papyri/node_serializer.py:21-81` (`serialize`) are the same type-driven walk
  maintained twice, and have **already drifted**: `serde` reads
  `getattr(annotation, "_name", None)` (serde.py:134) — a stale path no Node
  defines — while `node_serializer` uses `.type`. They differ only in (a)
  union-tag strategy (external `{type,data}` vs internal `type` key) and (b) the
  per-object hook (`_validate` vs `_dont_serialise`/`type`). Factor the shared
  walk into one parametrized function; both become thin wrappers.
- **Admonition handler boilerplate** — `papyri/directives.py:139-166, 272-302`.
  13 one-line wrappers (`warning_handler` … `tip_handler`) each just
  `return admonition_helper("<name>", …)`, plus `rubric`/`admonition`/`topic`
  (256-339) repeating the same title+parse-body+wrap three more times. ~100
  lines. Replace with data-driven registration (a name list +
  `functools.partial(admonition_helper, name)`); the `tree.py:706-740`
  registration table already maps name→handler. Makes "add an admonition kind" a
  one-line edit.
- **Triplicated numpydoc section-name lists** — `papyri/gen.py:504-514`,
  `1494-1504`, `1959-1971` all list the parameter-table section names
  (`Parameters, Returns, Raises, Yields, …`); the text-section sets are re-listed
  at `1471` and `2014/2024`. Three sources of truth → a real correctness footgun.
  Promote to module-level constants.
- **Duplicated node-browser endpoints** — `viewer/src/pages/api/nodes.json.ts:22-105`
  vs `viewer/src/pages/api/[pkg]/[ver]/nodes.json.ts:42-125`. `displayValueFor`,
  `dedupKeyFor`, the accumulator, `addHits`, the sort comparator, and the
  render-pass are copied byte-for-byte; only `walkAllBundles` vs `walkBundle`
  differs. Extract a shared `collectUniqueNodes(walkRunner, types, limit)`.
- **Duplicated text-search endpoints** — `viewer/src/pages/api/[pkg]/[ver]/text-search.json.ts:21-47`
  vs `viewer/src/pages/api/text-search.json.ts:19-34`. `TEXT_NODE_TYPES`,
  `SNIPPET_RADIUS`, `extractText`, `makeSnippet` are identical; the all-bundles
  file already imports the response *types* from the per-bundle one. Export and
  share the helpers too.
- **`getVersionDigests` / `listDigests`** — `viewer/src/lib/graph.ts:317-338`
  and `346-367` are the same function with a different `WHERE`, each with a
  hand-rolled byte-by-byte hex loop. Extract `rowsToHexMap`; replace the loop
  with `Buffer.from(bytes).toString("hex")`.
- **Three matplotlib figure-capture sites** — `papyri/gen.py:684-688`,
  `papyri/executors.py:54-61`, `papyri/gen.py:978-981` each hand-roll
  `BytesIO()` + `savefig(dpi=300)` + `plt.close("all")`. Centralize in one
  helper (`BlockExecutor.get_figs` is the natural home); the `Figure`-node +
  asset-store emission in `report_success`/`make_plot_handler` could share a
  `_store_figs(...)` helper.

### D. Performance

- **`ts.parse()` is uncached** — `papyri/ts.py:1139`, called from `gen.py`
  (574, 595, 1481, 1748) and every `directives.py` handler. Rebuilds the whole
  tree-sitter tree + visitor per call; identical bodies are re-parsed across
  rebuilds. `PLAN.md` recommends an `@lru_cache` (args are hashable: `bytes` +
  `str`). **Caveat:** confirm callers don't mutate the returned `Section` list in
  place (`TreeReplacer` mutates `.children`) — if they do, cache at the raw-tree
  level or return copies. Also flagged in `REVIEW_2026-05-28.md`.
- **`node_serializer` bypasses the cached `get_type_hints`** —
  `papyri/node_serializer.py:14` imports `typing.get_type_hints` directly, so
  the hot whole-bundle serialize path re-resolves forward refs per node, missing
  the `@lru_cache(150)` in `serde.py:87-89`. One-line import swap.
- **Ingest link inserts use per-edge correlated subqueries** —
  `ingest/src/ingest.ts:531-540` resolve `source`/`dest` via
  `(SELECT id FROM nodes WHERE …)` twice per edge, for every link in the bundle.
  Build a `keyStr→id` map once per bundle (one `SELECT … WHERE package=? AND
  version=?`), then insert integer ids. Biggest ingest throughput win, no schema
  change.
- **Redundant node re-inserts + repeated `keyStr`** — `ingest/src/ingest.ts:508-559`
  (`_buildBatchStmts`) computes `keyStr` up to 3× per ref and emits a separate
  `INSERT OR IGNORE INTO nodes` per added ref, re-inserting the same dest node
  thousands of times for hot packages. Dedup dest inserts into a `Set<keyStr>`;
  compute each `keyStr` once.
- **`resolveRefs` N+1 fan-out** — `viewer/src/lib/graph.ts:84-98` resolves each
  ref with its own query (and `resolveExternalRefs` 135-164 one query per
  unresolved ref) on the page-render hot path. Batch with a `VALUES` join or
  `WHERE (package,category,identifier) IN (...)` and bucket in JS. (The comment
  already anticipates this; distinct from the larger backref-table redesign in
  `PLAN.md`.)

### E. IR homogenization (the keystone — crosses the Python↔TS seam)

Each item touches gen + `ir-reader.ts` (the designated shock absorber) +
`encoder.ts` `FIELD_ORDER` + `render-node.ts`. Stage **one family per commit**.

- Collapse the **children-only family** (~11 nodes) onto a shared `Container`
  shape discriminated by tag/`kind`.
- Collapse the **value-only leaf family** (~9 nodes) onto a shared `Leaf` shape.
- Merge **`Citation`/`CitationReference`** and **`Footnote`/`FootnoteReference`**
  into `kind`-tagged labelled-ref nodes (`render-node.ts:337-366`).
- Align **`DefListItem`/`FieldListItem`** field names (`render-node.ts:298, 309`),
  which also removes the `children` property/setter shims in `papyri/nodes.py`
  (`DocParam` 893-899, `FieldListItem` 1005-1023, `DefListItem` 1041-1071,
  `SeeAlsoItem` 1076-1078) that exist solely because stored field names differ
  from the traversal name.
- Unify **`Image`/`Figure`** on one "image with optional asset-ref" shape; today
  it is branched twice in `ir-reader.ts` (`collectImages` 336-357) and twice in
  `render-node.ts` (315-330).
- Collapse the three **`Numpydoc*`** nodes (`papyri/nodes.py:761-784`) into one
  `kind`-tagged node — or, if they are confirmed gen-time-only intermediates
  (constructed `gen.py:585-590`, consumed `gen.py:602-620`), demote to
  `UnserializableNode` and drop CBOR tags 4012/4013/4014 entirely.

**Payoff once homogenized:**

- `render-node.ts` (~290 lines) can table-drive the ~120 lines of "wrap children
  in one tag" / "wrap value in one tag" clones (`render-node.ts:106-216, 264-313`),
  leaving only the genuinely custom renderers (Code, Table, CrossRef, Figure,
  Footnote, SeeAlsoItem) in the switch.
- `encoder.ts` `FIELD_ORDER` (`encoder.ts:46-162`) shrinks from ~60 hand-mirrored
  entries to a handful of distinct shapes + a tag→name map. **Independent of
  homogenization**, the manual table is the package's central drift hazard: only
  tag 4010 is round-trip-tested (`ingest/tests/encoder.test.ts:269`); the other
  ~59 can silently mis-decode on a Python field reorder/rename. Either generate
  the table from the Python schema (`docs/IR.md` / `ir-schema.ts`), or extend the
  round-trip test to every tag against a real generated bundle.

### F. Decomposition (refactor, no behavior change)

- **`collect_api_docs`** — `papyri/gen.py:1807-2120`, ~315 lines doing five jobs
  (setup/filter, alias/known-ref build, per-object extract→ndoc→prepare loop,
  error flush, meta finalize). Extract `_filter_collected`, `_build_known_refs`,
  `_process_one_object(...) -> GeneratedDoc | None`, `_flush_error_report`.
  Already sanctioned in `PLAN.md`; unlocks unit-testing the per-object pipeline.
- **`replace_InlineRole`** — `papyri/tree.py:1064-1235`, ~170 lines in one
  method. Hoist the inline `_PYTHON_OBJECT_ROLES` frozenset (1192-1206, rebuilt
  per call) and the URL-scheme tuple to module constants; split into
  `_split_target_text` / `_resolve_ref_role` / `_resolve_named_hyperlink` /
  `_resolve_python_object`.
- **`Node` dunders** — `papyri/node_base.py:64-112`. `__eq__`, `__repr__`, and
  `cbor` each independently call `get_type_hints` and loop fields; the
  `Comment`-drop filter is inlined in `cbor` (64-69). Minor: share one field
  iterator.

### Smaller smells (low priority)

- `papyri/tokens.py:108, 111`: `contextscript` and `full_text` are computed
  identically — collapse.
- `papyri/gen.py:1259-1271` / `1309-1313`: the
  `(builtin_function_or_method, fused_cython_function, cython_function_or_method)`
  tuple and the SITE_PACKAGE prefix-strip loop are repeated — hoist the tuple to
  a module constant.
- `papyri/tree.py:393-424`: `generic_visit` keeps a hardcoded string list of
  leaf-passthrough node types that silently rots; `_call_method` (383-386) is a
  dead one-line indirection. Derive the leaf set structurally / inline the wrapper.
- `papyri/node_base.py:214-256` `not_type_check`: typo'd error strings
  (`"Yexpecting list"` 224/240), an unevaluated f-string (`:invalid key type…`
  234, missing `f`), and the dict branch type-checks keys as if values. Cosmetic
  (validation-failure path only) but hampers debugging.
- `papyri/doc.py:45-95` `_OrderedDictProxy`: ~50 lines hand-rolling an ordered
  mapping, with a five-name web (`ordered_sections`/`_ordered_sections`/
  `_content`/`_dp`/`content`). Python 3.7+ dicts preserve insertion order and the
  order is *also* stored in `_ordered_sections` (doc.py:140) — the parallel list
  is belt-and-suspenders. Back it with a plain `dict` or replace it outright.
- `ingest/src/blob-store.ts:100-121` `FsBlobStore.clear()` hard-codes that
  `_raw/` and `papyri.db*` are co-tenants to skip (115-116), coupling the blob
  store to the raw-store/DB layout via string matching. A fourth co-tenant would
  be silently deleted. Make the blob namespace explicit or pass reserved names in.

---

## Suggested sequencing

Land as small focused commits, low-risk first so each is independently
verifiable: **A → B → C/D → F → E**. The IR homogenization (E) goes last and is
itself staged one family at a time through `ir-reader.ts`, since it is the only
set of changes that crosses the Python↔TS seam.

## Highest-leverage changes (do these first within each layer)

1. **Unify the two serializers** (C) — same algorithm maintained twice, already
   drifting.
2. **Fix `Node.__hash__` and delete the dodge-overrides** (B) — correctness + dedup.
3. **Delete the dead code in A** — zero risk, immediate clarity.
4. **Data-drive the admonition handlers** + **single source for the section-name
   lists** (C) — biggest Python line reduction and removes a correctness footgun.
5. **Cache `ts.parse` and the serialize-path `get_type_hints`** (D) — the clear
   Python perf wins.
6. **Ingest `keyStr→id` map** (D) — biggest ingest throughput win, no schema change.
7. **Table-drive `render-node.ts` + extract the duplicated endpoints** (C/E) —
   biggest viewer readability win.
8. **Homogenize the IR families** (E) — the keystone that shrinks `nodes.py`,
   `FIELD_ORDER`, `ir-types.ts`, and `render-node.ts` together and kills the
   hand-mirrored seam.

## Verified non-findings

- `bundle-walk.ts` is genuinely reused everywhere (image-index, both nodes
  endpoints, both text-search endpoints, validate page) — walking is not
  reimplemented.
- `getBackends()` caches `{blobStore, graphDb}` in a module-level promise
  (`backends.ts:57-61`) — no per-request DB reconnect.
- `qualname-page.ts` and `doc-page.ts` build genuinely different view models and
  already share primitives via `ir-reader.ts` — no consolidation warranted.
- No dangling references to removed features (`render.py`, `rich_render`,
  `textual`, `jlab`, `browse`, `serve`) in the reviewed files; the remaining
  `ipython` mentions are legitimate Sphinx-extension/role provenance comments.
- Previously-flagged ingest dead code (`_getForwardRefs`, `_ingest*Dir`,
  `explodeBundleToDir`) is already gone.
