"""
Attempt at a multi-pass CST (concrete syntax tree) RST-ish parser.

This does not (and likely will not) support all of RST syntax, and may support
syntax that is not in the rst spec, mostly to support Python docstrings.

Goals
-----

The goal in here is to parse RST while keeping most of the original information
available in order to be able to _fix_ some of them with minimal of no changes
to the rest of the original input. This include but not limited to having
consistent header markers, and whether examples are (or not) indented with
respect to preceding paragraph.

The second goal is flexibility of parsing rules on a per-section basis;
Typically numpy doc strings have a different syntax depending on the section you
are in (Examples, vs Returns, vs Parameters), in what looks like; but is not;
definition list.

This also should be able to parse and give you a ast/cst without knowing ahead
of time the type of directive that are registered.

This will likely be used in the project in two forms, a lenient form that try to
guess as much as possible and suggest update to your style.

A strict form that avoid guessing and give you more, structured data.


Implementation
--------------

The implementation is not meant to be efficient but works in many multiple pass
that refine the structure of the document in order to potentially swapped out
for customisation.

Most of the high level split in sections and block is line-based via the
Line/lines objects that wrap a ``str``, but keep track of the original line
number and indent/dedent operations.


Junk Code
---------

There is possibly a lot of junk code in there due to multiple experiments.

Correctness
-----------

Yep, many things are probably wrong; or parsed incorrectly;

When possible if there is an alternative way in the source rst to change the
format, it's likely the way to go.

Unless your use case is widely adopted it is likely not worse the complexity
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from typing import Any

import cbor2

from . import signature  # noqa: F401 -- referenced in Root's forward-string annotation
from .node_base import REV_TAG_MAP, Node, UnserializableNode, register
from .serde import get_type_hints
from .utils import dedent_but_first

register(tuple)(4444)


@register(4003)
class InlineRole(Node):
    value: str
    domain: str | None
    role: str | None
    # Sphinx intersphinx `:external+<inv>:…:` prefix. When set, names the
    # inventory the (domain, role) lookup targets in another project; None for
    # ordinary same-project roles.
    inventory: str | None

    def __init__(self, value, domain, role, inventory=None):
        assert "\n" not in value, f"InlineRole should not contain newline {value}"
        super().__init__(value, domain, role, inventory)

    def __hash__(self):
        return hash((tuple(self.value), self.domain, self.role, self.inventory))

    def __eq__(self, other):
        return (
            (type(self) == type(other))
            and (self.role == other.role)
            and (other.domain == self.domain)
            and (self.inventory == other.inventory)
            and (self.value == other.value)
        )

    def __len__(self):
        return len(self.value) + len(self.prefix) + 2

    @property
    def prefix(self):
        prefix = ""
        if self.inventory:
            prefix += ":external+" + self.inventory
        if self.domain:
            prefix += ":" + self.domain
        if self.role:
            prefix += ":" + self.role + ":"
        return prefix

    def __repr__(self):
        return f"<InlineRole {self.prefix}`{self.value}` `{self.to_dict()}`>"

    def __str__(self):
        raise NotImplementedError


@register(4002)
class CrossRef(Node):
    """
    A cross-reference produced by the gen step and resolved by ingest.

    `reference.kind` carries the resolution state:

      - "to-resolve" — placeholder emitted by gen when a best-effort
        resolution wasn't possible; ingest's relink pass is expected to
        replace the reference.
      - "missing" — ingest attempted resolution and couldn't find a
        target; render-time should present as plain text.
      - anything else ("module", "local", "api", ...) — resolved.

    `exists` is a derived property over `reference.kind`; don't store it.
    """

    value: str
    reference: RefInfo
    # `kind` is a classification hint carried alongside the reference (e.g. the
    # directive role at the call site). It's not a redundant copy of
    # `reference.kind`; see tree.py's toctree handler for an example where the
    # two diverge.
    kind: str
    anchor: str | None = None

    @property
    def exists(self) -> bool:
        return self.reference is not None and self.reference.kind not in (
            "to-resolve",
            "missing",
        )

    def __repr__(self):
        return f"<CrossRef: {self.value=} {self.reference=} {self.kind=}>"

    def __hash__(self):
        return hash((self.value, self.reference, self.kind, self.anchor))


class Leaf(Node):
    value: str


@register(4027)
class SubstitutionDef(Node):
    value: str
    children: list[Directive | UnprocessedDirective]

    def __init__(self, value, children):
        self.value = value
        assert isinstance(children, list)
        self.children = children
        pass


@register(4041)
class SubstitutionRef(Leaf):
    """
    This will be in the for |XXX|, and need to be replaced.
    """

    value: str


@register(4018)
class Unimplemented(Node):
    placeholder: str
    value: str

    def __repr__(self):
        return f"<Unimplemented {self.placeholder!r} {self.value!r}>"


# ---- Document AST nodes -----------------------------------------------------
#
# Previously split into two modules; merged here to eliminate a circular
# import (PLAN.md Phase 2). The node vocabulary is loosely mdast-inspired
# for the inline/flow layer and RST/Sphinx-inspired for directives,
# admonitions, and field lists. The IR is papyri-specific: no external
# conformance target.


@register(4046)
class Text(Node):
    type = "text"
    value: str

    def __init__(self, value):
        assert isinstance(value, str)
        self.value = value
        super().__init__()


@register(4047)
class Emphasis(Node):
    type = "emphasis"
    children: list[PhrasingContent]


@register(4048)
class Strong(Node):
    type = "strong"
    children: list[PhrasingContent]


@register(4049)
class Link(Node):
    type = "link"
    children: list[StaticPhrasingContent]
    url: str
    title: str


@register(4050)
class Code(Node):
    type = "code"
    value: str


@register(4051)
class InlineCode(Node):
    type = "inlineCode"
    value: str

    def __init__(self, value):
        super().__init__(value)
        assert "\n" not in value


@register(4045)
class Paragraph(Node):
    type = "paragraph"
    children: list[PhrasingContent | UnimplementedInline]


@register(4053)
class BulletList(Node):
    type = "list"
    ordered: bool
    start: int
    spread: bool
    children: list[ListContent]


@register(4054)
class ListItem(Node):
    type = "listItem"
    spread: bool
    children: list[FlowContent | PhrasingContent | DefList | UnprocessedDirective]


@register(4052)
class Directive(Node):
    type = "directive"
    name: str
    args: str | None
    options: dict[str, str]
    value: str | None
    children: list[FlowContent | PhrasingContent | None] = []

    @classmethod
    def from_unprocessed(cls, up):
        return cls(up.name, up.args, up.options, up.value, up.children)


class UnprocessedDirective(UnserializableNode):
    """
    Placeholder for yet unprocessed directives, after they are parsed by
    tree-sitter but before they are dispatched through the role resolution.
    """

    name: str
    args: str | None
    options: dict[str, str]
    value: str | None
    children: list[FlowContent | PhrasingContent | None]
    raw: str


@register(4055)
class AdmonitionTitle(Node):
    type = "admonitionTitle"
    children: list[PhrasingContent | None] = []


@register(4056)
class Admonition(Node):
    type = "admonition"
    children: list[FlowContent | AdmonitionTitle | Unimplemented | DefList] = []
    kind: str = "note"


@register(4060)
class Comment(Node):
    type = "comment"
    value: str


@register(4058)
class Math(Node):
    type = "math"
    value: str


@register(4057)
class InlineMath(Node):
    type = "inlineMath"
    value: str


@register(4059)
class Blockquote(Node):
    type = "blockquote"
    children: list[FlowContent] = []


@register(4061)
class Target(Node):
    type = "target"
    label: str


@register(4062)
class Image(Node):
    type = "image"
    url: str
    alt: str


@register(4019)
class ThematicBreak(Node):
    type = "thematicBreak"


@register(4020)
class Heading(Node):
    type = "heading"
    depth: int
    children: list[PhrasingContent]


@register(4001)
class Root(Node):
    type = "root"
    children: list[
        FlowContent
        | Parameters
        | Unimplemented
        | SubstitutionDef
        | signature.SignatureNode
        | Image
    ]


@register(4017)
class UnimplementedInline(Node):
    children: list[Text]

    def __repr__(self):
        return f"<UnimplementedInline {self.children}>"


class IntermediateNode(Node):
    """
    This is just a dummy class for Intermediate node that should not make it to the final Product
    """

    pass


@register(4024)
class Figure(Node):
    value: RefInfo


@register(4000)
@dataclass(frozen=True)
class RefInfo(Node):
    """
    This is likely not completely correct for target that are not Python object,
    like example of gallery.

    We also likely want to keep a reference to original object for later updates.


    Parameters
    ----------
    module:
        the module this object is defined in
    version:
        the version of the module where this is defined in
    kind: {'api', 'example', ...}
        ...
    path:
        full path to location.


    """

    module: str | None
    version: str | None
    kind: str
    path: str

    def __post_init__(self):
        if self.module is not None:
            assert "." not in self.module, self.module

    def __iter__(self):
        assert isinstance(self.path, str)
        return iter([self.module, self.version, self.kind, self.path])

    @classmethod
    def from_untrusted(cls, module, version, kind, path):
        assert ":" not in module
        return cls(module, version, kind, path)


@register(4012)
class NumpydocExample(Node):
    value: list[str]
    title = "Examples"


@register(4013)
class NumpydocSeeAlso(Node):
    value: list[SeeAlsoItem]
    title = "See Also"


@register(4014)
class NumpydocSignature(Node):
    value: str
    title = "Signature"


@register(4015)
class Section(Node):
    children: list[
        DefList
        | FieldList
        | Figure
        | Admonition
        | Blockquote
        | Code
        | Comment
        | BulletList
        | Math
        | Directive
        | UnprocessedDirective
        | Paragraph
        | Target
        | Text
        | ThematicBreak
        | Options
        | Parameters
        | SubstitutionDef
        | SubstitutionRef
        | Unimplemented
        | UnimplementedInline
    ]
    # might need to be more complicated like verbatim.
    title: str | None
    level: int = 0
    target: str | None = None

    def __eq__(self, other):
        return super().__eq__(other)

    def __getitem__(self, k):
        return self.children[k]

    def __setitem__(self, k, v):
        self.children[k] = v

    def __iter__(self):
        return iter(self.children)

    def append(self, item):
        self.children.append(item)

    def extend(self, items):
        self.children.extend(items)

    def empty(self):
        return len(self.children) == 0

    def __bool__(self):
        return len(self.children) >= 0

    def __len__(self):
        return len(self.children)


@register(4026)
class Parameters(Node):
    children: list[DocParam]

    def validate(self):
        assert len(self.children) > 0
        return super().validate()


@register(4016)
class DocParam(Node):
    name: str
    annotation: str
    desc: list[
        Figure
        | DefListItem
        | DefList
        | Directive
        | UnprocessedDirective
        | Math
        | Admonition
        | Blockquote
        | BulletList
        | Paragraph
        | Code
        | SubstitutionDef
    ]

    @property
    def children(self):
        return self.desc

    @children.setter
    def children(self, values):
        self.desc = values

    def __getitem__(self, index):
        return [self.name, self.annotation, self.desc][index]

    def __repr__(self):
        return f"<{self.__class__.__name__}: {self.name=}, {self.annotation=}, {self.desc=}>"


class GenToken(UnserializableNode):
    value: str
    qa: str | None
    pygmentclass: str


class GenCode(UnserializableNode):
    """
    Gen-time bundle of syntax-highlighted code tokens and execution output.

    Emitted while scraping docstring examples, rewritten to Code by the
    gen visitor before anything reaches disk. Present in the IR only as
    an in-memory intermediate; serialization is asserted-unreachable.
    """

    entries: list[GenToken]
    out: str
    ce_status: str

    def validate(self):
        for x in self.entries:
            assert isinstance(x, GenToken)

        return super().validate()

    def _validate(self):
        for _ in self.entries:
            pass

    def __repr__(self):
        return f"<{self.__class__.__name__}: {self.entries=} {self.out=} {self.ce_status=}>"


def compress_word(stream) -> list[Any]:
    acc = []
    wds = ""
    assert isinstance(stream, list), stream
    for item in stream:
        if isinstance(item, Text):
            wds += item.value
        else:
            if type(item).__name__ == "Whitespace":
                acc.append(Text(item.value))
                wds = ""
            else:
                if wds:
                    acc.append(Text(wds))
                    wds = ""
                acc.append(item)
    if wds:
        acc.append(Text(wds))
    return acc


inline_nodes = tuple(
    [
        InlineRole,
        CrossRef,
        Link,
        SubstitutionRef,
    ]
)


@register(4021)
class TocTree(Node):
    children: list[TocTree]
    title: str
    ref: RefInfo
    open: bool = False
    current: bool = False


@register(4034)
class Options(Node):
    values: list[str]


@register(4035)
class FieldList(Node):
    children: list[FieldListItem]


@register(4036)
class FieldListItem(Node):
    name: list[Text | Code]
    body: list[Directive | Text | Paragraph | Code]

    def validate(self):
        for p in self.body:
            assert isinstance(p, Paragraph), p
        if self.name:
            assert len(self.name) == 1, (self.name, [type(n) for n in self.name])
        return super().validate()

    @property
    def children(self):
        return [*self.name, *self.body]

    @children.setter
    def children(self, value):
        x, *y = value
        self.name = [x]
        self.body = y


@register(4033)
class DefList(Node):
    children: list[DefListItem]


@register(4037)
class DefListItem(Node):
    dt: (
        Paragraph | Text | Link | UnimplementedInline
    )  # TODO: this is technically incorrect and should
    # be a single term, (word, directive or link is my guess).
    dd: list[
        Paragraph
        | Code
        | BulletList
        | Blockquote
        | DefList
        | Directive
        | UnprocessedDirective
        | Unimplemented
        | UnimplementedInline
        | Admonition
        | Math
        | FieldList
        | (TocTree | None)
    ]

    @property
    def children(self):
        return [self.dt, *self.dd]

    @children.setter
    def children(self, value):
        self.dt, *self.dd = value
        self.validate()


@register(4028)
class SeeAlsoItem(Node):
    name: CrossRef

    # TODO: check why we have a Union here, and if we have only Paragraphs, remove the union.
    descriptions: list[Paragraph]
    # there are a few case when the lhs is `:func:something`... in scipy.
    type: str | None

    @property
    def children(self):
        return [self.name, self.type, *self.descriptions]

    def __hash__(self):
        return hash((self.name, tuple(self.descriptions)))

    def __repr__(self):
        return (
            f"<{self.__class__.__name__}: {self.name} {self.type} {self.descriptions}>"
        )


def get_object(qual):
    parts = qual.split(".")

    for i in range(len(parts), 1, -1):
        mod_p, _ = parts[:i], parts[i:]
        mod_n = ".".join(mod_p)
        try:
            __import__(mod_n)
            break
        except Exception:
            continue

    obj = __import__(parts[0])
    for p in parts[1:]:
        obj = getattr(obj, p)
    return obj


def parse_rst_section(text, qa):
    """
    This should at some point be completely replaced by tree sitter.
    in particular `from ts import parse`
    """

    from .ts import parse

    items = parse(text.encode(), qa)
    if len(items) == 0:
        return []
    if len(items) == 1:
        [section] = items
        return section.children
    raise ValueError("Multiple sections present")


# ---- Union type aliases -----------------------------------------------------

type StaticPhrasingContent = (
    Text
    | InlineCode
    | InlineMath
    | InlineRole
    | CrossRef
    | SubstitutionRef
    | Unimplemented
)

type PhrasingContent = StaticPhrasingContent | Emphasis | Strong | Link

type FlowContent = (
    Code
    | Paragraph
    | UnprocessedDirective
    | Heading
    | ThematicBreak
    | Blockquote
    | BulletList
    | Target
    | Directive
    | Admonition
    | Math
    | DefList
    | DefListItem
    | FieldList
    | Comment
)

type ListContent = ListItem


class Encoder:
    def __init__(self, rev_map):
        self._rev_map = rev_map

    def encode(self, obj):
        return cbor2.dumps(obj, default=lambda encoder, obj: obj.cbor(encoder))

    def _type_from_tag(self, tag):
        return self._rev_map[tag.tag]

    def _tag_hook(self, decoder, tag, shareable_index=None):
        type_ = self._type_from_tag(tag)

        tt = get_type_hints(type_)
        kwds = {k: t for k, t in zip(tt, tag.value, strict=False)}
        return type_(**kwds)

    def decode(self, bytes):
        return cbor2.loads(bytes, tag_hook=self._tag_hook)

    def _available_tags(self):
        k = self._rev_map.keys()
        mi, ma = min(k), max(k)
        return set(range(mi, ma + 2)) - set(k)


encoder = Encoder(REV_TAG_MAP)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        what = sys.argv[1]
    else:
        what = "numpy"
    ex = get_object(what).__doc__
    ex = dedent_but_first(ex)
    doc = parse_rst_section(ex, "test")
    for b in doc:
        print(b)
