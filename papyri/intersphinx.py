"""
Integration with the `intersphinx_registry` PyPI package.

Papyri's relink pass tags cross-references whose owning project is listed
in the registry as `kind="intersphinx"` (module=<project key>) instead of
`kind="missing"`. The viewer picks up the tag and resolves the actual URL
by looking up the qualified name in the project's local `objects.inv`.

No inventory fetching happens here; that's the job of the
`papyri intersphinx fetch` CLI command, which writes a manifest the viewer
reads at build time.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path
from typing import Dict, Optional, Tuple

from .nodes import RefInfo


RegistryEntry = Tuple[Optional[str], Optional[str]]


@cache
def load_registry() -> Dict[str, RegistryEntry]:
    """
    Return the full intersphinx registry as `{project: (docs_url, inv_loc)}`.

    `inv_loc` is usually ``None``, meaning the inventory lives at
    ``<docs_url>objects.inv``. The registry ships as a JSON file inside
    the `intersphinx_registry` package; we read it directly rather than
    calling `get_intersphinx_mapping(packages=...)` so we get every key
    without having to enumerate projects up-front.

    Returns an empty mapping if the package isn't installed or the file
    can't be read, so the rest of papyri keeps working without the dep.
    """
    try:
        from intersphinx_registry import registry_file
    except ImportError:
        return {}
    try:
        raw = json.loads(Path(registry_file).read_text())
    except OSError:
        return {}
    out: Dict[str, RegistryEntry] = {}
    for project, value in raw.items():
        if isinstance(value, list) and len(value) == 2:
            out[project] = (value[0], value[1])
    return out


def is_registered(project: Optional[str]) -> bool:
    if not project:
        return False
    return project in load_registry()


def inventory_url(project: str) -> Optional[str]:
    """URL of `<project>`'s `objects.inv`, or None if unknown."""
    entry = load_registry().get(project)
    if not entry:
        return None
    base, inv = entry
    if inv:
        return inv
    if not base:
        return None
    return base.rstrip("/") + "/objects.inv"


def base_url(project: str) -> Optional[str]:
    """Docs base URL for `<project>`, trailing slash guaranteed. None if unknown."""
    entry = load_registry().get(project)
    if not entry:
        return None
    base = entry[0]
    if not base:
        return None
    return base if base.endswith("/") else base + "/"


def maybe_intersphinx(ref: RefInfo) -> RefInfo:
    """
    Rewrite a ``kind="missing"`` RefInfo to ``kind="intersphinx"`` when the
    owning project is in the registry. Any other input passes through
    unchanged.

    The project key is the first dotted/colon-delimited component of
    `ref.path`; e.g. ``"numpy.linspace"`` and ``"numpy.fft:fft"`` both
    resolve to project ``"numpy"``. The rewritten RefInfo carries
    ``module=<project>`` so the viewer can look up the inventory without
    re-parsing the path.
    """
    if ref.kind != "missing":
        return ref
    head = ref.path.split(".", 1)[0].split(":", 1)[0]
    if not is_registered(head):
        return ref
    return RefInfo(module=head, version=None, kind="intersphinx", path=ref.path)
