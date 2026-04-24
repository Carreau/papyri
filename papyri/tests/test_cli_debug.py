"""
Tests for the ``papyri debug`` / ``papyri describe`` CLI helpers.

These are the maintainer-facing commands that inspect a bundle or an ingested
CBOR blob without a full renderer.  Regressions here hurt debuggability far
more than end users, but because the code is pure path arithmetic + prints
we can pin it cheaply.
"""

from pathlib import Path

from papyri import _print_data_context, _resolve_debug_path

# ---------------------------------------------------------------------------
# _resolve_debug_path
# ---------------------------------------------------------------------------


def test_resolve_debug_path_returns_direct_existing_file(tmp_path):
    p = tmp_path / "doc.cbor"
    p.write_bytes(b"x")
    assert _resolve_debug_path(str(p), tmp_path) == p


def test_resolve_debug_path_appends_cbor_suffix(tmp_path):
    p = tmp_path / "doc.cbor"
    p.write_bytes(b"x")
    # Caller passes the path without .cbor — resolver should find it.
    assert _resolve_debug_path(str(tmp_path / "doc"), tmp_path) == p


def test_resolve_debug_path_checks_data_dir(tmp_path):
    (tmp_path / "bundle_1.0").mkdir()
    p = tmp_path / "bundle_1.0" / "module" / "pkg.foo.cbor"
    p.parent.mkdir()
    p.write_bytes(b"x")
    # Shorthand relative to data dir, no .cbor suffix.
    assert (
        _resolve_debug_path("bundle_1.0/module/pkg.foo", tmp_path)
        == tmp_path / "bundle_1.0" / "module" / "pkg.foo.cbor"
    )


def test_resolve_debug_path_returns_none_for_missing(tmp_path):
    assert _resolve_debug_path("nonexistent", tmp_path) is None


# ---------------------------------------------------------------------------
# _print_data_context
# ---------------------------------------------------------------------------


def test_print_data_context_splits_bundle_dir_name(capsys):
    rel = Path("numpy_2.3.5/module/numpy.linspace.cbor")
    _print_data_context(rel)
    out = capsys.readouterr().out
    assert "package : numpy" in out
    assert "version : 2.3.5" in out
    assert "kind    : module" in out
    # The .cbor suffix must be stripped from the printed identifier.
    assert "id      : numpy.linspace" in out
    assert ".cbor" not in out


def test_print_data_context_handles_bundle_without_version(capsys):
    # Defensive: a bundle dir name with no "_" is rare but shouldn't crash.
    rel = Path("weirdbundle/module/pkg.foo")
    _print_data_context(rel)
    out = capsys.readouterr().out
    assert "package : weirdbundle" in out
    assert "version" not in out  # nothing printed for empty version
    assert "kind    : module" in out


def test_print_data_context_empty_rel_is_noop(capsys):
    _print_data_context(Path(""))
    assert capsys.readouterr().out == ""
