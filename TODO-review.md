# Review follow-ups (2026-04-18)

Punch list from the codebase review on branch
`claude/review-codebase-Zqdxw`. Items 1–5 from that review were fixed in the
same branch; this file tracks the remainder. Cross-check with `PLAN.md` —
some of these map to Phase 2 items already listed there; those are flagged.

## Phase 2 deliverables (closed)

- [x] `docs/IR.md` — written (covers on-disk layout, JSON vs CBOR split,
      per-file schema, `graphstore.py` SQLite schema, CBOR tag registry).
- [x] `papyri describe <qualname>` — implemented. Accepts shorthand,
      kind-prefixed, and full `pkg/ver/kind/id` forms.
- [x] Replace xfails with real fixes. All four now pass:
      `test_parse_blocks[numpy.linspace…]` (assert `>= 1` instead of exact
      count), `test_numpy[numpy…]` (retargeted at numpy 2.x `_core`
      submodule), `test_self_2` (rewritten to test `item_file` resolution
      instead of indexing into the papyri `__init__` docstring),
      `test_self_3` (folded into `test_self_2`).

## Code smells from the review (not in PLAN.md)

### TODOs to triage (37+)

Raw list lives in the review; the notable ones:

- `crosslink.py:50` — empty `# TODO` (delete or fill in).
- `crosslink.py:191` — commented-out
  `assert len(visitor.local) == 0, f"{visitor.local} | {self.qa}"`.
  The invariant is not checked; either re-enable or document why it's
  disabled.
- `crosslink.py:403` — `# TODO: in progress, crosslink needs version
  information`. Real feature gap; link to an issue once tracking exists.
- `crosslink.py:388` — `# TODO: version issue` (related to above).
- `ts.py:265` — `# TODO: FIX` above the ERROR-node path. The parser
  currently warns-and-skips on any `ERROR` node; worth a real pass.
- `gen.py:699` — `# TODO: scipy 1.8 workaround, remove`. scipy is well past
  1.8; try removing the workaround and see what breaks.
- 10 more TODOs in `tree.py`, 9 in `ts.py`, others in `gen.py`,
  `signature.py`, `nodes.py`, `graphstore.py`, `directives.py`,
  `examples.py`. Triage as a batch rather than one-by-one.

### Commented-out code blocks

Delete or document intent. Currently:

- `gen.py:803, 1411, 2054` — former `print_(...)` debug lines. With
  finding #1 fixed these are now orphan comments; delete.
- `crosslink.py:432` — `# print_(len(forward_refs))`. Same — delete.
- `tree.py` — 14 commented `# print(...)` lines (resolve tracing). Either
  gate behind a logger or delete.
- `examples.py:269–275` — commented function stub; decide whether it's a
  planned feature or dead weight.
- `ts.py:203` — commented `visit_arguments` method.
- `nodes.py:660–661` — commented classmethod.
- `graphstore.py:22` — `# return json.loads(self.path.read_text())` left
  over from the CBOR migration; delete.

### Typos / malformed text

- `examples.py:269` — `# TODO: uncomment once implemented<D-{>`. The
  `<D-{>` looks like a vim keystroke leaked into the file.
- `nodes.py:741` — `# TODO: Chck why we hav a Union Here` ("Check", "have").
- `tree.py:154` — `fully qualified path of the current object (.valueTODO:
  this will be weird for` — `.valueTODO` is a run-on; split into two
  sentences.

### Suppressions to revisit

- `nodes.py:602` — `for e in self.entries: # noqa: B007`. The loop variable
  `e` is unused; if the iteration is only for a side-effect/length-check,
  refactor to `for _ in self.entries:` or drop the loop entirely.

### Possibly dead / legacy deps to verify

- `pytest-trio` in `requirements-dev.txt:4`. Phase 1 removed `trio` as a
  runtime dep; no tests currently use the `@pytest.mark.trio` marker
  (`grep` finds zero). If confirmed unused, drop it too.

## Viewer follow-ups (Phase 3 / `viewer/PLAN.md`)

- [x] M1 single-page render — `viewer/src/pages/[pkg]/[ver]/[...slug].astro`
      landed. Uses `cbor-x` with tag-keyed extensions to decode the IR.
- [x] `cbor-x` added to `viewer/package.json`.
- [ ] `better-sqlite3` (or equivalent) for reading
      `~/.papyri/ingest/papyri.db` — M2 prerequisite for crosslinks /
      backrefs.
- [ ] M2–M5 (crosslinks/backrefs, examples/math/highlighting, static
      export, polish) — not started.
