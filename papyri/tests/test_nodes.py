from __future__ import annotations

from typing import Any

import pytest

from papyri.ts import parse

from ..nodes import (
    Directive,
    Section,
    Text,
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
def test_parse_blocks(target: str, type_: type[Any], at_least: int) -> None:
    sections = parse(dedent_but_first(get_object(target).__doc__).encode(), "test")
    filtered = [b for section in sections for b in section.children if type(b) == type_]
    assert len(filtered) >= at_least


def test_validate_rejects_unhandled_directive() -> None:
    # A terminal Directive (the unhandled fall-through) must fail validation so
    # gen fails fast — during per-object validate(), before write/pack — and the
    # message names the offending directive.
    sec = Section(
        children=[
            Directive(name="someunknown", args=None, options={}, value="x", children=[])
        ],
        title=(Text("Sec"),),
        level=1,
        target=None,
    )
    with pytest.raises(NotImplementedError, match="someunknown"):
        sec.validate()


def test_validate_tolerates_unprocessed_directive() -> None:
    # UnprocessedDirective is a pre-visit intermediate that the directive pass
    # replaces; validate() runs on trees that still contain it (e.g. extracted
    # parameters), so it must NOT be rejected here.
    sec = Section(
        children=[
            UnprocessedDirective(
                name="code", args="", options={}, value="x", children=[], raw=""
            )
        ],
        title=(Text("Sec"),),
        level=1,
        target=None,
    )
    sec.validate()
