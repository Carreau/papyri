"""Tests for ``papyri.pack`` — byte-reproducibility, validation, round-trip."""

from __future__ import annotations

import gzip
import json
import os
from pathlib import Path

import cbor2
import pytest

from papyri.bundle import IR_SCHEMA_VERSION, PACK_FORMAT_VERSION, Bundle
from papyri.node_base import TAG_MAP
from papyri.pack import (
    BundleError,
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
    extra_meta: dict | None = None,
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


def _make_bundle_node(**overrides) -> Bundle:
    """Construct a Bundle Node with sensible defaults — no on-disk dance."""
    defaults: dict = dict(
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


# ---------------------------------------------------------------------------
# Byte-reproducibility — the headline guarantee.
# ---------------------------------------------------------------------------


def test_pack_is_byte_reproducible_from_node():
    """Two encodings of the same Bundle Node must be byte-identical."""
    bundle = _make_bundle_node(
        aliases={"a": "1", "b": "2"},
        extra={"pypi": "mypkg"},
        assets={"logo.png": b"\x89PNG\r\n", "extra.bin": b"raw"},
    )
    a = make_artifact(bundle)
    b = make_artifact(bundle)
    assert a == b


def test_pack_is_byte_reproducible_from_dir(tmp_path):
    """Pack a directory twice — bytes match."""
    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    (bundle_dir / "assets").mkdir()
    (bundle_dir / "assets" / "logo.png").write_bytes(b"\x89PNG\r\n")
    a, _ = make_artifact_from_dir(bundle_dir)
    b, _ = make_artifact_from_dir(bundle_dir)
    assert a == b


def test_pack_is_byte_reproducible_under_filesystem_noise(tmp_path):
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


def test_artifact_has_zero_mtime_in_gzip_header():
    """Gzip header bytes 4..8 are mtime; must be zero for reproducibility."""
    bundle = _make_bundle_node()
    data = make_artifact(bundle)
    assert data[:2] == b"\x1f\x8b", "expected gzip magic"
    assert data[4:8] == b"\x00\x00\x00\x00", "gzip header carries an mtime"


# ---------------------------------------------------------------------------
# Round-trip and shape.
# ---------------------------------------------------------------------------


def test_pack_roundtrip_preserves_fields():
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


def test_load_artifact_decodes_to_bundle():
    bundle = _make_bundle_node()
    data = make_artifact(bundle)
    decoded = load_artifact(data)
    assert isinstance(decoded, Bundle)


def test_artifact_is_gzipped_cbor_with_bundle_tag():
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


def test_pack_version_peek_is_cheap():
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


def test_pack_rejects_missing_papyri_json(tmp_path):
    bundle_dir = tmp_path / "mypkg_1.0"
    bundle_dir.mkdir()
    (bundle_dir / "module").mkdir()
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert any("papyri.json" in p for p in excinfo.value.problems)


def test_pack_rejects_missing_module_dir(tmp_path):
    bundle_dir = tmp_path / "mypkg_1.0"
    bundle_dir.mkdir()
    (bundle_dir / "papyri.json").write_text('{"module":"mypkg","version":"1.0"}')
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert any("module/" in p for p in excinfo.value.problems)


def test_pack_rejects_papyri_json_missing_keys(tmp_path):
    bundle_dir = tmp_path / "mypkg_1.0"
    bundle_dir.mkdir()
    (bundle_dir / "module").mkdir()
    (bundle_dir / "papyri.json").write_text("{}")
    # Fail-fast: only the first missing key ("module") is reported.
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert "module" in excinfo.value.problems[0]


def test_pack_rejects_module_with_non_json_file(tmp_path):
    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    (bundle_dir / "module" / "stray.txt").write_text("oops")
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert any(".json" in p for p in excinfo.value.problems)


def test_pack_rejects_unexpected_toplevel_entry(tmp_path):
    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    (bundle_dir / ".DS_Store").write_text("junk")
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert any(".DS_Store" in p for p in excinfo.value.problems)


def test_pack_rejects_invalid_papyri_json(tmp_path):
    bundle_dir = tmp_path / "mypkg_1.0"
    bundle_dir.mkdir()
    (bundle_dir / "module").mkdir()
    (bundle_dir / "papyri.json").write_text("not json {{{")
    with pytest.raises(BundleError) as excinfo:
        read_bundle_dir(bundle_dir)
    assert any("valid JSON" in p for p in excinfo.value.problems)


def test_bundle_error_is_fail_fast(tmp_path):
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
# Reading from a directory.
# ---------------------------------------------------------------------------


def test_read_bundle_dir_minimal(tmp_path):
    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    bundle = read_bundle_dir(bundle_dir)
    assert bundle.module == "mypkg"
    assert bundle.version == "1.0"
    assert bundle.api == {}


def test_read_bundle_dir_carries_extra_meta(tmp_path):
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


def test_pack_cli_bulk_mode(tmp_path, monkeypatch):
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


def test_pack_cli_bulk_mode_rejects_output_flag(tmp_path, monkeypatch):
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


def test_read_bundle_dir_collects_assets(tmp_path):
    bundle_dir = _make_minimal_bundle_dir(tmp_path / "mypkg_1.0")
    (bundle_dir / "assets").mkdir()
    (bundle_dir / "assets" / "fig1.png").write_bytes(b"data1")
    (bundle_dir / "assets" / "fig2.svg").write_bytes(b"data2")
    bundle = read_bundle_dir(bundle_dir)
    assert bundle.assets == {"fig1.png": b"data1", "fig2.svg": b"data2"}
