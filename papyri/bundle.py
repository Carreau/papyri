"""Top-level IR object for a single DocBundle.

A ``Bundle`` is a regular ``Node``: its fields are typed, it has a CBOR tag,
it serialises through the same ``encoder`` machinery as every other node,
and ``Node.validate()`` catches mis-typed fields without any pack-specific
validator. This is the unit that ``papyri pack`` produces and that the
viewer (or eventual hosted service) consumes.

Layout — all fields are positional in CBOR (see ``node_base.Node.cbor``),
so ``pack_format_version`` and ``ir_schema_version`` come first to make
forward-compatibility peeks cheap.

``BundleManifest`` mirrors the on-disk ``papyri.json`` format (human-readable
JSON written by ``papyri gen``).  It is the typed bridge between the JSON
staging area and the fully-typed ``Bundle`` Node that ``papyri pack`` produces.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass

from .doc import GeneratedDoc
from .node_base import Node, register
from .nodes import Section, TocTree

PACK_FORMAT_VERSION = 1
IR_SCHEMA_VERSION = "1"


@dataclass
class BundleManifest:
    """Typed representation of ``papyri.json`` — the per-bundle manifest.

    All optional fields default to empty strings / empty dicts so callers
    can assign them unconditionally after reading from JSON.  ``extra``
    collects any unrecognised scalar keys from ``papyri.json`` so they
    survive the pack round-trip as ``Bundle.extra``.
    """

    module: str
    version: str
    summary: str = ""
    github_slug: str = ""
    tag: str = ""
    logo: str = ""
    aliases: dict[str, str] = dataclasses.field(default_factory=dict)
    extra: dict[str, str] = dataclasses.field(default_factory=dict)


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
    toc: tuple[TocTree, ...]
