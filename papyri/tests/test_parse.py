from textwrap import dedent
from typing import Any, cast

import pytest

from papyri import errors
from papyri.nodes import CitationReference, InlineCode, InlineRole, Paragraph, Text
from papyri.ts import Node, TSVisitor, parse, parser


# @pytest.mark.xfail(strict=True)
def test_parse_space_in_directive_section():
    data = dedent("""

    .. directive ::

        this type of directive is supported by docutils but
        should raise/warn in papyri.
        It may depends on the tree-sitter rst version.

    """)
    with pytest.raises(errors.SpaceAfterBlockDirectiveError):
        parse(data.encode(), "test_parse_space_in_directive_section")


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
    assert len(section.children) > 0
    first_child = section.children[0]
    assert isinstance(first_child, Paragraph)
    assert len(first_child.children) > 0
    text_node = first_child.children[0]
    assert hasattr(text_node, "value")
    text_node_with_value = cast(Any, text_node)
    assert (
        text_node_with_value.value
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
    first_child = section.children[0]
    assert isinstance(first_child, Paragraph)
    _text0, directive, _text1, reference, _text2 = first_child.children
    assert "\n" not in directive.value  # type: ignore[union-attr]
    assert directive.value == "this interpreted_text"  # type: ignore[union-attr]
    assert "\n" not in reference.value  # type: ignore[union-attr]
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

    para_node = section.children[0]
    assert isinstance(para_node, Paragraph)
    para_children = para_node.children
    for node in para_children:
        if isinstance(node, InlineRole):
            assert "`" not in node.value


def test_backtick_trailing_alpha_no_role():
    """`:class:`True`s` — if tree-sitter produces a role, value must be uncontaminated."""
    data = b"Pass :class:`True`s to enable."
    [section] = parse(data, "test_backtick_trailing_alpha_no_role")

    para_node = section.children[0]
    assert isinstance(para_node, Paragraph)
    para_children = para_node.children
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


def _flatten_text(paragraph: Paragraph) -> str:
    """Concatenate the .value of every Text-bearing leaf in a paragraph."""
    parts: list[str] = []
    stack: list = list(paragraph.children)
    while stack:
        node = stack.pop(0)
        value = getattr(node, "value", None)
        if isinstance(value, str):
            parts.append(value)
        elif hasattr(node, "children"):
            stack[:0] = list(node.children or [])
    return "".join(parts)


@pytest.mark.xfail(
    strict=False,
    reason="tree-sitter-rst does not currently process backslash escapes; "
    "may require an upstream fix.",
)
def test_parse_escaped_backtick_in_text():
    """
    Per RST spec, ``\\`` inside a paragraph is an escape: the backslash should be
    consumed and a literal backtick should appear in the resulting text. The
    current tree-sitter-rst grammar leaves both the backslash and the backtick
    in place as separate text fragments.
    """
    data = b"Use \\` for backticks."
    [section] = parse(data, "test_parse_escaped_backtick_in_text")
    [paragraph] = section.children
    assert isinstance(paragraph, Paragraph)
    assert all(isinstance(c, Text) for c in paragraph.children), paragraph.children
    text = _flatten_text(paragraph)
    assert "\\" not in text, text
    assert text == "Use ` for backticks."


@pytest.mark.xfail(
    strict=False,
    reason="tree-sitter-rst does not currently process backslash escapes; "
    "may require an upstream fix.",
)
def test_parse_multiple_escaped_backticks_in_text():
    """
    Multiple ``\\``` escapes in a single paragraph should each yield a literal
    backtick in the text, with no backslashes left behind.
    """
    data = b"Foo \\` bar \\` baz."
    [section] = parse(data, "test_parse_multiple_escaped_backticks_in_text")
    [paragraph] = section.children
    assert isinstance(paragraph, Paragraph)
    assert all(isinstance(c, Text) for c in paragraph.children), paragraph.children
    text = _flatten_text(paragraph)
    assert "\\" not in text, text
    assert text == "Foo ` bar ` baz."


@pytest.mark.xfail(
    strict=False,
    reason="tree-sitter-rst does not currently process backslash escapes; "
    "may require an upstream fix.",
)
def test_parse_escaped_backtick_in_interpreted_text():
    """
    Inside interpreted text ``\\``` should embed a literal backtick into the
    role's value without prematurely terminating the interpreted-text span.
    """
    data = b"Some `with \\` backtick` text."
    [section] = parse(data, "test_parse_escaped_backtick_in_interpreted_text")
    [paragraph] = section.children
    assert isinstance(paragraph, Paragraph)
    roles = [c for c in paragraph.children if isinstance(c, InlineRole)]
    assert len(roles) == 1, paragraph.children
    assert "\\" not in roles[0].value, roles[0].value
    assert roles[0].value == "with ` backtick", roles[0].value


@pytest.mark.xfail(
    strict=False,
    reason="tree-sitter-rst does not currently process backslash escapes; "
    "may require an upstream fix.",
)
def test_parse_escaped_backtick_in_inline_literal():
    """
    A backslash-escaped backtick inside an inline literal ``\\````\\``` should
    produce an ``InlineCode`` whose value contains a single literal backtick
    (no backslash). This is the "literal nodes with the (non-escaped)
    backticks" case from the issue description.
    """
    data = b"Code ``with \\` literal`` here."
    [section] = parse(data, "test_parse_escaped_backtick_in_inline_literal")
    [paragraph] = section.children
    assert isinstance(paragraph, Paragraph)
    literals = [c for c in paragraph.children if isinstance(c, InlineCode)]
    assert len(literals) == 1, paragraph.children
    assert "\\" not in literals[0].value, literals[0].value
    assert literals[0].value == "with ` literal", literals[0].value


def test_parse_reference():
    [section] = parse(b"This is a `reference <to this>`_", "test_parse_reference")
    [paragraph_node] = section.children
    assert isinstance(paragraph_node, Paragraph)
    [text, reference] = paragraph_node.children
    assert reference.value == "reference <to this>"  # type: ignore[union-attr]
    assert text.value == "This is a "  # type: ignore[union-attr]


def test_parse_citation_reference():
    """
    Inline citation references like ``[CIT2002]_`` should parse as a
    CitationReference node carrying both label and content.
    """

    [section] = parse(
        b"See [CIT2002]_ for more details.", "test_parse_citation_reference"
    )
    [paragraph_node] = section.children
    assert isinstance(paragraph_node, Paragraph)
    cites = [c for c in paragraph_node.children if isinstance(c, CitationReference)]
    assert len(cites) == 1, (
        f"expected one CitationReference among {paragraph_node.children!r}"
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
    [paragraph_node] = section.children
    assert isinstance(paragraph_node, Paragraph)
    cites = [c for c in paragraph_node.children if isinstance(c, CitationReference)]
    assert [c.label for c in cites] == ["Smith2020", "Jones1999"]


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
    shared IR encoder, confirming CBOR tag 4063 is wired in.
    """
    from papyri.nodes import CitationReference, encoder

    original = CitationReference(label="CIT2002")
    decoded = encoder.decode(encoder.encode(original))
    assert isinstance(decoded, CitationReference)
    assert decoded.label == "CIT2002"


def test_parse_citation_block():
    """
    Block-level ``.. [label] body`` citation definitions should parse as
    Citation nodes carrying a label and a body Paragraph.
    """
    from papyri.nodes import Citation

    sections = parse(
        b".. [CIT2002] Book title, Author, Year.\n",
        "test_parse_citation_block",
    )
    citations = []
    stack: list = list(sections)
    while stack:
        node = stack.pop()
        if isinstance(node, Citation):
            citations.append(node)
        elif hasattr(node, "children"):
            stack.extend(node.children or [])

    assert len(citations) == 1, f"expected one Citation, got {citations!r}"
    assert citations[0].label == "CIT2002"
    assert citations[0].children[0].children[0].value == "Book title, Author, Year."  # type: ignore[union-attr]


def test_citation_roundtrip():
    """
    Citation block node should survive a CBOR encode/decode roundtrip
    via the shared IR encoder, confirming tag 4064 is wired in.
    """
    from papyri.nodes import Citation, Paragraph, Text, encoder

    original = Citation(label="CIT2002", children=[Paragraph([Text("Some ref.")])])
    decoded = encoder.decode(encoder.encode(original))
    assert isinstance(decoded, Citation)
    assert decoded.label == "CIT2002"
    assert decoded.children[0].children[0].value == "Some ref."  # type: ignore[union-attr]


@pytest.mark.parametrize(
    "role",
    ["class", "func", "meth", "method", "obj", "attr", "any", "mod", "data", "exc"],
)
def test_inline_role_resolves_to_crossref(role):
    """
    Explicit Python-domain reference roles (`:class:`, `:func:`, ...) must
    produce a ``CrossRef`` when the target is in ``known_refs``. Regression
    test: they used to short-circuit to verbatim ``InlineCode`` and never
    crosslink.
    """
    from papyri.nodes import CrossRef, InlineRole, RefInfo
    from papyri.tree import DirectiveVisiter

    target = RefInfo("numpy", "1.0", "api", "numpy.ndarray")
    visitor = DirectiveVisiter(
        "numpy.cos",
        frozenset({target}),
        frozenset(),
        {},
        "1.0",
        module="numpy",
    )
    out = visitor.replace_InlineRole(
        InlineRole("numpy.ndarray", domain=None, role=role)
    )
    assert len(out) == 1
    assert isinstance(out[0], CrossRef), (role, out)
    assert out[0].reference == target, (role, out)


@pytest.mark.parametrize(
    "role",
    ["kbd", "sub", "sup", "term", "samp", "program", "file", "keyword"],
)
def test_inline_role_formatting_stays_verbatim(role):
    """
    Formatting-only roles (`:kbd:`, `:sub:`, ...) are not cross-references;
    they should continue to render as verbatim ``InlineCode``.
    """
    from papyri.nodes import InlineCode, InlineRole, RefInfo
    from papyri.tree import DirectiveVisiter

    target = RefInfo("numpy", "1.0", "api", "Ctrl")
    visitor = DirectiveVisiter(
        "numpy.cos",
        frozenset({target}),
        frozenset(),
        {},
        "1.0",
        module="numpy",
    )
    out = visitor.replace_InlineRole(InlineRole("Ctrl", domain=None, role=role))
    assert len(out) == 1
    assert isinstance(out[0], InlineCode), (role, out)


def test_inline_role_unresolved_falls_back_to_inline_role():
    """
    When a cross-reference role can't be resolved (target not in ``known_refs``
    and not importable), the original ``InlineRole`` is preserved so the
    viewer can still display it as styled code.
    """
    from papyri.nodes import InlineRole
    from papyri.tree import DirectiveVisiter

    visitor = DirectiveVisiter(
        "numpy.cos",
        frozenset(),
        frozenset(),
        {},
        "1.0",
        module="numpy",
    )
    directive = InlineRole("not.a.real.symbol", domain=None, role="class")
    out = visitor.replace_InlineRole(directive)
    assert len(out) == 1
    assert isinstance(out[0], InlineRole)
    assert out[0].role == "class"
    assert out[0].value == "not.a.real.symbol"


@pytest.mark.parametrize(
    "role",
    ["class", "func", "meth", "any", None],
)
def test_tilde_prefix_sets_short_display_text(role):
    """
    A tilde-prefixed reference like ``~numpy.char.chararray`` must resolve to a
    ``CrossRef`` whose ``value`` is only the last dotted component (``chararray``),
    while ``reference.path`` keeps the full qualified name.
    """
    from papyri.nodes import CrossRef, InlineRole, RefInfo
    from papyri.tree import DirectiveVisiter

    target = RefInfo("numpy", "1.0", "api", "numpy.char.chararray")
    visitor = DirectiveVisiter(
        "numpy.cos",
        frozenset({target}),
        frozenset(),
        {},
        "1.0",
        module="numpy",
    )
    out = visitor.replace_InlineRole(
        InlineRole("~numpy.char.chararray", domain=None, role=role)
    )
    assert len(out) == 1, (role, out)
    assert isinstance(out[0], CrossRef), (role, out)
    assert out[0].value == "chararray", (role, out)
    assert out[0].reference == target, (role, out)


@pytest.mark.parametrize(
    "role",
    ["class", "func", "meth", "any", None],
)
def test_tilde_prefix_explicit_text_unchanged(role):
    """
    When explicit display text is given with a tilde target, e.g.
    ``mytext <~numpy.char.chararray>``, the explicit text must be preserved.
    """
    from papyri.nodes import CrossRef, InlineRole, RefInfo
    from papyri.tree import DirectiveVisiter

    target = RefInfo("numpy", "1.0", "api", "numpy.char.chararray")
    visitor = DirectiveVisiter(
        "numpy.cos",
        frozenset({target}),
        frozenset(),
        {},
        "1.0",
        module="numpy",
    )
    out = visitor.replace_InlineRole(
        InlineRole("mytext <~numpy.char.chararray>", domain=None, role=role)
    )
    assert len(out) == 1, (role, out)
    assert isinstance(out[0], CrossRef), (role, out)
    assert out[0].value == "mytext", (role, out)
    assert out[0].reference == target, (role, out)


@pytest.mark.parametrize(
    "role",
    ["class", "func", "meth", "any", None],
)
def test_directive_visiter_inline_role_resolves(role):
    """
    ``DirectiveVisiter.replace_InlineRole`` must produce a ``CrossRef`` when
    the target is in ``known_refs``.

    Regression: the method was a no-op stub that returned the original
    ``InlineRole`` unchanged, so cross-links to other packages (e.g.
    ``numpy.sin``) in module-level docstrings were never wired up.
    """
    from papyri.nodes import CrossRef, InlineRole, RefInfo
    from papyri.tree import DirectiveVisiter

    target = RefInfo("numpy", "1.0", "api", "numpy.sin")
    visitor = DirectiveVisiter(
        "papyri.examples",
        frozenset({target}),
        frozenset(),
        {},
        version="0.0.8",
        module="papyri",
    )
    out = visitor.replace_InlineRole(InlineRole("numpy.sin", domain=None, role=role))
    assert len(out) == 1, (role, out)
    assert isinstance(out[0], CrossRef), (role, out)
    assert out[0].reference == target, (role, out)


def test_resolve_colon_notation_path_via_dot_notation():
    """
    Regression: API objects are stored with colon-notation paths by full_qual()
    (e.g. "numpy:sin"), but RST inline roles produce dot-notation references
    (e.g. ":func:`numpy.sin`" → "numpy.sin").  _build_resolver_cache must index
    both so that the dot-notation lookup finds the colon-notation RefInfo.

    Without the fix, resolve_() returns "missing" for "numpy.sin" even when
    known_refs contains RefInfo(path="numpy:sin").
    """
    from papyri.nodes import CrossRef, InlineRole, RefInfo
    from papyri.tree import DirectiveVisiter

    # Mirrors what a populated graph store produces: kind="module", colon path.
    target = RefInfo("numpy", "1.26", "module", "numpy:sin")
    visitor = DirectiveVisiter(
        "papyri.examples",
        frozenset({target}),
        frozenset(),
        {},
        version="0.0.9",
        module="papyri",
    )
    out = visitor.replace_InlineRole(InlineRole("numpy.sin", domain=None, role="func"))
    assert len(out) == 1, out
    assert isinstance(out[0], CrossRef), out
    # The CrossRef must point at the real versioned RefInfo, not a "*" stub.
    assert out[0].reference == target, out[0].reference


@pytest.mark.parametrize(
    "kind", ["note", "warning", "deprecated", "versionadded", "versionchanged"]
)
def test_admonition_helper_children_is_list(kind):
    """Admonition children must be a list, not a dataclasses.Field sentinel.

    Regression: admonition_helper passed children as the first positional arg
    but Admonition has `kind` as the first annotation, so children was never
    set on the instance and fell back to the class-level Field object.
    """
    import dataclasses

    from papyri.directives import admonition_helper

    result = admonition_helper(kind, None, {}, None)
    assert len(result) == 1
    admonition = result[0]
    assert not isinstance(admonition.children, dataclasses.Field), (
        f"Admonition.children is a Field sentinel: {admonition.children!r}"
    )
    assert isinstance(admonition.children, list)
