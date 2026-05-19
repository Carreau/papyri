"""``GeneratedDoc`` and the helpers that build / massage it.

Everything here is part of the IR contract that ``papyri gen`` writes
out. ``Gen`` (in ``gen.py``) drives the pipeline; this module
describes the data it produces.

Counterpart to ``IngestedDoc`` (in ``crosslink.py``), which is the
post-link form of the same shape.
"""

from __future__ import annotations

from typing import Any, ClassVar

from . import ts
from .node_base import Node, register
from .nodes import (
    Comment,
    CrossRef,
    DocParam,
    Paragraph,
    Parameters,
    RefInfo,
    Section,
    SeeAlsoItem,
    Text,
    parse_rst_section,
)
from .signature import SignatureNode


def paragraph(lines: list[str], qa) -> Any:
    """
    Leftover rst parsing,

    Remove at some point.
    """
    [section] = ts.parse("\n".join(lines).encode(), qa)
    assert len(section.children) == 1
    p2 = section.children[0]
    return p2


class _OrderedDictProxy:
    """
    a dict like class proxy for GeneratedDoc to keep the order of sections in GeneratedDoc.

    We Can't use an ordered Dict because of serialisation/deserialisation that
    would/might loose order
    """

    orderring: list[str]
    mapping: dict[str, Any]

    def __init__(self, ordering: list[str], mapping: dict[str, Any]):
        # cbor2 6.x may hand us a tuple (immutable mode) where we expect a
        # list; normalise so mutating ops still work.
        if isinstance(ordering, tuple):
            ordering = list(ordering)
        self.ordering = ordering
        self.mapping = mapping
        assert isinstance(ordering, list), ordering
        assert isinstance(mapping, dict), mapping
        assert set(self.mapping.keys()) == set(self.ordering)

    def __getitem__(self, key: str):
        return self.mapping[key]

    def __contains__(self, key: str):
        return key in self.mapping

    def __setitem__(self, key: str, value: Any):
        if key not in self.ordering:
            self.ordering.append(key)
        self.mapping[key] = value

    def __delitem__(self, key: str):
        self.ordering.remove(key)
        del self.mapping[key]

    def __iter__(self):
        return iter(self.ordering)

    def keys(self) -> tuple[str, ...]:
        return tuple(self.ordering)

    def get(self, key: str, default=None, /):
        return self.mapping.get(key, default)

    def items(self):
        return [(k, self.mapping[k]) for k in self.ordering]

    def values(self):
        return [self.mapping[k] for k in self.ordering]


@register(4011)
class GeneratedDoc(Node):
    """
    An object containing information about the documentation of an arbitrary
    object.

    Instead of GeneratedDoc being a NumpyDocString, I'm thinking of them having a
    NumpyDocString. This helps with arbitrary documents (module, examples files)
    that cannot be parsed by Numpydoc, as well as links to external references,
    like images generated.

    """

    __slots__ = (
        "_content",
        "_dp",
        "_ordered_sections",
        "aliases",
        "arbitrary",
        "example_section_data",
        "item_file",
        "item_line",
        "item_type",
        "local_refs",
        "references",
        "see_also",
        "signature",
    )

    @classmethod
    def _deserialise(cls, **kwargs):
        try:
            instance = cls(**kwargs)
        except Exception as e:
            raise type(e)(f"Error deserialising {cls}, {kwargs})") from e
        for k, v in kwargs.items():
            setattr(instance, k, v)
        return instance

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        assert not isinstance(self._content, str)
        self._dp = _OrderedDictProxy(self._ordered_sections, self._content)  # type: ignore[arg-type]

    @property
    def ordered_sections(self):
        return tuple(self._ordered_sections)  # type: ignore[arg-type]

    @property
    def content(self):
        return self._dp

    sections: ClassVar[list[str]] = [
        "Signature",
        "Summary",
        "Extended Summary",
        "Parameters",
        "Returns",
        "Yields",
        "Receives",
        "Raises",
        "Warns",
        "Other Parameters",
        "Attributes",
        "Methods",
        "See Also",
        "Notes",
        "Warnings",
        "References",
        "Examples",
    ]  # List of sections in order

    _content: dict[str, Section]
    example_section_data: Section
    _ordered_sections: list[str] | None
    item_file: str | None
    item_line: int | None
    item_type: str | None
    aliases: list[str]
    see_also: list[SeeAlsoItem]  # see also data
    signature: SignatureNode | None
    references: list[str] | None
    arbitrary: list[Section]
    local_refs: list[str]

    def __repr__(self):
        return "<GeneratedDoc ...>"

    def slots(self):
        # Order tracks the class declaration above (which is what
        # `Node.cbor()` uses via `get_type_hints`); only the field names
        # matter for the attribute-by-attribute copy that ingest readers
        # do, but matching the declaration order keeps readers out of a
        # trap.
        return [
            "_content",
            "example_section_data",
            "_ordered_sections",
            "item_file",
            "item_line",
            "item_type",
            "aliases",
            "see_also",
            "signature",
            "references",
            "arbitrary",
            "local_refs",
        ]

    @classmethod
    def new(cls):
        return cls({}, None, [], None, None, None, [], [], None, None, [], [])


def _numpy_data_to_section(data: list[tuple[str, str, list[str]]], title: str, qa):
    assert isinstance(data, list), repr(data)
    acc = []
    for param, type_, desc in data:
        assert isinstance(desc, list)
        items = []
        if desc:
            items = parse_rst_section("\n".join(desc), qa)
            for l in items:
                assert not isinstance(l, Section)
        acc.append(DocParam(param, type_, desc=items).validate())
    if acc:
        return Section([Parameters(acc)], title).validate()
    else:
        return Section([], title)


def _normalize_see_also(see_also: Section, qa: str):
    """
    numpydoc is complex, the See Also fields can be quite complicated,
    so here we sort of try to normalise them.
    from what I can remember,
    See also can have
    name1 : type1
    name2 : type2
        description for both name1 and name 2.

    Though if description is empty, them the type is actually the description.
    """
    if not see_also:
        return []
    assert see_also is not None
    new_see_also = []
    name_and_types: list[tuple[str, str]]
    name: str
    type_or_description: str

    for name_and_types, raw_description in see_also:
        try:
            for name, type_or_description in name_and_types:
                if type_or_description and not raw_description:
                    assert isinstance(type_or_description, str)
                    type_ = None
                    # we have all in a single line,
                    # and there is no description, so the type field is
                    # actually the description.
                    desc = [paragraph([type_or_description], qa)]
                elif raw_description:
                    assert isinstance(raw_description, list)
                    type_ = type_or_description
                    parsed = paragraph(raw_description, qa)
                    # RST `..` with no content parses as a Comment; drop it
                    desc = [] if isinstance(parsed, Comment) else [parsed]
                else:
                    type_ = type_or_description
                    desc = []
                refinfo = RefInfo.from_untrusted(
                    "current-module", "current-version", "to-resolve", name
                )
                # `exists` is derived from `refinfo.kind`; the "to-resolve" kind
                # flags this as a placeholder for the ingest relink pass.
                link = CrossRef(name, refinfo, "module")
                sai = SeeAlsoItem(link, desc, type_)
                new_see_also.append(sai)
                del desc
                del type_
        except Exception as e:
            raise ValueError(
                f"Error {qa}: {see_also=} | {name_and_types=}  | {raw_description=}"
            ) from e
    return new_see_also


def _flatten_text(node: Any, out: list[str]) -> None:
    if isinstance(node, Text):
        out.append(node.value)
        return
    children = getattr(node, "children", None)
    if children is None:
        return
    for child in children:
        _flatten_text(child, out)


def _first_paragraph_text(section: Section) -> str | None:
    """Return the plain-text content of the first Paragraph in ``section``."""
    for child in section.children:
        if isinstance(child, Paragraph):
            parts: list[str] = []
            _flatten_text(child, parts)
            text = "".join(parts).strip()
            if text:
                return text
    return None
