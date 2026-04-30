"""
Tests for ``papyri.tree``: small pieces of the gen-time/ingest-time IR
transformation that are easy to pin and have historically regressed.

Covered surfaces:
- ``py_doc_handler`` (:doc: role → LocalRef("docs", path))
- ``DelayedResolver`` (target/reference unification)
- ``_toctree_handler`` (blank lines, comments, glob, malformed entries)
- ``_SPHINX_ONLY_DIRECTIVES`` (silent drop via warning)
"""

from __future__ import annotations

import pytest

from papyri.directives import make_image_handler
from papyri.nodes import (
    CrossRef,
    Figure,
    Image,
    LocalRef,
    RefInfo,
    UnprocessedDirective,
)
from papyri.tree import (
    _SPHINX_ONLY_DIRECTIVES,
    DelayedResolver,
    DirectiveVisiter,
    py_doc_handler,
)

# ---------------------------------------------------------------------------
# :doc: role  (py_doc_handler)
# ---------------------------------------------------------------------------


def test_py_doc_handler_simple_path():
    out = py_doc_handler("tutorial/intro")
    assert len(out) == 1
    ref = out[0]
    assert isinstance(ref, CrossRef)
    assert ref.kind == "docs"
    assert isinstance(ref.reference, LocalRef)
    assert ref.reference.kind == "docs"
    assert ref.reference.path == "tutorial/intro"
    assert ref.value == "tutorial/intro"


def test_py_doc_handler_titled_form():
    # "Nice Title <real/path>" — title is the display text, path the target.
    out = py_doc_handler("Nice Title <real/path>")
    ref = out[0]
    assert isinstance(ref, CrossRef)
    assert ref.value == "Nice Title"
    assert isinstance(ref.reference, LocalRef)
    assert ref.reference.path == "real/path"


# ---------------------------------------------------------------------------
# DelayedResolver
# ---------------------------------------------------------------------------


def test_delayed_resolver_reference_then_target():
    r = DelayedResolver()
    link = CrossRef(
        "lbl",
        reference=RefInfo(module="", version="", kind="?", path="x"),
        kind="exists",
        anchor=None,
    )
    r.add_reference(link, "sec-1")
    # Nothing yet → reference unresolved sentinel preserved.
    assert link.reference.kind == "?"

    target = LocalRef("docs", "chapter1")
    r.add_target(target, "sec-1")
    # Once the target arrives, the link points at it.
    assert link.reference is target


def test_delayed_resolver_target_then_reference():
    r = DelayedResolver()
    target = LocalRef("docs", "chapter1")
    r.add_target(target, "sec-1")

    link = CrossRef(
        "lbl",
        reference=RefInfo(module="", version="", kind="?", path="x"),
        kind="exists",
        anchor=None,
    )
    r.add_reference(link, "sec-1")
    # Arrived after target — must still be resolved.
    assert link.reference is target


def test_delayed_resolver_rejects_duplicate_target():
    r = DelayedResolver()
    target1 = LocalRef("docs", "chapter1")
    r.add_target(target1, "label")
    with pytest.raises(AssertionError):
        r.add_target(LocalRef("docs", "chapter2"), "label")


# ---------------------------------------------------------------------------
# _toctree_handler
# ---------------------------------------------------------------------------


def _make_visitor() -> DirectiveVisiter:
    return DirectiveVisiter(
        qa="pkg.mod",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
    )


def test_toctree_drops_blank_lines_and_comments():
    v = _make_visitor()
    content = "\n".join(
        [
            "",
            ".. this is a comment and must be ignored",
            "tutorial",
            "",
            "api",
        ]
    )
    out = v._toctree_handler(argument=None, options={}, content=content)
    # One BulletList with two items.
    assert len(out) == 1
    items = out[0].children
    assert len(items) == 2


def test_toctree_skips_self_entry():
    v = _make_visitor()
    content = "self\nchapter1"
    out = v._toctree_handler(argument=None, options={}, content=content)
    assert len(out[0].children) == 1


def test_toctree_glob_option_skips_wildcards():
    v = _make_visitor()
    content = "chapter1\napi/*\nchapter2"
    out = v._toctree_handler(argument=None, options={"glob": True}, content=content)
    # Only the literal entries survive.
    assert len(out[0].children) == 2


def test_toctree_title_form_parsed():
    v = _make_visitor()
    content = "Getting Started <intro>"
    out = v._toctree_handler(argument=None, options={}, content=content)
    items = out[0].children
    assert len(items) == 1
    # Inside the ListItem, the Paragraph wraps a CrossRef whose display value
    # is the title and whose reference path is "intro".
    para = items[0].children[0]
    crossref = para.children[0]
    assert isinstance(crossref, CrossRef)
    assert crossref.value == "Getting Started"
    assert crossref.reference.path == "intro"


def test_toctree_argument_is_silently_ignored():
    v = _make_visitor()
    # Phase 4 fix: some Sphinx builds pass a title argument. Don't assert,
    # just ignore it.
    out = v._toctree_handler(argument="My Title", options={}, content="chapter1")
    assert len(out[0].children) == 1


def test_toctree_malformed_entry_warns(caplog):
    v = _make_visitor()
    content = "ok\nbroken <no-closing"
    with caplog.at_level("WARNING", logger="papyri"):
        out = v._toctree_handler(argument=None, options={}, content=content)
    # "ok" still makes it through; malformed line is logged and dropped.
    assert len(out[0].children) == 1
    assert any("malformed" in r.getMessage().lower() for r in caplog.records)


# ---------------------------------------------------------------------------
# Sphinx-only directives
# ---------------------------------------------------------------------------


def test_sphinx_only_directives_list_has_expected_entries():
    # Pin the contract (Phase 4.C): these directives are silently dropped at
    # gen time because they have no meaning outside a running Sphinx build.
    for name in ("autofunction", "autoclass", "automodule", "ipython"):
        assert name in _SPHINX_ONLY_DIRECTIVES


def test_replace_unprocessed_directive_drops_sphinx_only(caplog):
    v = _make_visitor()
    ud = UnprocessedDirective(
        name="autofunction",
        args="numpy.linspace",
        options={},
        value="",
        children=[],
        raw=".. autofunction:: numpy.linspace",
    )
    with caplog.at_level("WARNING", logger="papyri"):
        out = v.replace_UnprocessedDirective(ud)
    assert out == []
    assert any("Sphinx-only" in r.getMessage() for r in caplog.records)


# ---------------------------------------------------------------------------
# make_image_handler (directives.py)
# ---------------------------------------------------------------------------


def test_image_handler_external_url():
    h = make_image_handler(None, None, "pkg", "1.0")
    out = h("https://example.com/img.png", {"alt": "logo"}, "")
    assert len(out) == 1
    assert isinstance(out[0], Image)
    assert out[0].url == "https://example.com/img.png"
    assert out[0].alt == "logo"


def test_image_handler_external_url_no_alt():
    h = make_image_handler(None, None, "pkg", "1.0")
    out = h("https://example.com/img.png", {}, "")
    assert isinstance(out[0], Image)
    assert out[0].alt == ""


def test_image_handler_local_without_doc_path_warns(caplog):
    h = make_image_handler(None, None, "pkg", "1.0")
    with caplog.at_level("WARNING", logger="papyri"):
        out = h("images/foo.png", {}, "")
    assert isinstance(out[0], Image)
    assert out[0].url == "images/foo.png"
    assert any("doc_path" in r.getMessage() for r in caplog.records)


def test_image_handler_local_file_stored(tmp_path):
    img_dir = tmp_path / "docs"
    img_dir.mkdir()
    (img_dir / "logo.png").write_bytes(b"\x89PNG fake")

    stored: dict[str, bytes] = {}
    h = make_image_handler(img_dir, stored.__setitem__, "pkg", "1.0")

    out = h("logo.png", {"alt": "the logo"}, "")
    assert len(out) == 1
    assert isinstance(out[0], Figure)
    assert out[0].value.path == "logo.png"
    assert out[0].value.kind == "assets"
    assert stored["logo.png"] == b"\x89PNG fake"


def test_image_handler_missing_file_warns(tmp_path, caplog):
    stored: dict[str, bytes] = {}
    h = make_image_handler(tmp_path, stored.__setitem__, "pkg", "1.0")
    with caplog.at_level("WARNING", logger="papyri"):
        out = h("missing.png", {}, "")
    assert isinstance(out[0], Image)
    assert out[0].url == "missing.png"
    assert stored == {}
    assert any("not found" in r.getMessage() for r in caplog.records)


def test_image_handler_root_relative_path_stored(tmp_path):
    """``/_images/foo.png`` is resolved relative to doc_root, not doc_path."""
    doc_root = tmp_path / "docs"
    images_dir = doc_root / "_images"
    images_dir.mkdir(parents=True)
    (images_dir / "unicode_completion.png").write_bytes(b"\x89PNG fake")

    # doc_path is a subdirectory - the file is NOT there.
    doc_path = doc_root / "reference"
    doc_path.mkdir()

    stored: dict[str, bytes] = {}
    h = make_image_handler(
        doc_path, stored.__setitem__, "pkg", "1.0", doc_root=doc_root
    )
    out = h("/_images/unicode_completion.png", {}, "")
    assert len(out) == 1
    assert isinstance(out[0], Figure)
    assert out[0].value.path == "unicode_completion.png"
    assert stored["unicode_completion.png"] == b"\x89PNG fake"


def test_image_handler_root_relative_no_doc_root_warns(caplog):
    stored: dict[str, bytes] = {}
    h = make_image_handler(None, stored.__setitem__, "pkg", "1.0", doc_root=None)
    with caplog.at_level("WARNING", logger="papyri"):
        out = h("/_images/foo.png", {}, "")
    assert isinstance(out[0], Image)
    assert out[0].url == "/_images/foo.png"
    assert stored == {}
    assert any("doc_root" in r.getMessage() for r in caplog.records)


def test_image_handler_registered_in_visitor(tmp_path):
    """The visitor's _handlers dict should contain an image handler by default."""
    v = _make_visitor()
    assert "image" in v._handlers


def test_image_handler_via_visitor_dispatch(tmp_path):
    """End-to-end: visitor dispatches an image UnprocessedDirective to the handler."""
    img_dir = tmp_path / "docs"
    img_dir.mkdir()
    (img_dir / "shot.png").write_bytes(b"\x89PNG fake")

    stored: dict[str, bytes] = {}
    v = DirectiveVisiter(
        qa="pkg.mod",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
        doc_path=img_dir,
        asset_store=stored.__setitem__,
    )
    ud = UnprocessedDirective(
        name="image",
        args="shot.png",
        options={"alt": "screenshot"},
        value="",
        children=[],
        raw=".. image:: shot.png",
    )
    out = v.replace_UnprocessedDirective(ud)
    assert len(out) == 1
    assert isinstance(out[0], Figure)
    assert out[0].value.path == "shot.png"
    assert stored["shot.png"] == b"\x89PNG fake"
