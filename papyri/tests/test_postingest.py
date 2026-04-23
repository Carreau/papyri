"""
Post-ingest verification tests.

These tests are marked ``postingest`` and are **skipped** by the regular test
suite (``pytest -m "not postingest"``).  They run only after a full ingest +
relink cycle, either in CI (see ``.github/workflows/python-package.yml``) or
locally after::

    papyri gen examples/papyri.toml --no-infer
    papyri ingest ~/.papyri/data/papyri_<version>
    papyri relink

Back-reference tests
--------------------
These assert graph-store link integrity — e.g. that a module doc which
contains ``:func:`example1``` really has a graphstore link pointing at
``papyri.examples:example1``, and that the reverse (back-reference) edge
is visible from that function's node.

Subtree fixture tests
---------------------
Each ``papyri/tests/postingest/*.json`` file describes one check:

.. code-block:: json

    {
        "description": "human-readable label for pytest output",
        "key": {
            "module": "<package>",
            "kind":   "module",
            "path":   "<qualified.name>"
        },
        "contains": { "<key>": "<value>", ... }
    }

The test decodes the CBOR blob for the given key, converts the resulting
``IngestedDoc`` to a dict via ``to_dict()``, and then checks whether
``"contains"`` appears *anywhere* inside that dict as a recursive sub-match.
This lets you assert things like "the signature is a coroutine function" or
"the docstring body includes a paragraph node" without pinning the exact shape
of the full document.

Add new JSON files to the ``postingest/`` directory to grow coverage;
the parametrised ``test_subtree_fixture`` test discovers them automatically.
"""

import json
from pathlib import Path

import pytest

from papyri.graphstore import GLOBAL_PATH, GraphStore, Key

_FIXTURES_DIR = Path(__file__).parent / "postingest"
_INGEST_ROOT = GLOBAL_PATH.parent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _open_store() -> GraphStore:
    """Open the global ingest store, or skip the test if not built yet."""
    if not GLOBAL_PATH.exists():
        pytest.skip(
            f"Ingest store not found at {GLOBAL_PATH}. "
            "Run 'papyri ingest' and 'papyri relink' first."
        )
    return GraphStore(_INGEST_ROOT)


def _glob_one(store: GraphStore, module: str, kind: str, path: str) -> Key:
    """Return the first key matching (module, *, kind, path), or skip."""
    keys = store.glob((module, None, kind, path))
    if not keys:
        pytest.skip(f"{module}/{kind}/{path} not found in ingest store")
    return keys[0]


def contains_subtree(tree: object, pattern: object) -> bool:
    """Return True if *pattern* appears anywhere inside *tree* as a sub-match.

    For a dict *pattern*: every key in the pattern must exist in the same dict
    node of *tree* and its values must recursively match.  The search descends
    into both dicts and lists so deeply-nested nodes are found automatically.
    """
    if isinstance(pattern, dict):
        if isinstance(tree, dict):
            if all(
                k in tree and contains_subtree(tree[k], pattern[k]) for k in pattern
            ):
                return True
            return any(contains_subtree(v, pattern) for v in tree.values())
        if isinstance(tree, list):
            return any(contains_subtree(item, pattern) for item in tree)
        return False
    if isinstance(pattern, list):
        if isinstance(tree, list):
            return any(contains_subtree(item, pattern) for item in tree)
        return False
    return tree == pattern


# ---------------------------------------------------------------------------
# Back-reference tests
# ---------------------------------------------------------------------------


@pytest.mark.postingest
def test_example1_backref_from_module() -> None:
    """papyri.examples module doc has ``:func:`example1```.

    After ingest the graphstore must contain a forward link
    ``papyri.examples`` → ``papyri.examples:example1``, and therefore
    ``papyri.examples:example1`` must report ``papyri.examples`` as a
    back-reference.
    """
    store = _open_store()
    example1_key = _glob_one(store, "papyri", "module", "papyri.examples:example1")
    backrefs = store.get_backref(example1_key)
    module_refs = [k for k in backrefs if k.path == "papyri.examples"]
    assert module_refs, (
        "Expected papyri.examples (module) in back-refs of "
        f"papyri.examples:example1; got {sorted(str(k) for k in backrefs)}"
    )


@pytest.mark.postingest
def test_numpy_linspace_ingested() -> None:
    """numpy:linspace exists in the store after numpy is ingested.

    Skipped automatically when the numpy bundle has not been ingested.
    """
    store = _open_store()
    _glob_one(store, "numpy", "module", "numpy:linspace")


# ---------------------------------------------------------------------------
# Subtree fixture tests
# ---------------------------------------------------------------------------

_FIXTURE_FILES = sorted(_FIXTURES_DIR.glob("*.json")) if _FIXTURES_DIR.is_dir() else []


@pytest.mark.postingest
@pytest.mark.parametrize("fixture_path", _FIXTURE_FILES, ids=lambda p: p.stem)
def test_subtree_fixture(fixture_path: Path) -> None:
    """Decode the ingested CBOR blob and verify it contains the fixture pattern.

    Each JSON file in ``papyri/tests/postingest/`` drives one assertion.
    """
    from papyri.crosslink import IngestedDoc  # noqa: F401 — registers CBOR tag 4010
    from papyri.nodes import encoder

    spec = json.loads(fixture_path.read_text())
    description: str = spec.get("description", fixture_path.stem)
    key_spec: dict = spec["key"]
    pattern: object = spec["contains"]

    store = _open_store()
    key = _glob_one(store, key_spec["module"], key_spec["kind"], key_spec["path"])
    raw = store.get(key)
    doc = encoder.decode(raw)
    tree = doc.to_dict()

    assert contains_subtree(tree, pattern), (
        f"Pattern {pattern!r} not found in {key}.\nDescription: {description}"
    )
