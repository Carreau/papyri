# Review follow-ups

Originally a codebase-review punch list; closed items rolled into
`PLAN.md` or absorbed into the rename pass. What's left below is
actionable but not scheduled.

## Cross-package linking

`papyri/crosslink.py` has two prose TODOs anyone touching cross-package
resolution should read first:

- **`doc_blob.all_forward_refs()` on Figures.** `Figure.RefInfo.version`
  is populated at walk time today; the proper fix populates it at
  serialisation time so downstream consumers don't have to re-resolve.
- **`.process()` loop** has a disabled `assert len(visitor.local) == 0`.
  Re-enabling it requires a gen-time pass over local refs first (the
  ingest-side visitor shouldn't be discovering any).

## Resolver / directive TODOs in `tree.py`

~10 `TODO:` markers in the directive + resolve code paths (toctree
self-refs, recursion depth, relative-path handling, unknown domain
roles). Triage as a batch when the resolver is next touched; not
blocking.

## Dev-deps / housekeeping

None outstanding right now — `pytest-trio` is gone, viewer deps are
minimal. Queued linting / stability tooling lives in `TODO`.
