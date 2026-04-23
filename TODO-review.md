# Review follow-ups (2026-04-18, refreshed 2026-04-23)

Originated as a punch list from the codebase review on branch
`claude/review-codebase-Zqdxw`. Keeps shrinking as items land. Check
against [`PLAN.md`](PLAN.md) — some items map to phases tracked there;
that remains authoritative.

See also: [`TODO`](TODO) (known bugs + linting queue) and
[`TODO-renames.md`](TODO-renames.md) (rename pass).

## Remaining code smells

### Still-open TODOs

- `crosslink.py` version resolution across packages. Three related
  prose `TODO:` markers left in `crosslink.py` (lines 172, 380, 393,
  415):
  - the main `.process` loop has a stale `assert len(visitor.local)
    == 0` that would need a gen-time pass over local refs before it
    can be re-enabled (`:172`).
  - per-reference version information is still needed to support
    cross-package linking correctly (`:393`).
  - `doc_blob.all_forward_refs()` on Figures: Figure's
    `RefInfo.version` is populated at walk time today; proper fix
    populates it at serialisation time (`:415`).
  Neither is urgent, but anyone touching cross-package linking should
  read them first. PLAN.md "Follow-ups" echoes this item as well.

- `tree.py` still has ~8 `TODO:` markers inside the directive /
  resolve code paths. Triage as a batch when the resolver is
  touched; not blocking day-to-day work.

### Dev-deps / housekeeping

- The initial pass is clear (`pytest-trio` dropped; viewer deps
  minimal). Newer stability tooling — `pytest-xdist`,
  `pytest-randomly`, `pytest-timeout`, `pip-audit`, `bandit`,
  pre-commit — is queued in [`TODO`](TODO) under "Linting / stability
  tooling". Don't double-track here.

