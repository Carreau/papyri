import pytest

from papyri.ts import parse

from ..nodes import (
    UnprocessedDirective,
    dedent_but_first,
    get_object,
)


@pytest.mark.parametrize(
    "target, type_, number",
    [
        ("numpy", UnprocessedDirective, 0),
        pytest.param(
            "numpy.linspace",
            UnprocessedDirective,
            2,
            marks=pytest.mark.xfail(
                reason=(
                    "numpy.linspace docstring drifted: currently emits 1 "
                    "UnprocessedDirective instead of 2. Tracked in PLAN.md "
                    "Phase 2."
                ),
                strict=False,
            ),
        ),
    ],
)
def test_parse_blocks(target, type_, number):
    sections = parse(dedent_but_first(get_object(target).__doc__).encode(), "test")
    filtered = [b for section in sections for b in section.children if type(b) == type_]
    assert len(filtered) == number
