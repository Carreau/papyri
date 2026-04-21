# Rename pass

A punch list of naming fixes across the Python package, the on-disk IR
format, the SQLite graph store, the CLI, and the TypeScript viewer.
Each item is independent unless marked otherwise. Rename PRs should
land in the order given under "Ordering" at the bottom — some items
require schema migration and are destructive to existing
`~/.papyri/data/` and `~/.papyri/ingest/` bundles.

> All items here assume the repo is still in the "no external
> consumers" phase. None of these names are part of a stable
> contract yet — if that changes, re-scope.

## 1. Drop all MyST references

Papyri's IR is MyST-influenced but not MyST. The leaked `myst*` strings
and the filename `myst_serialiser.py` imply a conformance we don't
have. Scrub the term everywhere except in one historical note.

### 1a. Node `type` strings (papyri/nodes.py)

Drop the `myst` prefix from the three offenders; they serialize to a
string consumed by nothing outside this repo.

- [x] `nodes.py:274` `Directive.type = "mystDirective"` → `"directive"`
- [x] `nodes.py:322` `Comment.type = "mystComment"` → `"comment"`
- [x] `nodes.py:346` `Target.type = "mystTarget"` → `"target"`

No viewer code reads these strings — the viewer dispatches on the
`__type` field (Python class name via the CBOR encoder). Verify by
grepping `viewer/` for the three literals before merging.

### 1b. Rename `myst_serialiser.py`

- [x] Rename module: `papyri/myst_serialiser.py` → `papyri/node_serializer.py`
      (also drops the British spelling — the rest of the repo is
      American).
- [x] Update import in `papyri/common_ast.py:10`.
- [x] Rewrite docstring at `papyri/myst_serialiser.py:1-11` to stop
      framing the format as "the MyST JSON spec"; document what the
      serializer actually does (internally-tagged Node → dict).

### 1c. Comments / docstrings referencing MyST

- [x] `papyri/nodes.py:189-193` — the "MyST-flavored AST nodes" banner
      and the "M prefix remains for historical reasons" note.
- [x] `papyri/nodes.py:792` — "Union type aliases (formerly in
      myst_ast.py)".
- [x] `papyri/ts.py:186` — "convert into Papyri/Myst nodes" → "Papyri
      nodes".
- [x] `papyri/ts.py:416,424-425,549,553-554` — local var `myst_acc`
      → `children_acc` (or similar).
- [x] `papyri/tree.py:557` — "Here we'll return MySt Code." docstring.
- [x] `papyri/tree.py:645-653,846-851` — method `replace_MMystDirective`
      (double-M typo!) → `replace_Directive`; rename local variable
      `myst_directive` → `directive`.
- [x] `papyri/serde.py:208-209` — "MyST-flavored classes carry a
      `type` attribute..." → just "classes that define a `type`
      string".

### 1d. Historical mention

- [x] `PLAN.md:151-152` — keep (it's real history: the
      `take2.py`/`myst_ast.py` circular import fix). No change.
- [x] `CLAUDE.md:50` — same, keep as history.
- [x] `tools/vendor_scripts.sh:30` — `papyri/static/myst.js` fetch
      from `mystjs@0.0.15`. Dead code; line already removed.

## 2. Storage "kind" vocabulary (highest-impact rename)

`kind` currently takes values `module | docs | examples | meta |
assets`. `"module"` is wrong — entries under that folder are every
API object (functions, classes, methods), not modules. This touches
the on-disk layout, SQLite schema, IR, CLI, and viewer.

- [ ] `kind="module"` → `kind="api"` everywhere:
  - `papyri/gen.py:2031` (`RefInfo.from_untrusted(...,"module",...)`)
  - `papyri/gen.py:2161` (same)
  - `papyri/gen.py:2297`, `papyri/gen.py:1423,1436-1437,1534,1536`
    (filesystem paths `where / "module"`)
  - `papyri/crosslink.py:47,55,479`
  - `papyri/__init__.py:354` (`_known_kinds` in `describe`)
  - `papyri/__init__.py:373` (glob pattern)
  - `viewer/src/lib/ir-reader.ts:420` (`case "module":`)
  - `viewer/src/pages/[pkg]/[ver]/[...slug].astro` — glob + routing.
- [ ] On-disk migration: rename folder `~/.papyri/data/<pkg>_<ver>/module/`
      → `.../api/`. Old bundles become unreadable. Drop `~/.papyri/ingest/`
      and re-ingest — this is Phase 1/2 convention already (`rm -rf
      ~/.papyri/ingest/`).
- [ ] Update `docs/IR.md` references to `module/`.
- [ ] Add a one-line note to `PLAN.md` Phase 2 marking this rename as
      landed.

## 3. SQLite columns ↔ Python attributes

`graphstore.py` schema uses different names for the same 4-tuple as
Python's `Key` and `RefInfo`. Pick one set and use it everywhere.

| Python (`Key`, `RefInfo`) | SQL (`graphstore.py`) | Suggested |
|---------------------------|-----------------------|-----------|
| `module`                  | `package`             | `package` (SQL wins — `module` is asserted to have no `.` so it's really the top-level package) |
| `version`                  | `version`             | `version` |
| `kind`                     | `category`            | `kind` (Python wins — matches `--kind` CLI flag) |
| `path`                     | `identifier`          | `qualname` |

- [ ] `graphstore.py` SQL: rename column `category` → `kind` and
      `identifier` → `qualname` in both `documents` and `destinations`
      tables. SQLite `ALTER TABLE ... RENAME COLUMN` (3.25+) works;
      the indexes on those columns need to be recreated.
- [ ] Python `Key.__init__` (`graphstore.py:57`): rename param
      `module` → `package` and `path` → `qualname`. Update
      `_t()` tuple order if you keep the positional contract.
- [ ] `RefInfo` fields (`nodes.py:429-432`): same rename. `RefInfo`
      and `Key` now have identical shape — see item 6.
- [ ] Update all `.module` / `.path` call sites (~40 uses, mostly in
      `crosslink.py`, `gen.py`, `__init__.py`).
- [ ] Existing DBs are unreadable after the SQL migration. Document
      "re-ingest required" in the PR body.

## 4. `RefInfo` duplicates `Key`

`RefInfo` (nodes.py:407) and `Key` (graphstore.py:56) are both
`(package, version, kind, qualname)` 4-tuples with ~identical
semantics. After item 3 they are field-identical.

- [ ] Merge into one class, ideally in `graphstore.py`. Keep
      `RefInfo` as the name (it's the one used in the CBOR schema —
      tag 4000). Move the class to `graphstore.py` and re-export
      from `nodes.py` for back-compat during the transition.
- [ ] Delete `Key.__contains__`, `_t`, `__iter__` once merged
      (`RefInfo` already has `__iter__`).
- [ ] Update `from_untrusted` classmethod — currently on `RefInfo`
      only.

## 5. Node-class renames in `papyri/nodes.py`

### 5a. `Numpydoc*` prefix — IR shouldn't name its input format

Three classes (`NumpydocExample`, `NumpydocSeeAlso`,
`NumpydocSignature`) each store `value` + `title` — they're titled
`Section`s. Either fold or rename.

Recommendation: fold. All three are near-trivial.

- [ ] Delete `NumpydocExample` (nodes.py:448-451) — replace usages
      with `Section([...], title="Examples")`.
- [ ] Delete `NumpydocSeeAlso` (nodes.py:454-457) — replace with
      `Section([...], title="See Also")`.
- [ ] Delete `NumpydocSignature` (nodes.py:460-463) — replace with
      `Section([...], title="Signature")`.
- [ ] Remove the corresponding CBOR tag registrations (4012, 4013,
      4014). Add entries to an `IR-CHANGELOG.md` (PLAN.md mentions
      this file as a follow-up — good place to start it).

If a fold is too invasive, the fallback is a rename to format-neutral
names: `ExamplesSection` / `SeeAlsoSection` / `SignatureSection`.

### 5b. Three "parameter" classes

- [x] `papyri/nodes.py` `Param` → `DocParam` (docstring param entry).
- [x] `papyri/nodes.py` `Parameters` — kept as the container name.
- [x] `papyri/signature.py` `ParameterNode` → `SigParam`.

### 5c. Field rename inside renamed `DocParam`

- [x] `DocParam.param` → `DocParam.name`. Updated `__getitem__` and
      `__repr__`; viewer `IrNode.astro` dispatch updated too.
- [x] `DocParam.type_` → `DocParam.annotation`. Same rename across
      the two gen.py constructor sites and the viewer.

### 5d. Small or abbreviated names

- [x] `Fig` → `Figure`. Done; viewer `FIELD_ORDER[4024]` + `IrNode`
      dispatch follow.
- [x] `XRef` → `CrossRef`. Done; viewer `FIELD_ORDER[4002]` + dispatch
      follow; `XRefShape` / `XRefResolution` helpers renamed to
      `CrossRefShape` / `CrossRefResolution` for consistency.
- [ ] `ThematicBreak` (nodes.py:358) → `Rule` (HTML-familiar) or
      leave. Not obviously a win; keeping for now.

### 5e. In-memory intermediates (`Gen*`)

`Gen` reads as "generic" more than "generation-time".

- [ ] `GenToken` (nodes.py:575) → `PendingToken` (or `RawToken`).
- [ ] `GenCode` (nodes.py:581) → `PendingCode` (or `RawCode`).
- [ ] `GenCode.ce_status` → `exec_status`.
- [ ] Also rename `GenVisitor` (tree.py:813) → `PendingVisitor` /
      `GenerateVisitor` if it stays internal.

### 5f. Almost-dead classes — delete or collapse

- [ ] `Leaf` (nodes.py:155) — only `SubstitutionRef` subclasses it.
      Inline or delete.
- [ ] `IntermediateNode` (nodes.py:392) — docstring says "dummy,
      should not make it to final product". Unused. Delete.
- [ ] `Options` (nodes.py:649) — `values: List[str]`; overlaps with
      `Directive.options: Dict[str, str]`. Verify usage; delete if dead.
- [ ] Collapse `Unimplemented` / `UnimplementedInline` /
      `IntermediateNode` — three "we haven't handled this"
      placeholders. Block-vs-inline distinction is real; three-way
      split isn't.

## 6. `GeneratedDoc` / `IngestedDoc`

Parallel pair (`gen.py:778`, `crosslink.py:63`) with ~90% identical
fields. The difference is link-processing state.

- [ ] Option A (preferred): single `Doc` class with a boolean
      `linked: bool`. Drop one CBOR tag. `process()` flips the flag.
- [ ] Option B: keep both, but rename to name the *transformation*:
      `UnlinkedDoc` / `LinkedDoc`, or `RawDoc` / `CrossLinkedDoc`.
- [ ] In either case: stop duplicating the `__slots__` tuple literally
      (crosslink.py:64-77 vs gen.py:790-803 are copies). Single
      source.

## 7. Field-level renames (mechanical)

- [ ] `qa` → `qualname`. Everywhere. Grep hits 200+ but almost all
      are trivial. Touches `gen.py`, `crosslink.py`, tests.
- [ ] `arbitrary` (`GeneratedDoc.arbitrary`, `IngestedDoc.arbitrary`)
      → `extra_sections` or `unnamed_sections` (holds sections that
      aren't one of the numpydoc-known titles).
- [ ] `DefListItem.dt` / `DefListItem.dd` (nodes.py:700,707) →
      `term` / `definition`. HTML-jargon replaced with English. Update
      the `children` getter/setter and the viewer.
- [ ] `_content` + `_ordered_sections` + `_OrderedDictProxy` collapse:
      replace with `sections: OrderedDict[str, Section]`. 3.7+ dict
      ordering is guaranteed; `_OrderedDictProxy` (gen.py:728) is no
      longer needed. Big code-deletion win; touches gen.py,
      crosslink.py, viewer.

## 8. CLI commands (`papyri/__init__.py`)

- [ ] `drop` (`__init__.py:241`) → `reset-db` or `drop-db`. Current
      name is ambiguous and destructive.
- [ ] `pack` (`__init__.py:220`) → `archive` (it zips ingested
      bundles — `shutil.make_archive`).
- [ ] `bootstrap` (`__init__.py:227`) → `init` or `init-config`.
- [ ] `find` (`__init__.py:258`) → `grep-nodes` or `find-nodes`. The
      current `find <NodeClass>` actually searches for *documents
      containing* nodes of that class; that's a grep, not a find.

Not renaming: `gen`, `ingest`, `relink`, `describe`.

## 9. Module filenames

- [x] `papyri/miniserde.py` → `papyri/serde.py` (dropped "mini").
- [x] `papyri/common_ast.py` → `papyri/node_base.py`. Kept separate
      from `nodes.py` (folding was an option but `Base`/`Node` are
      usefully its own import surface for the ~5 sites that only
      need the base class).
- [x] `papyri/miscs.py` → `papyri/misc.py` (singular).
- [x] `papyri/vref.py` → `papyri/numpydoc_compat.py`. It's the
      NumpyDocString subclass with a more-lenient section alias
      table; new name says what it is.
- [x] `papyri/myst_serialiser.py` → `papyri/node_serializer.py`
      (covered in item 1b).

## 10. Viewer-side follow-ups

Most of these are downstream of items 1, 2, 3, 5, 7. Listed here so
nothing falls through.

- [ ] `viewer/src/lib/ir-reader.ts` — update `"module"` case (item 2),
      any references to `RefInfo`/`Key` fields (item 3), `Param`
      shape (item 5c), `arbitrary` (item 7).
- [ ] `viewer/src/components/IrNode.astro` — dispatches on class
      name; update every rename in item 5 (`Figure`, `CrossRef`,
      `AdmonitionTitle`, etc.).
- [ ] `viewer/src/pages/[pkg]/[ver]/[...slug].astro` — route param
      and glob patterns reference `module/`.
- [ ] `viewer/src/pages/[pkg]/[ver]/docs/[...slug].astro` — `"docs"`
      kind; left alone unless item 2 is extended to rename `docs` too.
- [ ] Re-run `pnpm check && pnpm test && pnpm build` after each
      viewer-touching rename; vitest has 35 cases that'll catch
      most mismatches.

## Ordering

Do these in this order — earlier items make later ones smaller.

1. **Item 1 (MyST strip)** — low-risk, touches strings/comments only.
   Lands first.
2. **Item 5f (delete dead classes)** — shrinks the surface before
   anything else touches nodes.py.
3. **Item 5a (Numpydoc prefix)** — removes three classes, fewer to
   rename in later passes.
4. **Item 5b/5c/5d/5e (node renames)** — one commit per group.
5. **Item 7 (field renames)** — mechanical; do after class renames
   settle.
6. **Item 2 (`kind="module"` → `"api"`)** — destructive for existing
   bundles. Coordinate with viewer (item 10).
7. **Item 3 (SQL column rename)** — destructive for existing DB.
   Schema migration commit on its own.
8. **Item 4 (`RefInfo` / `Key` merge)** — depends on items 3 and 5.
9. **Item 6 (`GeneratedDoc` / `IngestedDoc` merge)** — largest
   structural change; save for last.
10. **Items 8, 9 (CLI + filenames)** — independent, pick them up
    whenever convenient.

## Out of scope for this pass

- IR encoding (JSON vs CBOR). Tracked in PLAN.md Phase 2.
- Adding features, even tiny ones. Rename-only commits.
- Renaming `take2` (already gone — file no longer exists; the name
  only survives in `CLAUDE.md` history notes).
