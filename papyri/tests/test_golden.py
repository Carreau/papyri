"""
Golden tests for RST content drawn from real-world library docstrings.

Each .rst file in papyri/tests/golden/ is processed through the same
ts.parse → GenVisitor pipeline used during ``papyri gen``, and the result
is compared byte-for-byte against the companion .json file.

The .json files pin the exact parse-tree output.  If a tree-sitter grammar
update or a visitor change alters the output, these tests catch it.

Regenerating expected files
---------------------------
After an *intentional* change, update all golden files in one shot::

    pytest papyri/tests/test_golden.py --update-goldens

Then review the diffs, commit both the .rst and the regenerated .json files.
"""

import json
from pathlib import Path

import pytest

from .utils import _process, _serialize

GOLDEN_DIR = Path(__file__).parent / "golden"
_RST_SAMPLES = sorted(GOLDEN_DIR.glob("*.rst"))


def _expected_path(sample: Path) -> Path:
    return sample.with_suffix(".json")


@pytest.fixture
def update_goldens(request: pytest.FixtureRequest) -> bool:
    return bool(request.config.getoption("--update-goldens"))


@pytest.mark.parametrize("sample", _RST_SAMPLES, ids=[s.stem for s in _RST_SAMPLES])
def test_golden(sample: Path, update_goldens: bool) -> None:
    expected_path = _expected_path(sample)
    actual = _serialize(_process(sample))

    if update_goldens:
        expected_path.write_bytes(actual)
        pytest.skip(f"Updated {expected_path.name}.")

    if not expected_path.exists():
        pytest.skip(
            f"{expected_path.name} not yet generated. "
            "Run: pytest papyri/tests/test_golden.py --update-goldens"
        )

    expected = expected_path.read_bytes()
    if actual != expected:
        # Use pytest's structured diff on the decoded objects.
        assert json.loads(actual) == json.loads(expected), (
            f"Golden output mismatch for {sample.name}"
        )
