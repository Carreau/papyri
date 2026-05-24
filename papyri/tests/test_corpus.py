from typing import Any

import pytest

from .utils import SAMPLES, _expected_path, _process, _serialize

PAIRS = [(s, _expected_path(s)) for s in SAMPLES]


@pytest.mark.parametrize("sample, expected", PAIRS)
def test_corpus(sample: Any, expected: Any) -> None:
    processed = _process(sample)
    exported = _serialize(processed)

    assert expected.read_bytes() == exported
