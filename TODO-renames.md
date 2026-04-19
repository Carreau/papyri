# Rename pass — remaining items

A punch list of naming fixes still open. Assumes the repo is still in
the "no external consumers" phase — none of these names are part of a
stable contract.

**Landed** (for receipts, `git log --grep='^rename:'`):
- §1 Drop MyST references (`661b332e`) — node `type` strings,
  `myst_serialiser.py` → `node_serializer.py`, comment/docstring
  cleanup.
- §5b `Param` → `DocParam`, `ParameterNode` → `SigParam` (`53c2e967`).
- §5c `DocParam.param` → `.name`, `.type_` → `.annotation` (`53c2e967`).
- §5d `Fig` → `Figure`, `XRef` → `CrossRef` (`1f8ec880`). `ThematicBreak`
  → `Rule` skipped — not a win.
- §9 Module filenames (`5bb6531d`): `miniserde`→`serde`,
  `miscs`→`misc`, `common_ast`→`node_base`, `vref`→`numpydoc_compat`.

Everything below is open. Ordering at the bottom is the intended merge
order — earlier items shrink later ones.

## §2. Storage "kind" vocabulary — destructive

`kind` currently takes `module | docs | examples | meta | assets`.
`"module"` is wrong — entries under that folder are every API object
(functions, classes, methods), not modules.

- [ ] Swap `kind="module"` → `kind="api"` across:
  - `papyri/gen.py` (~5 sites: `RefInfo.from_untrusted` + filesystem
    `where / "module"`)
  - `papyri/crosslink.py` (3 sites)
  - `papyri/__init__.py` (`_known_kinds`, glob pattern in `describe`)
  - `viewer/src/lib/ir-reader.ts` (`case "module"` in `linkForRef`)
  - `viewer/src/pages/[pkg]/[ver]/[...slug].astro` route + glob
- [ ] On-disk migration: rename `~/.papyri/data/<pkg>_<ver>/module/`
      → `.../api/`. Old bundles unreadable; `rm -rf ~/.papyri/ingest/`
      and re-ingest.
- [ ] Update `docs/IR.md`.

## §3. SQLite columns ↔ Python attributes — destructive

`graphstore.py` SQL + Python `Key` + `RefInfo` use three different
names for the same 4-tuple. Pick one set:

| current (Python)          | current (SQL)         | target        |
|---------------------------|-----------------------|---------------|
| `module`                  | `package`             | `package`     |
| `version`                 | `version`             | `version`     |
| `kind`                    | `category`            | `kind`        |
| `path`                    | `identifier`          | `qualname`    |

- [ ] Rename SQL columns in `documents` + `destinations` tables
      (`ALTER TABLE ... RENAME COLUMN`); recreate indexes.
- [ ] Rename `Key.__init__` params and `RefInfo` fields accordingly.
- [ ] Update ~40 `.module` / `.path` call sites.
- [ ] PR body flags "re-ingest required".

## §4. `RefInfo` duplicates `Key`

After §3 they're field-identical (`package, version, kind, qualname`).

- [ ] Merge into a single class in `graphstore.py`; keep the name
      `RefInfo` (CBOR tag 4000 uses it). Re-export from `nodes.py` for
      transition.
- [ ] Drop `Key.__contains__`, `_t`, `__iter__`.
- [ ] Move `from_untrusted` classmethod with it.

## §5. Node-class renames in `papyri/nodes.py`

### §5a. Drop `Numpydoc*` prefix — IR shouldn't name its input format

Three classes (`NumpydocExample`, `NumpydocSeeAlso`,
`NumpydocSignature`) each store `value` + `title` — they're titled
`Section`s.

- [ ] Fold into `Section([...], title="Examples" / "See Also" /
      "Signature")`; remove CBOR tags 4012 / 4013 / 4014. Start an
      `IR-CHANGELOG.md` to record the drop.

Fallback if fold is too invasive: rename to `ExamplesSection` /
`SeeAlsoSection` / `SignatureSection`.

### §5e. In-memory intermediates (`Gen*`)

`Gen*` reads as "generic" more than "generation-time".

- [ ] `GenToken` → `PendingToken` / `RawToken`.
- [ ] `GenCode` → `PendingCode` / `RawCode`; `.ce_status` →
      `.exec_status`.
- [ ] `GenVisitor` (tree.py) → `PendingVisitor` / `GenerateVisitor`.

### §5f. Almost-dead classes — delete or collapse

- [ ] `Leaf` (only `SubstitutionRef` subclasses) — inline or delete.
- [ ] `IntermediateNode` — unused per its own docstring; delete.
- [ ] `Options` (`values: list[str]`) — overlaps with
      `Directive.options: dict`. Verify and delete if dead.
- [ ] Collapse `Unimplemented` / `UnimplementedInline` /
      `IntermediateNode` — keep the block-vs-inline distinction, drop
      the three-way split.

## §6. `GeneratedDoc` / `IngestedDoc` merge

Parallel pair (`gen.py`, `crosslink.py`) with ~90% identical fields;
difference is link-processing state.

- [ ] **Preferred:** single `Doc` class with `linked: bool`. Drop one
      CBOR tag. `process()` flips the flag.
- [ ] **Or:** keep both but rename to describe the transformation:
      `UnlinkedDoc` / `LinkedDoc`.
- [ ] Either way: stop duplicating the `__slots__` tuple (crosslink.py
      vs gen.py).

## §7. Field-level renames (mechanical)

- [ ] `qa` → `qualname` everywhere (200+ trivial hits in gen.py,
      crosslink.py, tests).
- [ ] `arbitrary` (on `GeneratedDoc` / `IngestedDoc`) → `extra_sections`
      (or `unnamed_sections`).
- [ ] `DefListItem.dt` / `.dd` → `.term` / `.definition`. Update the
      `children` getter/setter and the viewer.
- [ ] Collapse `_content` + `_ordered_sections` + `_OrderedDictProxy`
      into `sections: OrderedDict[str, Section]`. dict ordering is
      guaranteed 3.7+. Big code-deletion win.

## §8. CLI commands (`papyri/__init__.py`)

- [ ] `drop` → `reset-db` / `drop-db` (disambiguate).
- [ ] `pack` → `archive` (it zips — `shutil.make_archive`).
- [ ] `bootstrap` → `init` / `init-config`.
- [ ] `find` → `grep-nodes` / `find-nodes` (current `find` greps
      documents for a node class).

Not renaming: `gen`, `ingest`, `relink`, `describe`.

## §10. Viewer-side follow-ups

Downstream of §2 / §3 / §5 / §7. Mostly auto-caught by vitest (42
cases) + `pnpm check`. Re-run both after each rename.

- [ ] `ir-reader.ts` — `"module"` case (§2), `RefInfo`/`Key` field
      names (§3), `arbitrary` (§7).
- [ ] `IrNode.astro` — dispatches on class name; update each §5 rename.
- [ ] `[...slug].astro` + any `module/`-globbing page — §2.

## Ordering

1. **§5f** (delete dead classes) — shrinks the surface before
   anything else.
2. **§5a** (Numpydoc fold) — removes three classes, fewer to touch
   later.
3. **§5e** — independent Gen* renames.
4. **§7** (field renames) — mechanical; after §5 settles.
5. **§2** (`kind="module"` → `"api"`) — destructive; coordinate with
   viewer follow-ups (§10).
6. **§3** (SQL column rename) — destructive; own PR.
7. **§4** (RefInfo / Key merge) — depends on §3.
8. **§6** (GeneratedDoc / IngestedDoc merge) — largest; save for
   last.
9. **§8** (CLI names) — independent, any time.

## Out of scope for the pass

- IR encoding format (JSON vs CBOR) — PLAN.md Phase 2.
- Adding features. Rename-only commits.
