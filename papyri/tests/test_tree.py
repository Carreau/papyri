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

from papyri.nodes import (
    CrossRef,
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
