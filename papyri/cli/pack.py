"""``papyri pack`` — zip every gen bundle under ``~/.papyri/data/``."""

from __future__ import annotations


def pack() -> None:
    """
    Create a ``<bundle>.zip`` next to each gen bundle in
    ``~/.papyri/data/`` (delegates to ``papyri.gen.pack``).
    """
    from papyri.gen import pack as _pack

    _pack()
