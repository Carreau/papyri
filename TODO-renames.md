# Rename pass

A punch list of naming fixes across the Python package, the on-disk IR
format, the SQLite graph store, the CLI, and the TypeScript viewer.
Each item is independent unless marked otherwise. Rename PRs should
land in the order given under "Ordering" at the bottom — some items
require schema migration and are destructive to existing
`~/.papyri/data/` and `~/.papyri/ingest/` bundles.

> Status: **nothing on this list has landed yet.** Line numbers are
> current as of this file's last update but drift constantly — re-grep
> before editing.

> All items here assume the repo is still in the "no external
> consumers" phase. None of these names are part of a stable
> contract yet — if that changes, re-scope.

## 2. Storage "kind" vocabulary (highest-impact rename)

`kind` currently takes values `module | docs | examples | meta |
assets`. `"module"` is wrong — entries under that folder are every
API object (functions, classes, methods), not modules. This touches
the on-disk layout, SQLite schema, IR, CLI, and viewer.

- [ ] `kind="module"` → `kind="api"` everywhere:
  - `papyri/gen.py:1055`, `1140`, `1944`, `2179`
    (`RefInfo.from_untrusted(…, "module", …)`)
  - `papyri/gen.py:957`, `994`, `999`, `1060`, `1429`, `1550`, `1552`,
    `1784`, `2049`, `2329` (filesystem paths and `kind == "module"`
    checks)
  - `papyri/crosslink.py:48`, `53`, `367`, `421`, `449`, `472`
  - `papyri/__init__.py:238` (`tomli_w.dumps(dict(name={"module":…}))` —
    the config schema key, not the kind)
  - `papyri/__init__.py:356` (`_known_kinds` in `describe`)
  - `viewer/src/lib/ir-reader.ts:59`, `103`, `329`, `446`
  - `viewer/src/pages/[pkg]/[ver]/[...slug].astro:71` and glob/routing.
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
| `version`                 | `version`             | `version` |
| `kind`                    | `category`            | `kind` (Python wins — matches `--kind` CLI flag) |
| `path`                    | `identifier`          | `qualname` |

- [ ] `graphstore.py` SQL: rename column `category` → `kind` and
      `identifier` → `qualname` in both `nodes` and `edges` schema
      (see `graphstore.py:19-22` for the CREATE TABLE and
      `graphstore.py:215`, `230`, `246`, `279`, `283`, `338`, `351`,
      `357-358`, `366` for the queries that reference them). SQLite
      `ALTER TABLE … RENAME COLUMN` (3.25+) works; the indexes on
      those columns need to be recreated.
- [ ] Python `Key.__init__` (`graphstore.py:82`): rename param
      `module` → `package` and `path` → `qualname`. Update the `_t()`
      tuple order if you keep the positional contract.
- [ ] `RefInfo` fields (`nodes.py:462`): same rename. `RefInfo` and
      `Key` now have identical shape — see item 4.
- [ ] Update all `.module` / `.path` call sites (~40 uses, mostly in
      `crosslink.py`, `gen.py`, `__init__.py`).
- [ ] Existing DBs are unreadable after the SQL migration. Document
      "re-ingest required" in the PR body.

## 4. `RefInfo` duplicates `Key`

`RefInfo` (`nodes.py:462`) and `Key` (`graphstore.py:81`) are both
`(package, version, kind, qualname)` 4-tuples with ~identical
semantics. After item 3 they are field-identical.

- [ ] Merge into one class, ideally in `graphstore.py`. Keep
      `RefInfo` as the name (it's the one used in the CBOR schema —
      tag 4000). Move the class to `graphstore.py` and re-export from
      `nodes.py` for back-compat during the transition.
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

- [ ] Delete `NumpydocExample` (`nodes.py:504`) — replace usages with
      `Section([...], title="Examples")`.
- [ ] Delete `NumpydocSeeAlso` (`nodes.py:510`) — replace with
      `Section([...], title="See Also")`.
- [ ] Delete `NumpydocSignature` (`nodes.py:516`) — replace with
      `Section([...], title="Signature")`.
- [ ] Remove the corresponding CBOR tag registrations (4012, 4013,
      4014). Add entries to an `IR-CHANGELOG.md` (`PLAN.md` mentions
      this file as a follow-up — good place to start it).
- [ ] Update `papyri/gen.py:69-71` import and usages at
      `gen.py:985`, `987`, `990`, `1011`.

If a fold is too invasive, the fallback is a rename to format-neutral
names: `ExamplesSection` / `SeeAlsoSection` / `SignatureSection`.

### 5d. Small or abbreviated names

- [ ] `ThematicBreak` (`nodes.py:387`) → `Rule` (HTML-familiar) or
      leave. Not obviously a win; keeping for now.

### 5e. In-memory intermediates (`Gen*`)

`Gen` reads as "generic" more than "generation-time".

- [ ] `GenToken` (`nodes.py:623`) → `PendingToken` (or `RawToken`).
- [ ] `GenCode` (`nodes.py:629`) → `PendingCode` (or `RawCode`).
- [ ] `GenCode.ce_status` → `exec_status`.
- [ ] Also rename `GenVisitor` (`tree.py:921`) → `PendingVisitor` /
      `GenerateVisitor` if it stays internal.

### 5f. Almost-dead classes — delete or collapse

- [ ] `Leaf` (`nodes.py:162`) — only `SubstitutionRef` subclasses it.
      Inline or delete.
- [ ] `IntermediateNode` (`nodes.py:419`) — docstring says "dummy,
      should not make it to final product". Verify unused, then
      delete.
- [ ] `Options` (`nodes.py:697`) — `values: List[str]`; overlaps with
      `Directive.options: Dict[str, str]`. Verify usage; delete if
      dead.
- [ ] Collapse `Unimplemented` (`nodes.py:218`) / `UnimplementedInline`
      (`nodes.py:412`) / `IntermediateNode` — three "we haven't
      handled this" placeholders. Block-vs-inline distinction is real;
      three-way split isn't.

## 6. `GeneratedDoc` / `IngestedDoc`

Parallel pair (`gen.py:779`, `crosslink.py:60`) with ~90% identical
fields. The difference is link-processing state.

- [ ] Option A (preferred): single `Doc` class with a boolean
      `linked: bool`. Drop one CBOR tag. `process()` flips the flag.
- [ ] Option B: keep both, but rename to name the *transformation*:
      `UnlinkedDoc` / `LinkedDoc`, or `RawDoc` / `CrossLinkedDoc`.
- [ ] In either case: stop duplicating the `__slots__` tuple literally
      (`crosslink.py:64-77` vs `gen.py:790-803` are copies). Single
      source.

## 7. Field-level renames (mechanical)

- [ ] `qa` → `qualname`. Everywhere. Grep hits 200+ but almost all
      are trivial. Touches `gen.py`, `crosslink.py`, tests.
- [ ] `arbitrary` (`GeneratedDoc.arbitrary`, `IngestedDoc.arbitrary`)
      → `extra_sections` or `unnamed_sections` (holds sections that
      aren't one of the numpydoc-known titles).
- [ ] `DefListItem.dt` / `DefListItem.dd` (`nodes.py:736`, `741`) →
      `term` / `definition`. HTML-jargon replaced with English. Update
      the `children` getter/setter and the viewer.
- [ ] `_content` + `_ordered_sections` + `_OrderedDictProxy` collapse:
      replace with `sections: OrderedDict[str, Section]`. 3.7+ dict
      ordering is guaranteed; `_OrderedDictProxy` (`gen.py:729`) is no
      longer needed. Big code-deletion win; touches `gen.py`,
      `crosslink.py`, viewer.

## 8. CLI commands (`papyri/__init__.py`)

- [ ] `drop` (`__init__.py:242`) → `reset-db` or `drop-db`. Current
      name is ambiguous and destructive.
- [ ] `pack` (`__init__.py:221`) → `archive` (it zips ingested
      bundles — `shutil.make_archive`).
- [ ] `bootstrap` (`__init__.py:228`) → `init` or `init-config`.
- [ ] `find` (`__init__.py:259`) → `grep-nodes` or `find-nodes`. The
      current `find <NodeClass>` actually searches for *documents
      containing* nodes of that class; that's a grep, not a find.

Not renaming: `gen`, `ingest`, `relink`, `describe`.

## 10. Viewer-side follow-ups

Most of these are downstream of items 2, 3, 5, 7. Listed here so
nothing falls through.

- [ ] `viewer/src/lib/ir-reader.ts` — update `"module"` case
      (`:446`), `RefInfo` field list (`:103`), `modDir` path build
      (`:59`, `:329`) (item 2); any references to `RefInfo`/`Key`
      fields (item 3); `arbitrary` (item 7).
- [ ] `viewer/src/components/IrNode.astro` — dispatches on class
      name; update every rename in item 5.
- [ ] `viewer/src/pages/[pkg]/[ver]/[...slug].astro` — route param
      and glob patterns reference `module/` (`:71` for
      `getBackrefs`).
- [ ] `viewer/src/pages/[pkg]/[ver]/docs/[...slug].astro` — `"docs"`
      kind; left alone unless item 2 is extended to rename `docs` too.
- [ ] Re-run `pnpm check && pnpm test && pnpm build` after each
      viewer-touching rename; vitest has 35 cases that'll catch most
      mismatches.

## Ordering

Do these in this order — earlier items make later ones smaller.

1. **Item 5f (delete dead classes)** — shrinks the surface before
   anything else touches `nodes.py`.
2. **Item 5a (Numpydoc prefix)** — removes three classes, fewer to
   rename in later passes.
3. **Items 5d/5e (remaining node renames)** — one commit per group.
4. **Item 7 (field renames)** — mechanical; do after class renames
   settle.
5. **Item 2 (`kind="module"` → `"api"`)** — destructive for existing
   bundles. Coordinate with viewer (item 10).
6. **Item 3 (SQL column rename)** — destructive for existing DB.
   Schema migration commit on its own.
7. **Item 4 (`RefInfo` / `Key` merge)** — depends on items 3 and 5.
8. **Item 6 (`GeneratedDoc` / `IngestedDoc` merge)** — largest
   structural change; save for last.
9. **Item 8 (CLI commands)** — independent, pick up whenever
   convenient.

## Out of scope for this pass

- IR encoding (JSON vs CBOR). Tracked in `PLAN.md` Phase 2 (now
  resolved: CBOR everywhere for IR; `papyri.json` / `toc.json` stay
  JSON).
- Adding features, even tiny ones. Rename-only commits.
- Renaming `take2` (already gone — file no longer exists; the name
  only survives in `CLAUDE.md` history notes).
