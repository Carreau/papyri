"""Top-level IR object for a single DocBundle.

A ``Bundle`` is a regular ``Node``: its fields are typed, it has a CBOR tag,
it serialises through the same ``encoder`` machinery as every other node,
and ``Node.validate()`` catches mis-typed fields without any pack-specific
validator. This is the unit that ``papyri pack`` produces and that the
viewer (or eventual hosted service) consumes.

Layout — all fields are positional in CBOR (see ``node_base.Node.cbor``),
so ``pack_format_version`` and ``ir_schema_version`` come first to make
forward-compatibility peeks cheap.
"""

from __future__ import annotations

from .doc import GeneratedDoc
from .node_base import Node, register
from .nodes import Section, TocTree

PACK_FORMAT_VERSION = 1
IR_SCHEMA_VERSION = "1"


@register(4070)
class Bundle(Node):
    pack_format_version: int
    ir_schema_version: str
    module: str
    version: str
    summary: str
    github_slug: str
    tag: str
    logo: str
    aliases: dict[str, str]
    extra: dict[str, str]
    api: dict[str, GeneratedDoc]
    narrative: dict[str, GeneratedDoc]
    examples: dict[str, Section]
    assets: dict[str, bytes]
    toc: list[TocTree]
