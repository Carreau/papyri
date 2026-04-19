import pytest

from papyri.ts import parse

from ..nodes import (
    UnprocessedDirective,
    dedent_but_first,
    get_object,
)


@pytest.mark.parametrize(
    "target, type_, at_least",
    [
        ("numpy", UnprocessedDirective, 0),
        # Count isn't pinned to numpy's upstream docstring: it drifts as numpy
        # revises docs. We only want to know the parser catches directives.
        ("numpy.linspace", UnprocessedDirective, 1),
    ],
)
def test_parse_blocks(target, type_, at_least):
    sections = parse(dedent_but_first(get_object(target).__doc__).encode(), "test")
    filtered = [b for section in sections for b in section.children if type(b) == type_]
    assert len(filtered) >= at_least
