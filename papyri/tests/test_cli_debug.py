"""
Tests for the ``papyri debug`` / ``papyri describe`` CLI helpers.

These are the maintainer-facing commands that inspect a bundle or an ingested
CBOR blob without a full renderer.  Regressions here hurt debuggability far
more than end users, but because the code is pure path arithmetic + prints
we can pin it cheaply.
"""

from pathlib import Path
from typing import Any

import pytest

from papyri.bundle import IR_SCHEMA_VERSION, PACK_FORMAT_VERSION, Bundle
from papyri.cli.debug import (
    _print_data_context,
    _resolve_debug_path,
    _select_bundle_object,
)
from papyri.doc import GeneratedDoc
from papyri.nodes import Section, Text


def _make_bundle() -> Bundle:
    return Bundle(
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
        api={"mypkg.foo": GeneratedDoc.new()},
        narrative={"intro": GeneratedDoc.new()},
        examples={"ex1": Section([], (Text("Examples"),))},
        assets={"logo.png": b"x"},
        toc=[],
    )


# ---------------------------------------------------------------------------
# _resolve_debug_path
# ---------------------------------------------------------------------------


def test_resolve_debug_path_returns_direct_existing_file(tmp_path: Any) -> None:
    p = tmp_path / "doc.cbor"
    p.write_bytes(b"x")
    assert _resolve_debug_path(str(p), tmp_path) == p


def test_resolve_debug_path_appends_cbor_suffix(tmp_path: Any) -> None:
    p = tmp_path / "doc.cbor"
    p.write_bytes(b"x")
    # Caller passes the path without .cbor — resolver should find it.
    assert _resolve_debug_path(str(tmp_path / "doc"), tmp_path) == p


def test_resolve_debug_path_checks_data_dir(tmp_path: Any) -> None:
    (tmp_path / "bundle_1.0").mkdir()
    p = tmp_path / "bundle_1.0" / "module" / "pkg.foo.json"
    p.parent.mkdir()
    p.write_bytes(b"x")
    # Shorthand relative to data dir, no .json suffix.
    assert (
        _resolve_debug_path("bundle_1.0/module/pkg.foo", tmp_path)
        == tmp_path / "bundle_1.0" / "module" / "pkg.foo.json"
    )


def test_resolve_debug_path_returns_none_for_missing(tmp_path: Any) -> None:
    assert _resolve_debug_path("nonexistent", tmp_path) is None


# ---------------------------------------------------------------------------
# _print_data_context
# ---------------------------------------------------------------------------


def test_print_data_context_splits_bundle_dir_name(capsys: Any) -> None:
    rel = Path("numpy_2.3.5/module/numpy.linspace.json")
    _print_data_context(rel)
    out = capsys.readouterr().out
    assert "package : numpy" in out
    assert "version : 2.3.5" in out
    assert "kind    : module" in out
    # The .json suffix must be stripped from the printed identifier.
    assert "id      : numpy.linspace" in out
    assert ".json" not in out


def test_print_data_context_handles_bundle_without_version(capsys: Any) -> None:
    # Defensive: a bundle dir name with no "_" is rare but shouldn't crash.
    rel = Path("weirdbundle/module/pkg.foo")
    _print_data_context(rel)
    out = capsys.readouterr().out
    assert "package : weirdbundle" in out
    assert "version" not in out  # nothing printed for empty version
    assert "kind    : module" in out


def test_print_data_context_empty_rel_is_noop(capsys: Any) -> None:
    _print_data_context(Path(""))
    assert capsys.readouterr().out == ""


# ---------------------------------------------------------------------------
# _select_bundle_object
# ---------------------------------------------------------------------------


def test_select_bundle_object_bare_name_searches_api_first() -> None:
    bundle = _make_bundle()
    assert _select_bundle_object(bundle, "mypkg.foo") is bundle.api["mypkg.foo"]
    assert _select_bundle_object(bundle, "intro") is bundle.narrative["intro"]
    assert _select_bundle_object(bundle, "ex1") is bundle.examples["ex1"]


def test_select_bundle_object_kind_prefix() -> None:
    bundle = _make_bundle()
    assert _select_bundle_object(bundle, "module:mypkg.foo") is bundle.api["mypkg.foo"]
    assert _select_bundle_object(bundle, "docs:intro") is bundle.narrative["intro"]
    assert _select_bundle_object(bundle, "examples:ex1") is bundle.examples["ex1"]


def test_select_bundle_object_unknown_prefix_is_part_of_qualname() -> None:
    # A colon that is not a known kind prefix belongs to the qualname; the
    # whole string is looked up as a bare name (and here doesn't exist).
    bundle = _make_bundle()
    bundle.api["papyri.nodes:RefInfo"] = GeneratedDoc.new()
    assert (
        _select_bundle_object(bundle, "papyri.nodes:RefInfo")
        is bundle.api["papyri.nodes:RefInfo"]
    )


def test_select_bundle_object_missing_lists_candidates() -> None:
    bundle = _make_bundle()
    with pytest.raises(KeyError) as exc:
        _select_bundle_object(bundle, "nope")
    msg = exc.value.args[0]
    assert "no object named 'nope'" in msg
    # Candidates from every collection are listed, sorted.
    assert "ex1" in msg and "intro" in msg and "mypkg.foo" in msg


def test_select_bundle_object_missing_in_kind_lists_that_kind() -> None:
    bundle = _make_bundle()
    with pytest.raises(KeyError) as exc:
        _select_bundle_object(bundle, "module:nope")
    msg = exc.value.args[0]
    assert "no 'module' object named 'nope'" in msg
    assert "mypkg.foo" in msg
    # Narrative/example keys must not leak into a module-scoped error.
    assert "intro" not in msg


def test_select_bundle_object_asset_is_rejected() -> None:
    bundle = _make_bundle()
    with pytest.raises(KeyError) as exc:
        _select_bundle_object(bundle, "logo.png")
    assert "binary asset" in exc.value.args[0]


def test_select_bundle_object_returns_json_serialisable_node() -> None:
    # The selected node round-trips to JSON — that is the whole point of the
    # feature (piping into jq).
    bundle = _make_bundle()
    obj = _select_bundle_object(bundle, "examples:ex1")
    import json

    assert json.loads(obj.to_json()) is not None
