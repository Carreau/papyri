"""
CBOR roundtrip tests for IR nodes.

Gen writes IR as CBOR; ingest reads it back; the viewer reads the ingest
store (also CBOR) with its own decoder. If ``encoder.encode`` / ``decode``
lose information, every downstream step is wrong.

These tests pin the bridge between the gen and render steps on the Python
side. The viewer has its own tests for the JavaScript decoder
(``viewer/tests/ir-reader-cbor.test.ts``); this file guarantees that the
Python encoder produces what that decoder expects.
"""

from __future__ import annotations

from papyri.nodes import (
    BulletList,
    Code,
    CrossRef,
    Emphasis,
    InlineCode,
    Link,
    ListItem,
    LocalRef,
    Paragraph,
    RefInfo,
    Section,
    Strong,
    Text,
    TocTree,
    encoder,
)


def _roundtrip(obj):
    return encoder.decode(encoder.encode(obj))


def test_roundtrip_text():
    t = Text("hello")
    assert _roundtrip(t) == t


def test_roundtrip_refinfo():
    r = RefInfo(module="numpy", version="2.3.5", kind="module", path="numpy:linspace")
    out = _roundtrip(r)
    assert out == r
    assert out.module == "numpy"
    assert out.path == "numpy:linspace"


def test_roundtrip_localref():
    lr = LocalRef("docs", "tutorial/intro")
    assert _roundtrip(lr) == lr


def test_roundtrip_crossref_with_localref():
    ref = CrossRef(
        "Intro",
        reference=LocalRef("docs", "intro"),
        kind="docs",
        anchor=None,
    )
    out = _roundtrip(ref)
    assert isinstance(out, CrossRef)
    assert out.value == "Intro"
    assert isinstance(out.reference, LocalRef)
    assert out.reference.kind == "docs"
    assert out.reference.path == "intro"


def test_roundtrip_crossref_with_refinfo():
    ri = RefInfo("numpy", "2.3.5", "module", "numpy:linspace")
    ref = CrossRef("linspace", reference=ri, kind="module", anchor=None)
    out = _roundtrip(ref)
    assert isinstance(out.reference, RefInfo)
    assert out.reference == ri


def test_roundtrip_paragraph_with_mixed_children():
    p = Paragraph(
        children=[
            Text("A "),
            Emphasis([Text("italic")]),
            Text(" and a "),
            Strong([Text("bold")]),
            Text(" and "),
            InlineCode("code"),
            Text(" word."),
        ],
    )
    out = _roundtrip(p)
    assert isinstance(out, Paragraph)
    assert len(out.children) == 7
    # Round-tripping preserves both the types and the text content.
    assert isinstance(out.children[1], Emphasis)
    assert isinstance(out.children[3], Strong)
    assert isinstance(out.children[5], InlineCode)


def test_roundtrip_code_block():
    c = Code(value="print('hi')\n", execution_status=None)
    out = _roundtrip(c)
    assert isinstance(out, Code)
    assert out.value == "print('hi')\n"


def test_roundtrip_link_preserves_url():
    link = Link(children=[Text("Python")], url="https://python.org/", title="home")
    out = _roundtrip(link)
    assert out.url == "https://python.org/"
    assert out.title == "home"
    assert out.children[0].value == "Python"


def test_roundtrip_bullet_list():
    bl = BulletList(
        ordered=False,
        start=1,
        spread=False,
        children=[
            ListItem(False, [Paragraph([Text("one")])]),
            ListItem(False, [Paragraph([Text("two")])]),
        ],
    )
    out = _roundtrip(bl)
    assert isinstance(out, BulletList)
    assert len(out.children) == 2
    assert out.ordered is False


def test_roundtrip_section_preserves_target():
    # Narrative section anchor (Phase 4 B): the target label is used as the
    # HTML id by the viewer. Dropping it in encode/decode breaks in-page
    # navigation.
    sec = Section(
        children=[Paragraph([Text("body")])],
        title="My Section",
        level=1,
        target="my-anchor",
    )
    out = _roundtrip(sec)
    assert isinstance(out, Section)
    assert out.title == "My Section"
    assert out.target == "my-anchor"
    assert out.level == 1


def test_roundtrip_toctree_nested():
    tt = TocTree(
        children=[
            TocTree(children=[], title="Chapter 1", ref=LocalRef("docs", "c1")),
            TocTree(children=[], title="Chapter 2", ref=LocalRef("docs", "c2")),
        ],
        title="Root",
        ref=LocalRef("docs", "index"),
    )
    out = _roundtrip(tt)
    assert isinstance(out, TocTree)
    assert out.title == "Root"
    assert len(out.children) == 2
    assert out.children[0].title == "Chapter 1"
    assert out.children[0].ref.path == "c1"


def test_encoder_decode_list_of_nodes():
    # Narrative docs are stored as a list of Section nodes; encode/decode a
    # list too, to cover the top-level container case.
    items = [
        Section([Paragraph([Text("a")])], "Sec A", 1, None),
        Section([Paragraph([Text("b")])], "Sec B", 1, None),
    ]
    out = _roundtrip(items)
    assert isinstance(out, list)
    assert len(out) == 2
    assert all(isinstance(s, Section) for s in out)
    assert [s.title for s in out] == ["Sec A", "Sec B"]


def test_encoder_is_byte_deterministic():
    # Encoding the same logical IR twice must produce identical bytes:
    # this is the property that makes CBOR files comparable across runs
    # (same source -> same hash). It relies on canonical=True in
    # Encoder.encode (RFC 8949 §4.2 sorts map keys).
    sec = Section(
        children=[Paragraph([Text("body")])],
        title="My Section",
        level=1,
        target="anchor",
    )
    assert encoder.encode(sec) == encoder.encode(sec)


def test_encoder_dict_key_order_does_not_affect_bytes():
    # A dict-typed Node field encoded with two different insertion orders
    # for the same key/value pairs must yield identical CBOR bytes.
    # We use a Directive's `options` field, which is `dict[str, str]`.
    from papyri.nodes import Directive

    d1 = Directive(
        name="role",
        args=None,
        options={"a": "1", "b": "2"},
        value=None,
        children=[],
    )
    d2 = Directive(
        name="role",
        args=None,
        options={"b": "2", "a": "1"},
        value=None,
        children=[],
    )
    assert encoder.encode(d1) == encoder.encode(d2)
