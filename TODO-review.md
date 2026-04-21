# Review follow-ups (2026-04-18, refreshed 2026-04-19)

Originated as a punch list from the codebase review on branch
`claude/review-codebase-Zqdxw`. Keeps shrinking as items land. Check
against `PLAN.md` — some items map to phases tracked there; that
remains authoritative.

## Remaining code smells

### Still-open TODOs

- `crosslink.py` version resolution across packages. Two related
  prose TODOs left in `crosslink.py`:
  - the main `.process` loop has a stale `assert len(visitor.local)
    == 0` that would need a gen-time pass over local refs before it
    can be re-enabled.
  - `doc_blob.all_forward_refs()` on Figures: Figure's `RefInfo.version`
    is populated at walk time today; proper fix populates it at
    serialisation time.
  Neither is urgent, but anyone touching cross-package linking should
  read them first.

- `tree.py` still has ~10 `TODO:` markers inside the directive /
  resolve code paths. Triage as a batch when the resolver is
  touched; not blocking day-to-day work.

### Dev-deps / housekeeping

- No outstanding deps to audit. `pytest-trio` was dropped; viewer
  deps are minimal (`cbor-x`, `better-sqlite3`, `katex`, `shiki`).

## Landed since this file was first written

Rolled up for context (not actionable):

- Deleted orphan debug comments in `gen.py`, `crosslink.py`,
  `tree.py`, `ts.py`, `nodes.py`, `graphstore.py`, `examples.py`.
- Fixed typos (`Chck why we hav`, `.valueTODO:` run-on, vim-key
  leak in `examples.py`).
- Dropped the `# noqa: B007` suppression by renaming the unused loop
  var.
- Turned the scipy-1.8 module-walk warning into a DEBUG log and
  rewrote the comment around it — the check is generic, not
  scipy-specific.
- Turned the tree-sitter ERROR-node path into a `Text` fallback
  instead of silently dropping content; logged at DEBUG.
- Fixed `papyri relink` crash when `DirectiveVisiter` is
  constructed without a `config=`.
- Expanded `.gitignore` to cover macOS / editor / Phase-1-leftover
  directories.
