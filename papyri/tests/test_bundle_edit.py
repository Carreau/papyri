"""Tests for editing a DocBundle directory between ``gen`` and ``pack``."""

import json
from pathlib import Path

import pytest

from papyri.bundle_edit import (
    add_toc_entry,
    list_doc_keys,
    narrative_doc,
    read_doc,
    replace_block,
    write_doc,
)
from papyri.doc import GeneratedDoc
from papyri.nodes import (
    Paragraph,
    Section,
    Table,
    TableCell,
    TableRow,
    Text,
    section_title_text,
)
from papyri.pack import read_bundle_dir


def _sec(title: str, body: str, level: int = 1) -> Section:
    return Section(
        (Paragraph((Text(body),)),),
        (Text(title),),
        level=level,
    )


def _first_text(section: Section) -> str:
    para = section.children[0]
    assert isinstance(para, Paragraph)
    text = para.children[0]
    assert isinstance(text, Text)
    return text.value


def _titles(doc: GeneratedDoc) -> list[str]:
    return [section_title_text(s.title) for s in doc.arbitrary]


def _mini_bundle(tmp_path: Path) -> Path:
    """A minimal valid bundle dir built entirely through the edit API."""
    bundle = tmp_path / "mini_1.0"
    bundle.mkdir()
    (bundle / "papyri.json").write_text(
        json.dumps({"module": "mini", "version": "1.0"})
    )
    (bundle / "module").mkdir()
    write_doc(bundle, "index", narrative_doc([_sec("Mini", "hello")]))
    add_toc_entry(bundle, "index", "Mini")
    return bundle


def test_injected_bundle_packs_strict(tmp_path: Path) -> None:
    """A bundle whose narrative pages were all injected passes strict pack."""
    bundle = _mini_bundle(tmp_path)
    table = Table(
        children=(
            TableRow(
                header=True,
                children=(TableCell(children=(Paragraph((Text("h"),)),)),),
            ),
        )
    )
    doc = narrative_doc([Section((table,), (Text("Generated"),), level=1)])
    write_doc(bundle, "generated", doc)
    add_toc_entry(bundle, "generated", "Generated", parent="index")

    b = read_bundle_dir(bundle, strict=True)
    assert set(b.narrative) == {"index", "generated"}
    assert b.toc[0].children[0].ref.path == "generated"


def test_read_write_roundtrip(tmp_path: Path) -> None:
    bundle = _mini_bundle(tmp_path)
    doc = read_doc(bundle, "index")
    assert _first_text(doc.arbitrary[0]) == "hello"
    doc.arbitrary = (*doc.arbitrary, _sec("More", "world", level=2))
    write_doc(bundle, "index", doc)
    again = read_doc(bundle, "index")
    assert len(again.arbitrary) == 2


def test_replace_block_appends_then_replaces(tmp_path: Path) -> None:
    doc = narrative_doc([_sec("Page", "static intro")])
    block = [_sec("Injected", "v1", level=2), _sec("Detail", "d1", level=3)]
    replace_block(doc, "Injected", block)
    assert len(doc.arbitrary) == 3

    # Re-injecting replaces the whole block (leading section + deeper
    # levels), not appends — this is what makes injectors idempotent.
    block2 = [_sec("Injected", "v2", level=2)]
    replace_block(doc, "Injected", block2)
    assert _titles(doc) == ["Page", "Injected"]
    assert _first_text(doc.arbitrary[1]) == "v2"


def test_replace_block_preserves_following_sections(tmp_path: Path) -> None:
    doc = narrative_doc(
        [
            _sec("Page", "intro"),
            _sec("Injected", "old", level=2),
            _sec("Deeper", "old-child", level=3),
            _sec("Sibling", "keep me", level=2),
        ]
    )
    replace_block(doc, "Injected", [_sec("Injected", "new", level=2)])
    assert _titles(doc) == ["Page", "Injected", "Sibling"]


def test_add_toc_entry_is_idempotent(tmp_path: Path) -> None:
    bundle = _mini_bundle(tmp_path)
    write_doc(bundle, "extra", narrative_doc([_sec("Extra", "x")]))
    assert add_toc_entry(bundle, "extra", "Extra") is True
    assert add_toc_entry(bundle, "extra", "Extra") is False
    toc = json.loads((bundle / "toc.json").read_text())
    # single root ("index") with one child ("extra")
    assert len(toc) == 1
    assert len(toc[0]["children"]) == 1


def test_add_toc_entry_missing_doc_or_parent(tmp_path: Path) -> None:
    bundle = _mini_bundle(tmp_path)
    with pytest.raises(ValueError, match="missing doc"):
        add_toc_entry(bundle, "nope", "Nope")
    write_doc(bundle, "extra", narrative_doc([_sec("Extra", "x")]))
    with pytest.raises(ValueError, match="parent"):
        add_toc_entry(bundle, "extra", "Extra", parent="no-such-parent")


def test_read_doc_errors(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match=r"papyri\.json"):
        read_doc(tmp_path, "index")
    bundle = _mini_bundle(tmp_path)
    with pytest.raises(ValueError, match="available: index"):
        read_doc(bundle, "nope")
    with pytest.raises(ValueError, match="invalid"):
        read_doc(bundle, "../escape")
    assert list_doc_keys(bundle) == ["index"]
