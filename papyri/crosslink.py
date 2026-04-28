"""Read-side IR container for ingested documents.

The Python ingest engine has been removed; the canonical ingest path is
now the TypeScript ``papyri-ingest`` package, invoked server-side by the
viewer's ``/api/bundle`` upload endpoint (see ``papyri upload``).

This module remains because read-side CLI commands (``papyri find``,
``papyri describe``, ``papyri diff``, ``papyri debug``) and any other
Python reader still need to deserialize CBOR blobs from the ingest
store into ``IngestedDoc`` instances. The CBOR tag ``4010`` is part of
the on-disk IR contract.
"""

from __future__ import annotations

import logging
import warnings
from dataclasses import dataclass

from rich.logging import RichHandler

from .doc import _OrderedDictProxy
from .node_base import Node, register
from .nodes import (
    Section,
    SeeAlsoItem,
)
from .signature import SignatureNode

warnings.simplefilter("ignore", UserWarning)


FORMAT = "%(message)s"
logging.basicConfig(
    level="INFO", format=FORMAT, datefmt="[%X]", handlers=[RichHandler()]
)

log = logging.getLogger("papyri")


@register(4010)
@dataclass
class IngestedDoc(Node):
    __slots__ = (
        "_content",
        "_ordered_sections",
        "aliases",
        "arbitrary",
        "example_section_data",
        "item_file",
        "item_line",
        "item_type",
        "local_refs",
        "qa",
        "references",
        "see_also",
        "signature",
    )

    _content: dict[str, Section]
    _ordered_sections: list[str]
    item_file: str | None
    item_line: int | None
    item_type: str | None
    aliases: list[str]
    example_section_data: Section
    see_also: list[SeeAlsoItem]  # see also data
    signature: SignatureNode | None
    references: list[str] | None
    qa: str
    arbitrary: list[Section]
    local_refs: list[str]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._dp = _OrderedDictProxy(self._ordered_sections, self._content)

    @property
    def ordered_sections(self):
        return tuple(self._ordered_sections)

    @property
    def content(self):
        """
        A property to the dict proxy
        """
        return self._dp

    @classmethod
    def new(cls):
        return cls({}, [], None, None, None, [], None, None, None, None, None, None, [])
