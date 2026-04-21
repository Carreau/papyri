from textwrap import dedent

import pytest

from papyri import errors
from papyri.nodes import InlineRole
from papyri.ts import Node, TSVisitor, parse, parser


# @pytest.mark.xfail(strict=True)
def test_parse_space_in_directive_section():
    data = dedent("""

    .. directive ::

        this type of directive is supported by docutils but
        should raise/warn in papyri.
        It may depends on the tree-sitter rst version.

    """)
    pytest.raises(
        errors.SpaceAfterBlockDirectiveError,
        parse,
        data.encode(),
        "test_parse_space_in_directive_section",
    )


def test_parse_directive_body():
    data1 = dedent("""

    .. directive:: Directive title

        This directive declares a title and content in a block separated from
        the definition by an empty new line.

    """)
    data2 = dedent("""

    .. directive:: Directive title
        This directive declares a title and content not separated by an empty
        newline.

    """)

    text1 = data1.strip("\n").encode()
    text2 = data2.strip("\n").encode()

    tree1 = parser.parse(text1)
    tree2 = parser.parse(text2)

    directive1 = Node(tree1.root_node).without_whitespace()
    directive2 = Node(tree2.root_node).without_whitespace()

    tsv1 = TSVisitor(text1, "test_parse_directive_body")
    tsv2 = TSVisitor(text2, "test_parse_directive_body")

    items1 = tsv1.visit(directive1)
    items2 = tsv2.visit(directive2)

    assert items1[0].name == "directive"
    assert items1[0].args == "Directive title"
    assert items1[0].options == dict()
    assert (
        items1[0].value
        == "This directive declares a title and content in a block separated from\nthe definition by an empty new line."
    )
    assert (
        " ".join([i.value for i in items1[0].children])
        == "This directive declares a title and content in a block separated from the definition by an empty new line."
    )

    assert items2[0].name == "directive"
    assert items2[0].args == "Directive title"
    assert items2[0].options == dict()
    assert (
        items2[0].value
        == "This directive declares a title and content not separated by an empty\nnewline."
    )
    assert (
        " ".join([i.value for i in items2[0].children])
        == "This directive declares a title and content not separated by an empty newline."
    )


def test_parse_warning_directive():
    data = dedent("""

    .. warning:: Title

        The warning directive does not admit a title.
        Just testing now.

    """)
    text = data.strip("\n").encode()
    tree = parser.parse(text)
    directive = Node(tree.root_node)
    tsv = TSVisitor(text, "test_parse_directive_body")
    new_node = directive.without_whitespace()
    items = tsv.visit(new_node)

    assert items[0].name == "warning"
    assert items[0].args == ""
    assert items[0].options == dict()
    assert (
        items[0].value
        == "Title The warning directive does not admit a title.\nJust testing now."
    )
    assert items[0].children == []


def test_parse_space():
    [section] = parse(
        b"Element-wise maximum of two arrays, propagating any NaNs.",
        "test_parse_space",
    )
    assert (
        section.children[0].children[0].value  # type: ignore[union-attr]
        == "Element-wise maximum of two arrays, propagating any NaNs."
    )


def test_parse_no_newline():
    """
    Here we test that sections of test that contain new line in the source do
    not have new line in the output. This make it simpler to render on output
    that respect newlines
    """
    data = dedent("""
    we want to make sure that `this
    interpreted_text` not have a newline in it and that `this
    reference`_ does not either.""").encode()

    [section] = parse(data, "test_parse_space")
    text0, directive, text1, reference, text2 = section.children[0].children  # type: ignore[union-attr]
    assert "\n" not in directive.value  # type: ignore
    assert directive.value == "this interpreted_text"  # type: ignore[union-attr]
    assert "\n" not in reference.value  # type: ignore
    assert reference.value == "this reference"  # type: ignore[union-attr]


def test_backtick_trailing_alpha_suffix():
    """
    "`None`s" is invalid RST (alphanumeric char after closing backtick),
    but common in scipy/numpy docstrings.

    Tree-sitter may handle the split natively or fold multiple backtick
    patterns into one node; either way no InlineRole value may contain a
    stray backtick.
    """
    data = b"Returns `None`s or `ndarray`s depending on input."
    [section] = parse(data, "test_backtick_trailing_alpha_suffix")

    para_children = section.children[0].children  # type: ignore[union-attr]
    for node in para_children:
        if isinstance(node, InlineRole):
            assert "`" not in node.value


def test_backtick_trailing_alpha_no_role():
    """`:class:`True`s` — if tree-sitter produces a role, value must be uncontaminated."""
    data = b"Pass :class:`True`s to enable."
    [section] = parse(data, "test_backtick_trailing_alpha_no_role")

    para_children = section.children[0].children  # type: ignore[union-attr]
    # tree-sitter may or may not recognise :class:`True`s as a roled node
    # (the trailing `s` can prevent role recognition); either outcome is
    # acceptable, but if a role IS produced its value must not contain a backtick.
    class_roles = [
        c for c in para_children if isinstance(c, InlineRole) and c.role == "class"
    ]
    for r in class_roles:
        assert "`" not in r.value


def test_backtick_genuine_stray_backtick():
    """
    A genuinely malformed sequence (stray inner backtick, not just a trailing
    suffix) should fall through to the corruption-prevention path without raising.
    """
    data = b"See `x`=``data`` for details."
    parse(data, "test_backtick_genuine_stray_backtick")


def test_parse_reference():
    [section] = parse(b"This is a `reference <to this>`_", "test_parse_reference")
    [paragraph] = section.children
    [text, reference] = paragraph.children  # type: ignore[union-attr]
    assert reference.value == "reference <to this>"  # type: ignore[union-attr]
    assert text.value == "This is a "  # type: ignore[union-attr]


def test_parse_citation_reference():
    """
    Inline citation references like ``[CIT2002]_`` used to raise
    VisitCitationReferenceNotImplementedError. They should now parse as
    a CitationReference node carrying just the label.
    """
    from papyri.nodes import CitationReference

    [section] = parse(
        b"See [CIT2002]_ for more details.", "test_parse_citation_reference"
    )
    [paragraph] = section.children
    cites = [c for c in paragraph.children if isinstance(c, CitationReference)]  # type: ignore[union-attr]
    assert len(cites) == 1, (
        f"expected one CitationReference among {paragraph.children!r}"  # type: ignore[union-attr]
    )
    assert cites[0].label == "CIT2002"


def test_parse_citation_reference_does_not_raise():
    """
    Regression test: parsing a citation reference must not raise
    VisitCitationReferenceNotImplementedError.
    """
    # Should not raise.
    parse(b"See [CIT2002]_ for more.", "test_parse_citation_reference_does_not_raise")


def test_parse_citation_reference_multiple():
    """
    Multiple citation references in the same paragraph should each produce
    a CitationReference with the correct label.
    """
    from papyri.nodes import CitationReference

    [section] = parse(
        b"Compare [Smith2020]_ and [Jones1999]_ here.",
        "test_parse_citation_reference_multiple",
    )
    [paragraph] = section.children
    labels = [c.label for c in paragraph.children if isinstance(c, CitationReference)]  # type: ignore[union-attr]
    assert labels == ["Smith2020", "Jones1999"]


def test_parse_example_with_citations_docstring():
    """
    Parse the example_with_citations docstring end-to-end to lock in that
    the citation references inside a real-shaped numpydoc docstring produce
    CitationReference leaves rather than raising.
    """
    from papyri.examples import example_with_citations
    from papyri.nodes import CitationReference

    assert example_with_citations.__doc__ is not None
    sections = parse(
        dedent(example_with_citations.__doc__).encode(),
        "papyri.examples:example_with_citations",
    )

    # Walk the tree and collect every CitationReference label.
    found: list[str] = []
    stack: list = list(sections)
    while stack:
        node = stack.pop()
        if isinstance(node, CitationReference):
            found.append(node.label)
        elif hasattr(node, "children"):
            stack.extend(node.children or [])

    assert set(found) >= {"CIT2002", "Nielsen2020", "Smith2020", "Jones1999"}, found


def test_citation_reference_roundtrip():
    """
    CitationReference should survive a CBOR encode/decode roundtrip via the
    shared IR encoder, confirming the new CBOR tag (4063) is wired in.
    """
    from papyri.nodes import CitationReference, encoder

    original = CitationReference(label="CIT2002")
    decoded = encoder.decode(encoder.encode(original))
    assert isinstance(decoded, CitationReference)
    assert decoded.label == "CIT2002"
