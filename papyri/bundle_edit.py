"""Edit a DocBundle directory between ``papyri gen`` and ``papyri pack``.

The bundle directory is deliberately lenient, human-readable JSON so that
tools other than ``papyri gen`` can operate on it (see "Target shape" in
``PLAN.md``).  This module is the supported way to do that from Python:
inject or patch narrative pages whose content comes from runtime
introspection — a CLI's option reference, a plugin/magic listing, a
key-binding table — built directly as IR nodes, with no intermediate RST
files and no re-parsing.  A project runs its injector as one extra CI line
between ``gen`` and ``pack``::

    papyri gen mylib.toml
    python my_inject.py ~/.papyri/data/mylib_<version>
    papyri pack ~/.papyri/data/mylib_<version>

See ``examples/ipython_inject.py`` for a complete injector (IPython's
config-options, magics, and keyboard-shortcuts pages).

Narrative pages are a *flat* sequence of ``Section`` nodes ordered like the
document, with heading depth carried by ``Section.level`` — sections do not
nest.  A logical "block" therefore is a leading section plus every
following section of strictly deeper level; ``replace_block`` uses that
shape to make injection idempotent (re-running an injector updates content
in place instead of appending duplicates).
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path

from .doc import GeneratedDoc
from .nodes import LocalRef, Section, TocTree, section_title_text


def _check_bundle_dir(bundle_dir: Path) -> Path:
    bundle_dir = Path(bundle_dir).expanduser()
    if not (bundle_dir / "papyri.json").exists():
        raise ValueError(
            f"{bundle_dir} is not a DocBundle directory (no papyri.json); "
            "run `papyri gen` first"
        )
    return bundle_dir


def _check_key(key: str) -> str:
    # Narrative doc keys are ':'-joined path segments ("config:options:index").
    if not key or "/" in key or "\\" in key or key in {".", ".."}:
        raise ValueError(f"invalid narrative doc key {key!r}")
    return key


def list_doc_keys(bundle_dir: Path) -> list[str]:
    """List the narrative-doc keys present in a bundle directory."""
    bundle_dir = _check_bundle_dir(bundle_dir)
    docs = bundle_dir / "docs"
    if not docs.is_dir():
        return []
    return sorted(p.name for p in docs.iterdir() if p.is_file())


def read_doc(bundle_dir: Path, key: str) -> GeneratedDoc:
    """Read one narrative page (``docs/<key>``) as a ``GeneratedDoc``."""
    bundle_dir = _check_bundle_dir(bundle_dir)
    path = bundle_dir / "docs" / _check_key(key)
    if not path.is_file():
        raise ValueError(
            f"no narrative doc {key!r} in {bundle_dir} "
            f"(available: {', '.join(list_doc_keys(bundle_dir)) or 'none'})"
        )
    return GeneratedDoc.from_dict(json.loads(path.read_text()))


def write_doc(bundle_dir: Path, key: str, doc: GeneratedDoc) -> None:
    """Validate and write one narrative page to ``docs/<key>``."""
    bundle_dir = _check_bundle_dir(bundle_dir)
    doc.validate()
    docs = bundle_dir / "docs"
    docs.mkdir(exist_ok=True)
    (docs / _check_key(key)).write_bytes(doc.to_json())


def narrative_doc(sections: Sequence[Section]) -> GeneratedDoc:
    """Build a narrative-page ``GeneratedDoc`` from IR ``Section`` nodes.

    Produces the same shape ``papyri gen`` writes for a page under
    ``docs_path`` — use with ``write_doc`` + ``add_toc_entry`` to inject a
    brand-new page.
    """
    doc = GeneratedDoc.new()
    doc.arbitrary = tuple(sections)
    doc.example_section_data = Section([], ())
    doc.validate()
    return doc


def replace_block(
    doc: GeneratedDoc, title: str, sections: Sequence[Section]
) -> GeneratedDoc:
    """Replace (or append) a block of sections in a narrative page.

    A *block* is the first section whose plain-text title equals *title*
    plus every following section of strictly deeper ``level``.  When no
    section matches, the new sections are appended at the end of the page.
    The leading node of *sections* should itself be titled *title* so a
    second run replaces what the first inserted.

    Mutates and returns *doc* (for chaining into ``write_doc``).
    """
    assert sections, "replace_block needs at least one section"
    old = list(doc.arbitrary)
    start = next(
        (i for i, s in enumerate(old) if section_title_text(s.title) == title),
        None,
    )
    if start is None:
        doc.arbitrary = tuple(old) + tuple(sections)
        return doc
    level = old[start].level
    end = start + 1
    while end < len(old) and old[end].level > level:
        end += 1
    doc.arbitrary = tuple(old[:start]) + tuple(sections) + tuple(old[end:])
    return doc


def _toc_contains(nodes: Sequence[TocTree], key: str) -> bool:
    return any(n.ref.path == key or _toc_contains(n.children, key) for n in nodes)


def _toc_insert(
    nodes: Sequence[TocTree], parent: str, entry: TocTree
) -> tuple[TocTree, ...] | None:
    out: list[TocTree] = []
    changed = False
    for n in nodes:
        if not changed and n.ref.path == parent:
            n = TocTree(children=(*n.children, entry), title=n.title, ref=n.ref)
            changed = True
        elif not changed:
            rebuilt = _toc_insert(n.children, parent, entry)
            if rebuilt is not None:
                n = TocTree(children=rebuilt, title=n.title, ref=n.ref)
                changed = True
        out.append(n)
    return tuple(out) if changed else None


def add_toc_entry(
    bundle_dir: Path, key: str, title: str, parent: str | None = None
) -> bool:
    """Add a toc entry pointing at narrative doc *key*.

    The target doc must already exist (``write_doc`` first) — ``papyri
    pack`` hard-fails on toc entries pointing nowhere.  With *parent* set,
    the entry is appended under the toc node whose ref is that doc key;
    otherwise it is appended under the root when the toc has a single root,
    or at the top level.  Returns ``False`` (and changes nothing) when the
    toc already references *key* — so injectors stay idempotent.
    """
    bundle_dir = _check_bundle_dir(bundle_dir)
    _check_key(key)
    if not (bundle_dir / "docs" / key).is_file():
        raise ValueError(f"cannot add toc entry for missing doc {key!r}")
    toc_path = bundle_dir / "toc.json"
    nodes: tuple[TocTree, ...] = ()
    if toc_path.exists():
        nodes = tuple(TocTree.from_dict(d) for d in json.loads(toc_path.read_text()))
    if _toc_contains(nodes, key):
        return False
    entry = TocTree(children=(), title=title, ref=LocalRef("docs", key))
    if parent is not None:
        rebuilt = _toc_insert(nodes, parent, entry)
        if rebuilt is None:
            raise ValueError(f"toc has no entry for parent doc {parent!r}")
        nodes = rebuilt
    elif len(nodes) == 1:
        root = nodes[0]
        nodes = (
            TocTree(children=(*root.children, entry), title=root.title, ref=root.ref),
        )
    else:
        nodes = (*nodes, entry)
    toc_path.write_bytes(
        json.dumps([t.to_dict() for t in nodes], indent=2, sort_keys=True).encode()
    )
    return True
