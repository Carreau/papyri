"""Tests for ``papyri.pack`` — byte-reproducibility, validation, round-trip."""

from __future__ import annotations

import gzip
import json
import os
from pathlib import Path
from typing import Any

import cbor2
import pytest

from papyri.bundle import IR_SCHEMA_VERSION, PACK_FORMAT_VERSION, Bundle
from papyri.node_base import TAG_MAP
from papyri.pack import (
    BundleError,
    explode_artifact_to_dir,
    explode_bundle_to_dir,
    find_orphan_docs,
    lint_bundle,
    load_artifact,
    make_artifact,
    make_artifact_from_dir,
    read_bundle_dir,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_minimal_bundle_dir(
    root: Path,
    *,
    module: str = "mypkg",
    version: str = "1.0",
    extra_meta: dict[str, Any] | None = None,
) -> Path:
    """
    Create a tiny but well-formed DocBundle directory.

    Avoids depending on `papyri.gen` (which would require a real Python
    library to introspect). The CBOR files contain trivial payloads that
    the structural pack-time checks accept; full IR-shape validation is
    deferred to the tests below that operate on a real ``Bundle`` Node.
    """
    root.mkdir(parents=True, exist_ok=True)
    meta = {"module": module, "version": version}
    if extra_meta:
        meta.update(extra_meta)
    (root / "papyri.json").write_text(json.dumps(meta, sort_keys=True))
    (root / "module").mkdir()
    return root


def _make_bundle_node(**overrides: Any) -> Bundle:
    """Construct a Bundle Node with sensible defaults — no on-disk dance."""
    defaults: dict[str, Any] = dict(
        pack_format_version=PACK_FORMAT_VERSION,
        ir_schema_version=IR_SCHEMA_VERSION,
        module="mypkg",
        version="1.0",
        summary="",
        github_slug="",
        tag="",
        logo="",
        aliases={},
        extra={},
        api={},
        narrative={},
        examples={},
        assets={},
        toc=[],
    )
    defaults.update(overrides)
    return Bundle(**defaults)


def _minimal_narrative_doc() -> Any:
    """A minimal but valid narrative ``GeneratedDoc``.

    ``GeneratedDoc.new()`` leaves ``example_section_data`` as ``None``, which
    bundle validation rejects for narrative docs; gen sets it to an empty
    ``Section`` (see ``Gen.collect_narrative_docs``), so mirror that here.
    """
    from papyri.doc import GeneratedDoc
    from papyri.nodes import Section

    doc = GeneratedDoc.new()
    doc.example_section_data = Section([], ())
    return doc


# ---------------------------------------------------------------------------
# Byte-reproducibility — the headline guarantee.
# ---------------------------------------------------------------------------


def test_pack_is_byte_reproducible_from_node() -> None:
    """Two encodings of the same Bundle Node must be byte-identical."""
    bundle = _make_bundle_node(
        aliases={"a": "1", "b": "2"},
        extra={"pypi": "mypkg"},
        assets={"logo.png": b"\x89PNG\r\n", "extra.bin": b"raw"},
    )
    a = make_artifact(bundle)
    b = make_artifact(bundle)
    assert a == b


def test_pack_is_byte_reproducible_from_dir(tmp_path: Any) -> None:
    """Pack a directory twice — bytes match."""
    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    (bundle_dir / "assets").mkdir()
    (bundle_dir / "assets" / "logo.png").write_bytes(b"\x89PNG\r\n")
    a, _ = make_artifact_from_dir(bundle_dir)
    b, _ = make_artifact_from_dir(bundle_dir)
    assert a == b


def test_pack_is_byte_reproducible_under_filesystem_noise(tmp_path: Any) -> None:
    """
    Two packs of the same logical bundle laid out in different directories
    with different filesystem mtimes must produce identical bytes. This
    catches any accidental leak of os.stat metadata into the artifact.
    """
    bundle_a = _make_minimal_bundle_dir(tmp_path / "a" / "mypkg_1.0")
    (bundle_a / "assets").mkdir()
    (bundle_a / "assets" / "logo.png").write_bytes(b"\x89PNG")

    bundle_b = _make_minimal_bundle_dir(tmp_path / "b" / "mypkg_1.0")
    (bundle_b / "assets").mkdir()
    (bundle_b / "assets" / "logo.png").write_bytes(b"\x89PNG")

    # Perturb every mtime in bundle_b.
    for p in bundle_b.rglob("*"):
        os.utime(p, (1234567890, 1234567890))

    a, _ = make_artifact_from_dir(bundle_a)
    b, _ = make_artifact_from_dir(bundle_b)
    assert a == b


def test_artifact_has_zero_mtime_in_gzip_header() -> None:
    """Gzip header bytes 4..8 are mtime; must be zero for reproducibility."""
    bundle = _make_bundle_node()
    data = make_artifact(bundle)
    assert data[:2] == b"\x1f\x8b", "expected gzip magic"
    assert data[4:8] == b"\x00\x00\x00\x00", "gzip header carries an mtime"


# ---------------------------------------------------------------------------
# Round-trip and shape.
# ---------------------------------------------------------------------------


def test_pack_roundtrip_preserves_fields() -> None:
    bundle = _make_bundle_node(
        module="numpy",
        version="2.4.4",
        summary="Array math.",
        github_slug="numpy/numpy",
        tag="v{{version}}",
        logo="logo.png",
        aliases={"np": "numpy"},
        extra={"pypi": "numpy"},
        assets={"logo.png": b"\x89PNG\r\n"},
    )
    data = make_artifact(bundle)
    decoded = load_artifact(data)
    assert decoded == bundle


def test_load_artifact_decodes_to_bundle() -> None:
    bundle = _make_bundle_node()
    data = make_artifact(bundle)
    decoded = load_artifact(data)
    assert isinstance(decoded, Bundle)


def test_artifact_is_gzipped_cbor_with_bundle_tag() -> None:
    """
    Peek the artifact: gunzip, then read the first CBOR major type. It
    should be a tag with the Bundle's registered value.
    """
    bundle = _make_bundle_node()
    data = make_artifact(bundle)
    cbor_bytes = gzip.decompress(data)
    obj = cbor2.loads(cbor_bytes)
    assert isinstance(obj, cbor2.CBORTag)
    assert obj.tag == TAG_MAP[Bundle]


def test_pack_version_peek_is_cheap() -> None:
    """
    The pack/IR version is in the first two positional fields of the
    Bundle CBOR-tagged array. A consumer that wants to gate compatibility
    can peek without instantiating the full Bundle.
    """
    bundle = _make_bundle_node()
    data = make_artifact(bundle)
    cbor_bytes = gzip.decompress(data)
    raw = cbor2.loads(cbor_bytes)
    assert isinstance(raw, cbor2.CBORTag)
    array = raw.value
    assert array[0] == PACK_FORMAT_VERSION
    assert array[1] == IR_SCHEMA_VERSION


# ---------------------------------------------------------------------------
# Validation.
# ---------------------------------------------------------------------------


def test_pack_rejects_missing_papyri_json(tmp_path: Any) -> None:
    bundle_dir = tmp_path / "mypkg_1.0"
    bundle_dir.mkdir()
    (bundle_dir / "module").mkdir()
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert any("papyri.json" in p for p in excinfo.value.problems)


def test_pack_rejects_missing_module_dir(tmp_path: Any) -> None:
    bundle_dir = tmp_path / "mypkg_1.0"
    bundle_dir.mkdir()
    (bundle_dir / "papyri.json").write_text('{"module":"mypkg","version":"1.0"}')
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert any("module/" in p for p in excinfo.value.problems)


def test_pack_rejects_papyri_json_missing_keys(tmp_path: Any) -> None:
    bundle_dir = tmp_path / "mypkg_1.0"
    bundle_dir.mkdir()
    (bundle_dir / "module").mkdir()
    (bundle_dir / "papyri.json").write_text("{}")
    # Fail-fast: only the first missing key ("module") is reported.
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert "module" in excinfo.value.problems[0]


def test_pack_rejects_module_with_non_json_file(tmp_path: Any) -> None:
    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    (bundle_dir / "module" / "stray.txt").write_text("oops")
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert any(".json" in p for p in excinfo.value.problems)


def test_pack_rejects_unexpected_toplevel_entry(tmp_path: Any) -> None:
    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    (bundle_dir / ".DS_Store").write_text("junk")
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert any(".DS_Store" in p for p in excinfo.value.problems)


def test_pack_rejects_bundle_with_gen_errors(tmp_path: Any) -> None:
    """A bundle whose papyri.json records gen errors must not pack.

    Lenient ``papyri gen`` records every per-object failure under ``errors``
    instead of producing a silently-degraded bundle; pack treats any such
    record as fatal so CI fails on a real mistake instead of shipping a
    bundle with missing pages.
    """
    bundle_dir = tmp_path / "mypkg_1.0"
    bundle_dir.mkdir()
    (bundle_dir / "module").mkdir()
    (bundle_dir / "papyri.json").write_text(
        json.dumps(
            {
                "module": "mypkg",
                "version": "1.0",
                "errors": [
                    {
                        "kind": "narrative",
                        "path": "docs/index.rst",
                        "error_type": "NotImplementedError",
                        "message": "unhandled directive 'totally-made-up'",
                    }
                ],
            }
        )
    )
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert "gen error" in excinfo.value.problems[0]
    assert "docs/index.rst" in excinfo.value.problems[0]


def test_pack_rejects_bundle_with_malformed_errors_field(tmp_path: Any) -> None:
    """A non-list ``errors`` field is itself a bundle-format error."""
    bundle_dir = tmp_path / "mypkg_1.0"
    bundle_dir.mkdir()
    (bundle_dir / "module").mkdir()
    (bundle_dir / "papyri.json").write_text(
        json.dumps({"module": "mypkg", "version": "1.0", "errors": "oops"})
    )
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert "must be a list" in excinfo.value.problems[0]


def test_pack_accepts_bundle_with_empty_errors(tmp_path: Any) -> None:
    """An explicitly empty ``errors`` list is the clean-build state."""
    bundle_dir = tmp_path / "mypkg_1.0"
    bundle_dir.mkdir()
    (bundle_dir / "module").mkdir()
    (bundle_dir / "papyri.json").write_text(
        json.dumps({"module": "mypkg", "version": "1.0", "errors": []})
    )
    bundle = read_bundle_dir(bundle_dir)
    assert bundle.module == "mypkg"


def test_pack_rejects_invalid_papyri_json(tmp_path: Any) -> None:
    bundle_dir = tmp_path / "mypkg_1.0"
    bundle_dir.mkdir()
    (bundle_dir / "module").mkdir()
    (bundle_dir / "papyri.json").write_text("not json {{{")
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert any("valid JSON" in p for p in excinfo.value.problems)


def test_bundle_error_is_fail_fast(tmp_path: Any) -> None:
    """Validation stops at the first problem; only one is reported."""
    bundle_dir = tmp_path / "mypkg_1.0"
    bundle_dir.mkdir()
    # Multiple defects are present, but read_bundle_dir must abort on
    # the first one rather than try to keep going.
    (bundle_dir / "junk").write_text("x")
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert len(excinfo.value.problems) == 1


# ---------------------------------------------------------------------------
# TOC referential integrity — every toc entry must resolve to a document.
# ---------------------------------------------------------------------------


def _write_toc(bundle_dir: Path, nodes: list[Any]) -> None:
    (bundle_dir / "toc.json").write_text(
        json.dumps([n.to_dict() for n in nodes], indent=2, sort_keys=True)
    )


def test_pack_rejects_toc_ref_to_missing_doc(tmp_path: Any) -> None:
    """A toc entry pointing at a doc absent from the bundle is fatal."""
    from papyri.nodes import LocalRef, TocTree

    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    (bundle_dir / "docs").mkdir()
    (bundle_dir / "docs" / "index").write_bytes(_minimal_narrative_doc().to_json())
    # "index" exists, but its child "missing" was never written to docs/.
    _write_toc(
        bundle_dir,
        [
            TocTree(
                children=(
                    TocTree(
                        children=(),
                        title="Gone",
                        ref=LocalRef("docs", "missing"),
                    ),
                ),
                title="Root",
                ref=LocalRef("docs", "index"),
            )
        ],
    )
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert "missing" in excinfo.value.problems[0]


def test_pack_rejects_toc_root_to_missing_doc(tmp_path: Any) -> None:
    """A toc root with no backing document is fatal."""
    from papyri.nodes import LocalRef, TocTree

    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    _write_toc(
        bundle_dir,
        [TocTree(children=(), title="Root", ref=LocalRef("docs", "index"))],
    )
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert "index" in excinfo.value.problems[0]


def test_pack_accepts_toc_with_all_docs_present(tmp_path: Any) -> None:
    """A toc whose every entry resolves to a doc packs cleanly."""
    from papyri.nodes import LocalRef, TocTree

    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    (bundle_dir / "docs").mkdir()
    for name in ("index", "page"):
        (bundle_dir / "docs" / name).write_bytes(_minimal_narrative_doc().to_json())
    _write_toc(
        bundle_dir,
        [
            TocTree(
                children=(
                    TocTree(
                        children=(),
                        title="Page",
                        ref=LocalRef("docs", "page"),
                    ),
                ),
                title="Root",
                ref=LocalRef("docs", "index"),
            )
        ],
    )
    bundle = read_bundle_dir(bundle_dir)
    assert len(bundle.toc) == 1
    assert bundle.toc[0].children[0].ref.path == "page"


def test_check_toc_refs_rejects_unknown_kind() -> None:
    """A toc ref whose kind is not docs/module/examples is fatal."""
    from papyri.nodes import LocalRef, TocTree
    from papyri.pack import _check_toc_refs

    bundle = _make_bundle_node(
        toc=[TocTree(children=(), title="x", ref=LocalRef("bogus", "x"))]
    )
    with pytest.raises(BundleError) as excinfo:
        _check_toc_refs(bundle)
    assert "bogus" in excinfo.value.problems[0]


# ---------------------------------------------------------------------------
# Orphan detection — narrative docs not reachable from the toc.
# ---------------------------------------------------------------------------


def test_find_orphan_docs_detects_unreachable() -> None:
    """A narrative doc that no toc entry points at is an orphan."""
    from papyri.nodes import LocalRef, TocTree

    bundle = _make_bundle_node(
        narrative={
            "index": _minimal_narrative_doc(),
            "page": _minimal_narrative_doc(),
            "stranded": _minimal_narrative_doc(),
        },
        toc=[
            TocTree(
                children=(
                    TocTree(children=(), title="Page", ref=LocalRef("docs", "page")),
                ),
                title="Root",
                ref=LocalRef("docs", "index"),
            )
        ],
    )
    assert find_orphan_docs(bundle) == ["stranded"]


def test_find_orphan_docs_empty_when_all_reachable() -> None:
    """Every narrative doc reachable (incl. nested) → no orphans."""
    from papyri.nodes import LocalRef, TocTree

    bundle = _make_bundle_node(
        narrative={
            "index": _minimal_narrative_doc(),
            "guide": _minimal_narrative_doc(),
            "guide:install": _minimal_narrative_doc(),
        },
        toc=[
            TocTree(
                children=(
                    TocTree(
                        children=(
                            TocTree(
                                children=(),
                                title="Install",
                                ref=LocalRef("docs", "guide:install"),
                            ),
                        ),
                        title="Guide",
                        ref=LocalRef("docs", "guide"),
                    ),
                ),
                title="Root",
                ref=LocalRef("docs", "index"),
            )
        ],
    )
    assert find_orphan_docs(bundle) == []


def test_find_orphan_docs_all_when_no_toc() -> None:
    """An empty toc strands every narrative doc."""
    bundle = _make_bundle_node(
        narrative={
            "a": _minimal_narrative_doc(),
            "b": _minimal_narrative_doc(),
        },
        toc=[],
    )
    assert find_orphan_docs(bundle) == ["a", "b"]


def test_read_bundle_dir_warns_on_orphan_docs(tmp_path: Any, caplog: Any) -> None:
    """Reading a bundle with an unreachable doc logs a warning (not fatal)."""
    from papyri.nodes import LocalRef, TocTree

    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    (bundle_dir / "docs").mkdir()
    for name in ("index", "stranded"):
        (bundle_dir / "docs" / name).write_bytes(_minimal_narrative_doc().to_json())
    _write_toc(
        bundle_dir,
        [TocTree(children=(), title="Root", ref=LocalRef("docs", "index"))],
    )
    with caplog.at_level("WARNING", logger="papyri"):
        bundle = read_bundle_dir(bundle_dir)
    # Reading still succeeds — orphans are a warning, not a hard error.
    assert "stranded" in bundle.narrative
    assert any("orphan" in r.getMessage() for r in caplog.records)
    assert any("stranded" in r.getMessage() for r in caplog.records)


def test_read_bundle_dir_strict_fails_on_orphan_docs(tmp_path: Any) -> None:
    """Reading a bundle with an unreachable doc fails in strict mode."""
    from papyri.nodes import LocalRef, TocTree

    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    (bundle_dir / "docs").mkdir()
    for name in ("index", "stranded"):
        (bundle_dir / "docs" / name).write_bytes(_minimal_narrative_doc().to_json())
    _write_toc(
        bundle_dir,
        [TocTree(children=(), title="Root", ref=LocalRef("docs", "index"))],
    )
    # Without strict mode, reading succeeds.
    bundle = read_bundle_dir(bundle_dir, strict=False)
    assert "stranded" in bundle.narrative

    # With strict mode, reading fails.
    with pytest.raises(BundleError) as exc_info:
        read_bundle_dir(bundle_dir, strict=True)
    assert "orphan" in str(exc_info.value).lower()
    assert "stranded" in str(exc_info.value)


# ---------------------------------------------------------------------------
# numpy toc smoke test — guards against narrative collection silently
# dropping most pages (which leaves the rendered toc nearly empty).
#
# numpy's doc/source isn't available in unit-test CI, so this exercises a
# real `papyri gen examples/numpy.toml` bundle when one is present under
# ~/.papyri/data/ and skips otherwise. The maintainer (who builds numpy
# locally / in the numpy-build CI) gets the coverage; everyone else skips.
# ---------------------------------------------------------------------------

# numpy's narrative tree has hundreds of pages; a healthy build is in the
# hundreds. A regression that drops most docs collapses the toc to a
# handful. 50 sits comfortably between the two so the test flags breakage
# without being brittle across numpy versions.
_NUMPY_MIN_TOC_ITEMS = 50


def _count_toc_items(nodes: list[Any]) -> int:
    """Total number of TocTree entries, counting nested children."""
    total = 0
    for node in nodes:
        total += 1
        total += _count_toc_items(node.get("children", []))
    return total


def _toc_doc_refs(nodes: list[Any]) -> set[str]:
    """All ``docs``-kind ref paths anywhere in the toc tree."""
    refs: set[str] = set()
    for node in nodes:
        ref = node.get("ref", {})
        if ref.get("kind") == "docs":
            refs.add(ref.get("path", ""))
        refs |= _toc_doc_refs(node.get("children", []))
    return refs


def _latest_numpy_bundle_dir() -> Path:
    data_dir = Path("~/.papyri/data").expanduser()
    bundle_dirs = sorted(data_dir.glob("numpy_*")) if data_dir.is_dir() else []
    if not bundle_dirs:
        pytest.skip("no generated numpy bundle under ~/.papyri/data/")
    return bundle_dirs[-1]


def test_numpy_toc_has_enough_items() -> None:
    bundle_dir = _latest_numpy_bundle_dir()
    toc_path = bundle_dir / "toc.json"
    assert toc_path.is_file(), f"{bundle_dir.name} has no toc.json"

    toc = json.loads(toc_path.read_text())
    count = _count_toc_items(toc)
    assert count >= _NUMPY_MIN_TOC_ITEMS, (
        f"{bundle_dir.name} toc has only {count} entries "
        f"(expected >= {_NUMPY_MIN_TOC_ITEMS}); narrative collection likely "
        f"dropped most pages"
    )


def test_numpy_narrative_docs_mostly_reachable() -> None:
    """Most of numpy's narrative docs must be reachable from the toc.

    A doc present in docs/ but listed under no toctree is an orphan: it
    renders at its URL but is invisible in navigation. A few intentional
    orphans are fine; a large crop means a toctree root was lost, which is
    the "narrative docs appear mostly empty" symptom.
    """
    bundle_dir = _latest_numpy_bundle_dir()
    docs_dir = bundle_dir / "docs"
    toc_path = bundle_dir / "toc.json"
    if not docs_dir.is_dir() or not toc_path.is_file():
        pytest.skip(f"{bundle_dir.name} has no narrative docs/toc")

    doc_keys = {e.name for e in docs_dir.iterdir() if e.is_file()}
    if not doc_keys:
        pytest.skip(f"{bundle_dir.name} has no narrative docs")

    reachable = _toc_doc_refs(json.loads(toc_path.read_text()))
    orphans = doc_keys - reachable
    orphan_ratio = len(orphans) / len(doc_keys)
    assert orphan_ratio <= 0.25, (
        f"{bundle_dir.name}: {len(orphans)}/{len(doc_keys)} narrative docs are "
        f"orphaned (>{orphan_ratio:.0%}); a toctree root was likely dropped. "
        f"Examples: {sorted(orphans)[:10]}"
    )


# ---------------------------------------------------------------------------
# Reading from a directory.
# ---------------------------------------------------------------------------


def test_read_bundle_dir_minimal(tmp_path: Any) -> None:
    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    bundle = read_bundle_dir(bundle_dir)
    assert bundle.module == "mypkg"
    assert bundle.version == "1.0"
    assert bundle.api == {}


def test_read_bundle_dir_carries_extra_meta(tmp_path: Any) -> None:
    bundle_dir = _make_minimal_bundle_dir(
        tmp_path / "mypkg_1.0",
        extra_meta={
            "summary": "A package.",
            "github_slug": "me/mypkg",
            "tag": "v{{version}}",
            "logo": "logo.png",
            "aliases": {"a": "b"},
            "pypi": "mypkg",  # unknown key → goes to .extra
        },
    )
    (bundle_dir / "assets").mkdir()
    (bundle_dir / "assets" / "logo.png").write_bytes(b"\x89PNG")
    bundle = read_bundle_dir(bundle_dir)
    assert bundle.summary == "A package."
    assert bundle.github_slug == "me/mypkg"
    assert bundle.tag == "v{{version}}"
    assert bundle.logo == "logo.png"
    assert bundle.aliases == {"a": "b"}
    assert bundle.extra == {"pypi": "mypkg"}
    assert bundle.assets == {"logo.png": b"\x89PNG"}


# ---------------------------------------------------------------------------
# CLI bulk-mode (papyri pack with no args).
# ---------------------------------------------------------------------------


def test_pack_cli_bulk_mode(tmp_path: Any, monkeypatch: Any) -> None:
    """No-arg `papyri pack` packs every bundle under ~/.papyri/data/."""
    import typer
    from typer.testing import CliRunner

    from papyri.cli.pack import pack as pack_cli

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    _make_minimal_bundle_dir(data_dir / "pkg1_1.0", module="pkg1", version="1.0")
    _make_minimal_bundle_dir(data_dir / "pkg2_2.0", module="pkg2", version="2.0")

    monkeypatch.setattr("papyri.cli.pack._DEFAULT_DATA_DIR", data_dir)

    app = typer.Typer()
    app.command()(pack_cli)
    result = CliRunner().invoke(app, [])

    assert result.exit_code == 0, result.output
    assert (data_dir / "pkg1-1.0.papyri").is_file()
    assert (data_dir / "pkg2-2.0.papyri").is_file()


def test_pack_cli_bulk_mode_rejects_output_flag(
    tmp_path: Any, monkeypatch: Any
) -> None:
    """--output is single-bundle-only; no-arg + --output is a usage error."""
    import typer
    from typer.testing import CliRunner

    from papyri.cli.pack import pack as pack_cli

    monkeypatch.setattr("papyri.cli.pack._DEFAULT_DATA_DIR", tmp_path)

    app = typer.Typer()
    app.command()(pack_cli)
    result = CliRunner().invoke(app, ["--output", str(tmp_path / "x.papyri")])

    assert result.exit_code == 2
    assert "single bundle" in result.output


def test_read_bundle_dir_collects_assets(tmp_path: Any) -> None:
    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    (bundle_dir / "assets").mkdir()
    (bundle_dir / "assets" / "fig1.png").write_bytes(b"data1")
    (bundle_dir / "assets" / "fig2.svg").write_bytes(b"data2")
    bundle = read_bundle_dir(bundle_dir)
    assert bundle.assets == {"fig1.png": b"data1", "fig2.svg": b"data2"}


# ---------------------------------------------------------------------------
# Unpack — explode a .papyri artifact back into a JSON DocBundle directory.
# ---------------------------------------------------------------------------


def test_explode_bundle_to_dir_round_trips(tmp_path: Any) -> None:
    """A Bundle exploded to disk re-reads as an identical Bundle."""
    from papyri.nodes import LocalRef, TocTree

    bundle = _make_bundle_node(
        module="numpy",
        version="2.4.4",
        summary="Array math.",
        github_slug="numpy/numpy",
        tag="v{{version}}",
        logo="logo.png",
        aliases={"np": "numpy"},
        extra={"pypi": "numpy"},
        assets={"logo.png": b"\x89PNG\r\n"},
        narrative={"index": _minimal_narrative_doc()},
        toc=[TocTree(children=(), title="Root", ref=LocalRef("docs", "index"))],
    )
    out = tmp_path / "numpy_2.4.4"
    explode_bundle_to_dir(bundle, out)
    assert read_bundle_dir(out) == bundle


def test_explode_bundle_to_dir_refuses_existing(tmp_path: Any) -> None:
    bundle = _make_bundle_node()
    out = tmp_path / "mypkg_1.0"
    out.mkdir()
    with pytest.raises(BundleError) as excinfo:
        explode_bundle_to_dir(bundle, out)
    assert "already exists" in excinfo.value.problems[0]


def test_explode_bundle_to_dir_omits_empty_optional_dirs(tmp_path: Any) -> None:
    """Empty narrative/examples/assets/toc produce no directory or file."""
    bundle = _make_bundle_node()
    out = tmp_path / "mypkg_1.0"
    explode_bundle_to_dir(bundle, out)
    assert (out / "papyri.json").is_file()
    assert (out / "module").is_dir()
    assert not (out / "docs").exists()
    assert not (out / "examples").exists()
    assert not (out / "assets").exists()
    assert not (out / "toc.json").exists()


def test_explode_bundle_to_dir_rejects_path_traversal_in_item_key(
    tmp_path: Any,
) -> None:
    """A crafted artifact whose item key escapes the target dir is rejected."""
    bundle = _make_bundle_node(assets={"../../../../escape.bin": b"pwn"})
    out = tmp_path / "mypkg_1.0"
    with pytest.raises(BundleError) as excinfo:
        explode_bundle_to_dir(bundle, out)
    assert "unsafe path" in excinfo.value.problems[0]
    # Nothing was written outside the target directory.
    assert not (tmp_path / "escape.bin").exists()


def test_explode_artifact_to_dir_rejects_traversal_in_module(tmp_path: Any) -> None:
    """A crafted module/version that escapes dest_parent is rejected."""
    bundle = _make_bundle_node(module="../../../../evil", version="1.0")
    artifact = tmp_path / "evil.papyri"
    artifact.write_bytes(make_artifact(bundle))
    dest = tmp_path / "dest"
    dest.mkdir()
    with pytest.raises(BundleError) as excinfo:
        explode_artifact_to_dir(artifact, dest)
    assert "unsafe path" in excinfo.value.problems[0]


def test_pack_rejects_unsafe_link_url() -> None:
    """A Link with a javascript: URL must be refused at pack time."""
    from papyri.nodes import Link

    bundle = _make_bundle_node(
        examples={"ex": Link(children=(), url="javascript:alert(1)", title="")}
    )
    with pytest.raises(BundleError) as excinfo:
        make_artifact(bundle)
    assert "disallowed scheme" in excinfo.value.problems[0]


def test_pack_rejects_unsafe_image_url() -> None:
    """An Image with a data: URL must be refused at pack time."""
    from papyri.nodes import Image

    bundle = _make_bundle_node(
        examples={"ex": Image(url="data:text/html,<script>x</script>", alt="")}
    )
    with pytest.raises(BundleError) as excinfo:
        make_artifact(bundle)
    assert "disallowed scheme" in excinfo.value.problems[0]


def test_pack_allows_safe_and_relative_urls() -> None:
    """http/https/mailto and relative/fragment URLs pack without error."""
    from papyri.nodes import Link

    bundle = _make_bundle_node(
        examples={
            "a": Link(children=(), url="https://example.com", title=""),
            "b": Link(children=(), url="../relative/path", title=""),
            "c": Link(children=(), url="#frag", title=""),
            "d": Link(children=(), url="mailto:a@b.com", title=""),
        }
    )
    # Must not raise.
    make_artifact(bundle)


def test_explode_artifact_to_dir_names_dir_and_round_trips(tmp_path: Any) -> None:
    """explode_artifact_to_dir derives '<module>_<version>' and round-trips."""
    bundle = _make_bundle_node(module="mypkg", version="1.0")
    artifact = tmp_path / "mypkg-1.0.papyri"
    artifact.write_bytes(make_artifact(bundle))
    out = explode_artifact_to_dir(artifact, tmp_path)
    assert out == tmp_path / "mypkg_1.0"
    assert read_bundle_dir(out) == bundle


def test_pack_unpack_round_trip_via_dir(tmp_path: Any) -> None:
    """gen-style dir → pack → unpack reproduces the original directory's Bundle."""
    bundle_dir = _make_minimal_bundle_dir(tmp_path / "src" / "mypkg_1.0")
    (bundle_dir / "assets").mkdir()
    (bundle_dir / "assets" / "logo.png").write_bytes(b"\x89PNG")
    artifact_bytes, original = make_artifact_from_dir(bundle_dir)
    artifact = tmp_path / "mypkg-1.0.papyri"
    artifact.write_bytes(artifact_bytes)
    out = explode_artifact_to_dir(artifact, tmp_path / "dest")
    assert read_bundle_dir(out) == original


def test_unpack_cli(tmp_path: Any) -> None:
    import typer
    from typer.testing import CliRunner

    from papyri.cli.unpack import unpack as unpack_cli

    bundle = _make_bundle_node(module="pkg", version="3.0")
    artifact = tmp_path / "pkg-3.0.papyri"
    artifact.write_bytes(make_artifact(bundle))

    app = typer.Typer()
    app.command()(unpack_cli)
    result = CliRunner().invoke(app, [str(artifact), "-o", str(tmp_path / "out")])

    assert result.exit_code == 0, result.output
    assert read_bundle_dir(tmp_path / "out" / "pkg_3.0") == bundle


def test_unpack_cli_rejects_missing_file(tmp_path: Any) -> None:
    import typer
    from typer.testing import CliRunner

    from papyri.cli.unpack import unpack as unpack_cli

    app = typer.Typer()
    app.command()(unpack_cli)
    result = CliRunner().invoke(app, [str(tmp_path / "nope.papyri")])

    assert result.exit_code == 1
    assert "is not a file" in result.output


# ---------------------------------------------------------------------------
# BundleManifest — typed manifest extracted from papyri.json.
# ---------------------------------------------------------------------------


def test_bundle_manifest_typed_fields(tmp_path):
    """read_bundle_dir produces a Bundle whose manifest fields are all str."""
    bundle_dir = _make_minimal_bundle_dir(
        tmp_path / "mypkg_1.0",
        extra_meta={
            "summary": "A package.",
            "github_slug": "me/mypkg",
            "tag": "v1.0",
            "logo": "logo.png",
            "aliases": {"a": "b"},
            "pypi": "mypkg",
        },
    )
    (bundle_dir / "assets").mkdir()
    (bundle_dir / "assets" / "logo.png").write_bytes(b"\x89PNG")
    bundle = read_bundle_dir(bundle_dir)
    assert isinstance(bundle.module, str)
    assert isinstance(bundle.version, str)
    assert isinstance(bundle.summary, str)
    assert isinstance(bundle.github_slug, str)
    assert isinstance(bundle.tag, str)
    assert isinstance(bundle.logo, str)
    assert isinstance(bundle.aliases, dict)
    assert isinstance(bundle.extra, dict)


def test_bundle_manifest_null_logo_becomes_empty_string(tmp_path):
    """logo: null in papyri.json must become '' in Bundle (logo is str, not str|None)."""
    bundle_dir = _make_minimal_bundle_dir(
        tmp_path / "mypkg_1.0",
        extra_meta={"logo": None},
    )
    bundle = read_bundle_dir(bundle_dir)
    assert bundle.logo == ""
    assert isinstance(bundle.logo, str)


def test_toc_bundle_field_is_tuple(tmp_path):
    """Bundle.toc must be a tuple[TocTree, ...], not a list."""
    from papyri.nodes import LocalRef, TocTree

    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    (bundle_dir / "docs").mkdir()
    (bundle_dir / "docs" / "index").write_bytes(_minimal_narrative_doc().to_json())
    (bundle_dir / "docs" / "page").write_bytes(_minimal_narrative_doc().to_json())
    root_toc = TocTree(
        children=(TocTree(children=(), title="Page", ref=LocalRef("docs", "page")),),
        title="Root",
        ref=LocalRef("docs", "index"),
    )
    (bundle_dir / "toc.json").write_text(
        json.dumps([root_toc.to_dict()], indent=2, sort_keys=True)
    )
    bundle = read_bundle_dir(bundle_dir)
    assert isinstance(bundle.toc, tuple)
    assert len(bundle.toc) == 1
    assert isinstance(bundle.toc[0], TocTree)
    assert bundle.toc[0].title == "Root"
    assert len(bundle.toc[0].children) == 1
    assert bundle.toc[0].children[0].ref.path == "page"


# ---------------------------------------------------------------------------
# lint_bundle — IR consistency checks without full packing.
# ---------------------------------------------------------------------------


def test_lint_bundle_clean() -> None:
    """A clean bundle returns no issues."""
    bundle = _make_bundle_node()
    issues = lint_bundle(bundle)
    assert issues == []


def test_lint_bundle_detects_unresolved_substitution_ref() -> None:
    """SubstitutionRef nodes should have been resolved; their presence is an issue."""
    from papyri.doc import GeneratedDoc
    from papyri.nodes import Paragraph, Section, SubstitutionRef

    doc = GeneratedDoc.new()
    doc._content = {"summary": Section([Paragraph([SubstitutionRef("VAR")])], ())}
    bundle = _make_bundle_node(api={"mod": doc})

    issues = lint_bundle(bundle)
    assert len(issues) == 1
    assert "unresolved SubstitutionRef" in issues[0]
    assert "module/mod" in issues[0]


def test_lint_bundle_detects_unresolved_substitution_def() -> None:
    """SubstitutionDef nodes should have been resolved; their presence is an issue."""
    from papyri.doc import GeneratedDoc
    from papyri.nodes import Paragraph, Section, SubstitutionDef

    doc = GeneratedDoc.new()
    doc._content = {"summary": Section([Paragraph([SubstitutionDef("VAR", [])])], ())}
    bundle = _make_bundle_node(narrative={"index": doc})

    issues = lint_bundle(bundle)
    assert len(issues) == 1
    assert "unresolved SubstitutionDef" in issues[0]
    assert "docs/index" in issues[0]


def test_lint_bundle_detects_missing_asset() -> None:
    """A Figure node referencing a missing asset is flagged."""
    from papyri.doc import GeneratedDoc
    from papyri.nodes import Figure, Paragraph, RefInfo, Section

    doc = GeneratedDoc.new()
    # Figure with a RefInfo pointing to a nonexistent asset
    fig = Figure(value=RefInfo(None, None, "assets", "missing.png"))
    doc._content = {"summary": Section([Paragraph([fig])], ())}
    bundle = _make_bundle_node(examples={"ex": doc})

    issues = lint_bundle(bundle)
    assert len(issues) == 1
    assert "missing asset" in issues[0]
    assert "missing.png" in issues[0]
    assert "examples/ex" in issues[0]


def test_lint_bundle_accepts_present_asset() -> None:
    """A Figure node referencing an asset that exists is OK."""
    from papyri.doc import GeneratedDoc
    from papyri.nodes import Figure, Paragraph, RefInfo, Section

    doc = GeneratedDoc.new()
    fig = Figure(value=RefInfo(None, None, "assets", "present.png"))
    doc._content = {"summary": Section([Paragraph([fig])], ())}
    bundle = _make_bundle_node(
        examples={"ex": doc}, assets={"present.png": b"image data"}
    )

    issues = lint_bundle(bundle)
    assert issues == []


def test_lint_bundle_multiple_issues() -> None:
    """Multiple issues are all collected and reported."""
    from papyri.doc import GeneratedDoc
    from papyri.nodes import Figure, Paragraph, RefInfo, Section, SubstitutionRef

    doc1 = GeneratedDoc.new()
    doc1._content = {"summary": Section([Paragraph([SubstitutionRef("VAR")])], ())}

    doc2 = GeneratedDoc.new()
    fig = Figure(value=RefInfo(None, None, "assets", "missing1.png"))
    doc2._content = {"summary": Section([Paragraph([fig])], ())}

    doc3 = GeneratedDoc.new()
    fig = Figure(value=RefInfo(None, None, "assets", "missing2.png"))
    doc3._content = {"summary": Section([Paragraph([fig])], ())}

    bundle = _make_bundle_node(
        api={"mod": doc1},
        narrative={"index": doc2},
        examples={"ex": doc3},
    )

    issues = lint_bundle(bundle)
    assert len(issues) == 3
    assert any("SubstitutionRef" in issue for issue in issues)
    assert any("missing1.png" in issue for issue in issues)
    assert any("missing2.png" in issue for issue in issues)
