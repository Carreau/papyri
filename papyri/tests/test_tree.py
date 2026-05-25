"""
Tests for ``papyri.tree``: small pieces of the gen-time/ingest-time IR
transformation that are easy to pin and have historically regressed.

Covered surfaces:
- ``py_doc_handler`` (:doc: role → LocalRef("docs", path))
- ``DelayedResolver`` (target/reference unification)
- ``_toctree_handler`` (blank lines, comments, glob, hidden, malformed entries, LocalRef links)
- ``_SPHINX_ONLY_DIRECTIVES`` (silent drop via warning)
- ``:ref:`` role resolution via doc_targets map
- ``rubric_handler`` (unnumbered section heading → Admonition(kind="rubric"))
- ``only_handler`` (conditional block → include when html, drop otherwise)
- ``literalinclude_handler`` (drop with warning)
- ``make_include_handler`` (RST file inclusion)
- ``csv_table_handler`` (CSV table → Table node)
- ``Target`` leaf-node traversal (no crash when Target appears in section children)
"""

from __future__ import annotations

from typing import Any

import pytest

from papyri.directives import (
    admonition_handler,
    attention_handler,
    caution_handler,
    container_handler,
    csv_table_handler,
    danger_handler,
    error_handler,
    hint_handler,
    important_handler,
    list_table_handler,
    literalinclude_handler,
    make_figure_handler,
    make_image_handler,
    make_include_handler,
    only_handler,
    plot_handler,
    raw_handler,
    rubric_handler,
    tip_handler,
    topic_handler,
)
from papyri.nodes import (
    Admonition,
    CrossRef,
    Figure,
    Image,
    InlineRole,
    Link,
    LocalRef,
    Paragraph,
    RefInfo,
    Section,
    Table,
    TableCell,
    TableRow,
    Target,
    Text,
    UnprocessedDirective,
)
from papyri.tree import (
    DelayedResolver,
    DirectiveVisiter,
    py_doc_handler,
)
from papyri.utils import obj_from_qualname

# ---------------------------------------------------------------------------
# obj_from_qualname — Class.method pattern
# ---------------------------------------------------------------------------


def test_obj_from_qualname_plain_function() -> None:
    fn = obj_from_qualname("papyri.directives:warn")
    from papyri.directives import warn

    assert fn is warn


def test_obj_from_qualname_class_method_returns_bound() -> None:
    # "Class.method" reference: the class is instantiated once and the returned
    # callable must be bound to that instance (has __self__ pointing at it).
    import io

    method = obj_from_qualname("io:StringIO.write")
    assert callable(method)
    assert isinstance(getattr(method, "__self__", None), io.StringIO)
    # Calling it works without passing self.
    assert method("hello") == 5


def test_obj_from_qualname_class_method_ctor_args() -> None:
    # ctor_args are forwarded to the class constructor before method lookup.
    method = obj_from_qualname("io:StringIO.getvalue", ctor_args=("seed",))
    assert method() == "seed"


def test_obj_from_qualname_class_method_ctor_kwargs() -> None:
    method = obj_from_qualname(
        "io:StringIO.getvalue", ctor_kwargs={"initial_value": "seed"}
    )
    assert method() == "seed"


def test_obj_from_qualname_class_itself_unchanged() -> None:
    # When the path ends on the class (no trailing attribute), return the class.
    import io

    cls = obj_from_qualname("io:StringIO")
    assert cls is io.StringIO


# ---------------------------------------------------------------------------
# :doc: role  (py_doc_handler)
# ---------------------------------------------------------------------------


def test_py_doc_handler_simple_path() -> None:
    out = py_doc_handler("tutorial/intro")
    assert len(out) == 1
    ref = out[0]
    assert isinstance(ref, CrossRef)
    assert ref.kind == "docs"
    assert isinstance(ref.reference, LocalRef)
    assert ref.reference.kind == "docs"
    assert ref.reference.path == "tutorial/intro"
    assert ref.value == "tutorial/intro"


def test_py_doc_handler_titled_form() -> None:
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


def test_delayed_resolver_reference_then_target() -> None:
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


def test_delayed_resolver_target_then_reference() -> None:
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


def test_delayed_resolver_rejects_duplicate_target() -> None:
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


def test_toctree_drops_blank_lines_and_comments() -> None:
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


def test_toctree_skips_self_entry() -> None:
    v = _make_visitor()
    content = "self\nchapter1"
    out = v._toctree_handler(argument=None, options={}, content=content)
    assert len(out[0].children) == 1


def test_toctree_glob_option_skips_wildcards() -> None:
    v = _make_visitor()
    content = "chapter1\napi/*\nchapter2"
    out = v._toctree_handler(argument=None, options={"glob": True}, content=content)
    # Only the literal entries survive.
    assert len(out[0].children) == 2


def test_toctree_title_form_parsed() -> None:
    v = _make_visitor()
    content = "Getting Started <intro>"
    out = v._toctree_handler(argument=None, options={}, content=content)
    items = out[0].children
    assert len(items) == 1
    # Inside the ListItem, the Paragraph wraps a CrossRef whose display value
    # is the title and whose reference is a LocalRef docs link.
    para = items[0].children[0]
    crossref = para.children[0]
    assert isinstance(crossref, CrossRef)
    assert crossref.value == "Getting Started"
    assert isinstance(crossref.reference, LocalRef)
    assert crossref.reference.kind == "docs"
    assert crossref.reference.path == "intro"


def test_toctree_resolves_relative_to_current_doc() -> None:
    # toctree entries are paths relative to the current doc's directory.
    # For doc key "whatsnew:index" (= whatsnew/index.rst), entry "version9"
    # must resolve to "whatsnew:version9" so the viewer can render a link.
    v = DirectiveVisiter(
        qa="whatsnew:index",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
    )
    out = v._toctree_handler(argument=None, options={}, content="version9\nversion8")
    paths = [item.children[0].children[0].reference.path for item in out[0].children]
    assert paths == ["whatsnew:version9", "whatsnew:version8"]


def test_toctree_absolute_path_anchored_at_root() -> None:
    v = DirectiveVisiter(
        qa="whatsnew:index",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
    )
    out = v._toctree_handler(argument=None, options={}, content="/install/quickstart")
    crossref = out[0].children[0].children[0].children[0]
    assert crossref.reference.path == "install:quickstart"


def test_toctree_strips_rst_extension() -> None:
    v = DirectiveVisiter(
        qa="whatsnew:index",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
    )
    out = v._toctree_handler(argument=None, options={}, content="version9.rst")
    crossref = out[0].children[0].children[0].children[0]
    assert crossref.reference.path == "whatsnew:version9"


def test_toctree_argument_is_silently_ignored() -> None:
    v = _make_visitor()
    # Phase 4 fix: some Sphinx builds pass a title argument. Don't assert,
    # just ignore it.
    out = v._toctree_handler(argument="My Title", options={}, content="chapter1")
    assert len(out[0].children) == 1


def test_toctree_malformed_entry_warns(caplog: Any) -> None:
    v = _make_visitor()
    content = "ok\nbroken <no-closing"
    with caplog.at_level("WARNING", logger="papyri"):
        out = v._toctree_handler(argument=None, options={}, content=content)
    # "ok" still makes it through; malformed line is logged and dropped.
    assert len(out[0].children) == 1
    assert any("malformed" in r.getMessage().lower() for r in caplog.records)


def test_toctree_not_hidden_produces_crossref_links() -> None:
    # Without the hidden option the handler must return a BulletList whose
    # items each wrap a CrossRef with a LocalRef("docs", ...) reference so
    # the viewer can construct a link to the page.
    v = _make_visitor()
    content = "intro\nadvanced"
    out = v._toctree_handler(argument=None, options={}, content=content)
    assert len(out) == 1
    items = out[0].children
    assert len(items) == 2
    for item, expected_path in zip(items, ["intro", "advanced"], strict=True):
        para = item.children[0]
        crossref = para.children[0]
        assert isinstance(crossref, CrossRef)
        assert isinstance(crossref.reference, LocalRef)
        assert crossref.reference.kind == "docs"
        assert crossref.reference.path == expected_path


def test_toctree_uses_doc_title_for_display_text() -> None:
    # When the bundle knows the target document's title, the rendered bullet
    # must show that title rather than the raw reference path.
    v = DirectiveVisiter(
        qa="pkg.mod",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
        doc_titles={"intro": "Getting Started", "advanced": "Advanced Topics"},
    )
    out = v._toctree_handler(argument=None, options={}, content="intro\nadvanced")
    items = out[0].children
    titles = [item.children[0].children[0].value for item in items]
    assert titles == ["Getting Started", "Advanced Topics"]


def test_toctree_falls_back_to_path_when_title_unknown() -> None:
    # If the target doc is not in the title map (forward ref, missing doc,
    # untitled doc), the display text remains the raw entry — current
    # behaviour preserved so partial bundles still render a usable bullet.
    v = DirectiveVisiter(
        qa="pkg.mod",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
        doc_titles={"intro": "Getting Started"},
    )
    out = v._toctree_handler(argument=None, options={}, content="intro\nunknown")
    items = out[0].children
    titles = [item.children[0].children[0].value for item in items]
    assert titles == ["Getting Started", "unknown"]


def test_toctree_explicit_title_wins_over_doc_title() -> None:
    # ``Custom <intro>`` form: the author-provided title is the contract,
    # so it must not be overridden by the destination doc's heading.
    v = DirectiveVisiter(
        qa="pkg.mod",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
        doc_titles={"intro": "Getting Started"},
    )
    out = v._toctree_handler(argument=None, options={}, content="Custom <intro>")
    crossref = out[0].children[0].children[0].children[0]
    assert isinstance(crossref, CrossRef)
    assert crossref.value == "Custom"


def test_toctree_doc_title_lookup_uses_resolved_doc_key() -> None:
    # Resolution is path-aware: a relative entry like ``version9`` in the
    # ``whatsnew/index`` doc resolves to ``whatsnew:version9`` — the title
    # map must be keyed accordingly.
    v = DirectiveVisiter(
        qa="whatsnew:index",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
        doc_titles={"whatsnew:version9": "Release 9.0"},
    )
    out = v._toctree_handler(argument=None, options={}, content="version9")
    crossref = out[0].children[0].children[0].children[0]
    assert crossref.value == "Release 9.0"
    assert crossref.reference.path == "whatsnew:version9"


def test_toctree_nested_path_uses_colon_separator() -> None:
    # Toctree entries like "whatsnew/index" must become LocalRef("docs",
    # "whatsnew:index") so the viewer's linkForDoc produces the correct URL.
    v = _make_visitor()
    out = v._toctree_handler(argument=None, options={}, content="whatsnew/index")
    crossref = out[0].children[0].children[0].children[0]
    assert isinstance(crossref.reference, LocalRef)
    assert crossref.reference.path == "whatsnew:index"


def test_toctree_titled_nested_path_uses_colon_separator() -> None:
    v = _make_visitor()
    out = v._toctree_handler(
        argument=None, options={}, content="What's New <whatsnew/index>"
    )
    crossref = out[0].children[0].children[0].children[0]
    assert isinstance(crossref.reference, LocalRef)
    assert crossref.reference.path == "whatsnew:index"


def test_toctree_hidden_returns_no_visible_output() -> None:
    # hidden=True suppresses inline rendering while still recording the TOC
    # data so it can be used for navigation metadata.
    v = _make_visitor()
    content = "intro\nadvanced"
    out = v._toctree_handler(argument=None, options={"hidden": True}, content=content)
    assert out == []
    # The toc data is still stored for navigation use.
    assert len(v._tocs) == 1
    assert len(v._tocs[0]) == 2


def test_toctree_hidden_false_explicit_produces_links() -> None:
    # Passing hidden=False explicitly should behave like the default.
    v = _make_visitor()
    out = v._toctree_handler(argument=None, options={"hidden": False}, content="page1")
    assert len(out) == 1
    assert len(out[0].children) == 1


def test_toctree_maxdepth_option_is_accepted() -> None:
    # maxdepth is a common Sphinx option; the handler must not raise.
    v = _make_visitor()
    out = v._toctree_handler(
        argument=None, options={"maxdepth": 2}, content="chapter1\nchapter2"
    )
    assert len(out) == 1
    assert len(out[0].children) == 2


def test_toctree_numbered_option_is_accepted() -> None:
    v = _make_visitor()
    out = v._toctree_handler(
        argument=None, options={"numbered": True}, content="chapter1"
    )
    assert len(out) == 1
    assert len(out[0].children) == 1


def test_toctree_titlesonly_option_is_accepted() -> None:
    v = _make_visitor()
    out = v._toctree_handler(
        argument=None, options={"titlesonly": True}, content="chapter1"
    )
    assert len(out) == 1
    assert len(out[0].children) == 1


def test_toctree_includehidden_option_is_accepted() -> None:
    v = _make_visitor()
    out = v._toctree_handler(
        argument=None, options={"includehidden": True}, content="chapter1"
    )
    assert len(out) == 1
    assert len(out[0].children) == 1


def test_toctree_empty_content_returns_empty_bullet_list() -> None:
    v = _make_visitor()
    out = v._toctree_handler(argument=None, options={}, content="")
    assert len(out) == 1
    assert len(out[0].children) == 0


def test_toctree_empty_content_hidden_returns_empty_list() -> None:
    v = _make_visitor()
    out = v._toctree_handler(argument=None, options={"hidden": True}, content="")
    assert out == []


def test_toctree_hidden_with_maxdepth_returns_no_visible_output() -> None:
    # Combining hidden with maxdepth (common in real Sphinx projects) must
    # still suppress inline output.
    v = _make_visitor()
    out = v._toctree_handler(
        argument=None,
        options={"hidden": True, "maxdepth": 1},
        content="changelog\nlicense",
    )
    assert out == []
    assert len(v._tocs[0]) == 2


# ---------------------------------------------------------------------------
# Sphinx-only directives
# ---------------------------------------------------------------------------


def test_replace_unprocessed_directive_drops_sphinx_only(caplog: Any) -> None:
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


def test_image_handler_external_url() -> None:
    h = make_image_handler(None, None, "pkg", "1.0")
    out = h("https://example.com/img.png", {"alt": "logo"}, "")
    assert len(out) == 1
    assert isinstance(out[0], Image)
    assert out[0].url == "https://example.com/img.png"
    assert out[0].alt == "logo"


def test_image_handler_external_url_no_alt() -> None:
    h = make_image_handler(None, None, "pkg", "1.0")
    out = h("https://example.com/img.png", {}, "")
    assert isinstance(out[0], Image)
    assert out[0].alt == ""


def test_image_handler_local_without_doc_path_warns(caplog: Any) -> None:
    h = make_image_handler(None, None, "pkg", "1.0")
    with caplog.at_level("WARNING", logger="papyri"):
        out = h("images/foo.png", {}, "")
    assert isinstance(out[0], Image)
    assert out[0].url == "images/foo.png"
    assert any("doc_path" in r.getMessage() for r in caplog.records)


def test_image_handler_local_file_stored(tmp_path: Any) -> None:
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


def test_image_handler_missing_file_warns(tmp_path: Any, caplog: Any) -> None:
    stored: dict[str, bytes] = {}
    h = make_image_handler(tmp_path, stored.__setitem__, "pkg", "1.0")
    with caplog.at_level("WARNING", logger="papyri"):
        out = h("missing.png", {}, "")
    assert isinstance(out[0], Image)
    assert out[0].url == "missing.png"
    assert stored == {}
    assert any("not found" in r.getMessage() for r in caplog.records)


def test_image_handler_root_relative_path_stored(tmp_path: Any) -> None:
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


def test_image_handler_root_relative_no_doc_root_warns(caplog: Any) -> None:
    stored: dict[str, bytes] = {}
    h = make_image_handler(None, stored.__setitem__, "pkg", "1.0", doc_root=None)
    with caplog.at_level("WARNING", logger="papyri"):
        out = h("/_images/foo.png", {}, "")
    assert isinstance(out[0], Image)
    assert out[0].url == "/_images/foo.png"
    assert stored == {}
    assert any("doc_root" in r.getMessage() for r in caplog.records)


def test_image_handler_registered_in_visitor(tmp_path: Any) -> None:
    """The visitor's _handlers dict should contain an image handler by default."""
    v = _make_visitor()
    assert "image" in v._handlers


def test_image_handler_via_visitor_dispatch(tmp_path: Any) -> None:
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


# ---------------------------------------------------------------------------
# seealso directive
# ---------------------------------------------------------------------------


def test_seealso_directive_produces_admonition() -> None:
    v = _make_visitor()
    ud = UnprocessedDirective(
        name="seealso",
        args="",
        options={},
        value="Some related topic.",
        children=[],
        raw=".. seealso::\n\n   Some related topic.",
    )
    out = v.replace_UnprocessedDirective(ud)
    assert len(out) == 1
    assert isinstance(out[0], Admonition)
    assert out[0].kind == "seealso"


def test_seealso_directive_empty_content_produces_admonition() -> None:
    v = _make_visitor()
    ud = UnprocessedDirective(
        name="seealso",
        args="",
        options={},
        value="",
        children=[],
        raw=".. seealso::",
    )
    out = v.replace_UnprocessedDirective(ud)
    assert len(out) == 1
    assert isinstance(out[0], Admonition)
    assert out[0].kind == "seealso"


# ---------------------------------------------------------------------------
# :ref: role resolution via doc_targets
# ---------------------------------------------------------------------------


def _make_visitor_with_targets(doc_targets: dict[str, str]) -> DirectiveVisiter:
    return DirectiveVisiter(
        qa="docs:overview",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
        doc_targets=doc_targets,
    )


def test_ref_role_known_label_emits_crossref_to_localref() -> None:
    # :ref:`ipythonzmq` with that label in doc_targets must produce a CrossRef
    # pointing at LocalRef("docs", doc_key).
    v = _make_visitor_with_targets({"ipythonzmq": "overview"})
    role = InlineRole(domain=None, role="ref", value="ipythonzmq")
    out = v.replace_InlineRole(role)
    assert len(out) == 1
    cr = out[0]
    assert isinstance(cr, CrossRef)
    assert isinstance(cr.reference, LocalRef)
    assert cr.reference.kind == "docs"
    assert cr.reference.path == "overview"
    assert cr.value == "ipythonzmq"


def test_ref_role_titled_form_uses_explicit_text() -> None:
    # :ref:`custom text <ipythonzmq>` — display text is "custom text",
    # target label is "ipythonzmq".
    v = _make_visitor_with_targets({"ipythonzmq": "overview"})
    role = InlineRole(domain=None, role="ref", value="custom text <ipythonzmq>")
    out = v.replace_InlineRole(role)
    assert len(out) == 1
    cr = out[0]
    assert isinstance(cr, CrossRef)
    assert cr.value == "custom text"
    assert isinstance(cr.reference, LocalRef)
    assert cr.reference.path == "overview"


def test_ref_role_unknown_label_returns_directive_unchanged() -> None:
    # An unresolved :ref: must pass through as an InlineRole rather than crash.
    v = _make_visitor_with_targets({})
    role = InlineRole(domain=None, role="ref", value="no-such-label")
    out = v.replace_InlineRole(role)
    assert len(out) == 1
    assert isinstance(out[0], InlineRole)


def test_ref_role_cross_doc_resolves_to_correct_doc_key() -> None:
    # Label defined in a different doc within the same bundle.
    v = _make_visitor_with_targets({"zmq-architecture": "internals:zmq"})
    role = InlineRole(domain=None, role="ref", value="zmq-architecture")
    out = v.replace_InlineRole(role)
    cr = out[0]
    assert isinstance(cr, CrossRef)
    assert cr.reference.path == "internals:zmq"


def test_plain_hyperlink_angle_bracket_resolves_doc_target() -> None:
    # Plain RST hyperlink `See below <quickstart.shape-manipulation>`_ where the
    # target matches a known doc anchor. The role is None (no explicit :ref:), so
    # the existing :ref: branch never fires — this exercises the fallback check.
    v = _make_visitor_with_targets(
        {"quickstart.shape-manipulation": "quickstart:shape-manipulation"}
    )
    role = InlineRole(
        domain=None, role=None, value="See below <quickstart.shape-manipulation>"
    )
    out = v.replace_InlineRole(role)
    assert len(out) == 1
    cr = out[0]
    assert isinstance(cr, CrossRef)
    assert cr.value == "See below"
    assert isinstance(cr.reference, LocalRef)
    assert cr.reference.kind == "docs"
    assert cr.reference.path == "quickstart:shape-manipulation"


def test_plain_hyperlink_angle_bracket_unresolved_does_not_crash() -> None:
    # If the target is not in doc_targets, the reference falls through to API
    # resolution; for an unresolvable target it should return the directive
    # unchanged rather than raise.
    v = _make_visitor_with_targets({})
    role = InlineRole(domain=None, role=None, value="See below <no-such-label>")
    out = v.replace_InlineRole(role)
    assert len(out) == 1


# ---------------------------------------------------------------------------
# Target node traversal (generic_visit leaf)
# ---------------------------------------------------------------------------


def test_target_node_passes_through_generic_visit() -> None:
    # Target has no children attribute; generic_visit must not crash and must
    # return the node unchanged.
    v = DirectiveVisiter(
        qa="docs:overview",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
    )
    # Wrap a Target in a Section so the visitor has a root node with children.
    target = Target(label="my-anchor")
    section = Section(children=[target], title="Overview")
    result = v.visit(section)
    assert isinstance(result, Section)
    assert len(result.children) == 1
    assert isinstance(result.children[0], Target)
    assert result.children[0].label == "my-anchor"


# ---------------------------------------------------------------------------
# External named hyperlink target resolution
# ---------------------------------------------------------------------------


def _make_visitor_with_external(external_targets: dict[str, str]) -> DirectiveVisiter:
    return DirectiveVisiter(
        qa="docs:overview",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
        external_targets=external_targets,
    )


def test_named_hyperlink_resolves_to_external_link() -> None:
    # `(X)Emacs`_ — bare named reference whose label points to a recorded URL.
    v = _make_visitor_with_external({"(X)Emacs": "http://www.gnu.org/software/emacs/"})
    role = InlineRole(domain=None, role=None, value="(X)Emacs")
    out = v.replace_InlineRole(role)
    assert len(out) == 1
    link = out[0]
    assert isinstance(link, Link)
    assert link.url == "http://www.gnu.org/software/emacs/"
    assert len(link.children) == 1
    assert isinstance(link.children[0], Text)
    assert link.children[0].value == "(X)Emacs"


def test_named_hyperlink_angle_bracket_uses_display_text() -> None:
    # `Show <target>`_ — angle-bracket form: display text is "Show", target is
    # "target".
    v = _make_visitor_with_external({"target": "http://example.com/"})
    role = InlineRole(domain=None, role=None, value="Show <target>")
    out = v.replace_InlineRole(role)
    assert len(out) == 1
    link = out[0]
    assert isinstance(link, Link)
    assert link.url == "http://example.com/"
    child = link.children[0]
    assert isinstance(child, Text)
    assert child.value == "Show"


def test_embedded_uri_autolink_produces_link() -> None:
    # `<https://example.com/>`_ — embedded URI with no display text. visit_reference
    # in ts.py synthesizes ``uri <uri>`` so replace_InlineRole turns it into a Link
    # with the URI as both display text and target.
    v = _make_visitor_with_external({})
    role = InlineRole(
        domain=None, role=None, value="https://example.com/ <https://example.com/>"
    )
    out = v.replace_InlineRole(role)
    assert len(out) == 1
    link = out[0]
    assert isinstance(link, Link)
    assert link.url == "https://example.com/"
    child = link.children[0]
    assert isinstance(child, Text)
    assert child.value == "https://example.com/"


def test_simple_hyperlink_reference_trailing_underscore_resolves() -> None:
    # Bare ``vim_`` reference. visit_reference keeps the trailing ``_`` in the
    # value because the same shape is also a Python identifier (``np.bool_``).
    # Resolution must strip it when probing external_targets.
    v = _make_visitor_with_external({"vim": "http://www.vim.org/"})
    role = InlineRole(domain=None, role=None, value="vim_")
    out = v.replace_InlineRole(role)
    assert len(out) == 1
    link = out[0]
    assert isinstance(link, Link)
    assert link.url == "http://www.vim.org/"
    child = link.children[0]
    assert isinstance(child, Text)
    # Display text should drop the RST ``_`` syntax marker.
    assert child.value == "vim"


def test_named_hyperlink_unknown_label_falls_through() -> None:
    # Unrecorded label must not be silently turned into a Link; falls through
    # to the existing resolution path (returns directive unchanged).
    v = _make_visitor_with_external({})
    role = InlineRole(domain=None, role=None, value="no-such-label")
    out = v.replace_InlineRole(role)
    assert len(out) == 1


def test_section_with_mixed_children_traverses_target() -> None:
    # Section containing a paragraph, a Target, and another paragraph must
    # survive generic_visit with all three children intact.
    v = DirectiveVisiter(
        qa="docs:overview",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
    )
    p1 = Paragraph([Text("before")])
    anchor = Target(label="anchor")
    p2 = Paragraph([Text("after")])
    section = Section(children=[p1, anchor, p2], title="T")
    result = v.visit(section)
    types = [type(c).__name__ for c in result.children]
    assert types == ["Paragraph", "Target", "Paragraph"]


# ---------------------------------------------------------------------------
# list-table directive
# ---------------------------------------------------------------------------


def _list_table_content() -> str:
    return "* - Header A\n  - Header B\n* - r1a\n  - r1b\n* - r2a\n  - r2b\n"


def test_list_table_basic_shape() -> None:
    out = list_table_handler("", {"header-rows": "1"}, _list_table_content())
    assert len(out) == 1
    table = out[0]
    assert isinstance(table, Table)
    assert len(table.children) == 3
    for row in table.children:
        assert isinstance(row, TableRow)
        assert len(row.children) == 2
        for cell in row.children:
            assert isinstance(cell, TableCell)


def test_list_table_header_rows_marks_first_row() -> None:
    out = list_table_handler("", {"header-rows": "1"}, _list_table_content())
    table = out[0]
    assert table.children[0].header is True
    assert table.children[1].header is False
    assert table.children[2].header is False


def test_list_table_no_header_rows_option_defaults_to_zero() -> None:
    out = list_table_handler("", {}, _list_table_content())
    table = out[0]
    assert all(row.header is False for row in table.children)


def test_list_table_cell_contents_are_flow_nodes() -> None:
    out = list_table_handler("", {"header-rows": "1"}, _list_table_content())
    table = out[0]
    cell = table.children[0].children[0]
    # First cell holds a Paragraph(Text("Header A")).
    para = cell.children[0]
    assert isinstance(para, Paragraph)
    inline = para.children[0]
    assert isinstance(inline, Text)
    assert inline.value == "Header A"


def test_list_table_caption_emitted_as_paragraph() -> None:
    out = list_table_handler("My Caption", {}, _list_table_content())
    assert len(out) == 2
    caption = out[0]
    assert isinstance(caption, Paragraph)
    inline = caption.children[0]
    assert isinstance(inline, Text)
    assert inline.value == "My Caption"
    assert isinstance(out[1], Table)


def test_list_table_empty_body_returns_nothing() -> None:
    assert list_table_handler("", {}, "") == []
    assert list_table_handler("", {}, "   \n  \n") == []


def test_list_table_registered_on_visitor() -> None:
    v = _make_visitor()
    assert "list-table" in v._handlers


def test_list_table_via_full_directive_pipeline() -> None:
    # End-to-end: an UnprocessedDirective for ``list-table`` is dispatched
    # through the visitor and replaced with a structured Table node.
    v = _make_visitor()
    up = UnprocessedDirective(
        name="list-table",
        args="",
        options={"header-rows": "1"},
        value=_list_table_content(),
        children=(),
        raw="",
    )
    out = v.replace_UnprocessedDirective(up)
    tables = [x for x in out if isinstance(x, Table)]
    assert len(tables) == 1
    assert tables[0].children[0].header is True


# ---------------------------------------------------------------------------
# rubric_handler
# ---------------------------------------------------------------------------


def test_rubric_handler_produces_admonition():
    out = rubric_handler("References", {}, "")
    assert len(out) == 1
    adm = out[0]
    assert isinstance(adm, Admonition)
    assert adm.kind == "rubric"


def test_rubric_handler_title_text():
    out = rubric_handler("References", {}, "")
    adm = out[0]
    from papyri.nodes import AdmonitionTitle

    title = adm.children[0]
    assert isinstance(title, AdmonitionTitle)
    first = title.children[0]
    assert isinstance(first, Text)
    assert first.value == "References"


def test_rubric_handler_empty_argument():
    out = rubric_handler("", {}, "")
    assert len(out) == 1
    adm = out[0]
    assert isinstance(adm, Admonition)
    assert adm.kind == "rubric"


def test_rubric_registered_on_visitor():
    v = _make_visitor()
    assert "rubric" in v._handlers


def test_rubric_via_visitor_dispatch():
    v = _make_visitor()
    up = UnprocessedDirective(
        name="rubric",
        args="References",
        options={},
        value="",
        children=(),
        raw=".. rubric:: References",
    )
    out = v.replace_UnprocessedDirective(up)
    assert len(out) == 1
    assert isinstance(out[0], Admonition)
    assert out[0].kind == "rubric"


# ---------------------------------------------------------------------------
# only_handler
# ---------------------------------------------------------------------------


def test_only_html_condition_drops_with_warning(caplog):
    # Even ``.. only:: html`` blocks are dropped — they frequently contain
    # raw HTML which is a security risk in the IR.
    with caplog.at_level("WARNING", logger="papyri"):
        out = only_handler("html", {}, "Some HTML-only text.")
    assert out == []
    assert any("only" in r.getMessage() for r in caplog.records)


def test_only_non_html_condition_drops_with_warning(caplog):
    with caplog.at_level("WARNING", logger="papyri"):
        out = only_handler("latex", {}, "Some latex-only text.")
    assert out == []
    assert any("only" in r.getMessage() for r in caplog.records)


def test_only_empty_content_drops_with_warning(caplog):
    with caplog.at_level("WARNING", logger="papyri"):
        out = only_handler("html", {}, "")
    assert out == []


def test_only_registered_on_visitor():
    v = _make_visitor()
    assert "only" in v._handlers


def test_only_drops_html_via_visitor(caplog):
    v = _make_visitor()
    up = UnprocessedDirective(
        name="only",
        args="html",
        options={},
        value=".. raw:: html\n\n   <script>alert('xss')</script>",
        children=(),
        raw=".. only:: html\n\n   .. raw:: html\n\n      <script>alert('xss')</script>",
    )
    with caplog.at_level("WARNING", logger="papyri"):
        out = v.replace_UnprocessedDirective(up)
    assert out == []


# ---------------------------------------------------------------------------
# literalinclude_handler
# ---------------------------------------------------------------------------


def test_literalinclude_drops_with_warning(caplog):
    with caplog.at_level("WARNING", logger="papyri"):
        out = literalinclude_handler("myfile.py", {}, "")
    assert out == []
    assert any("literalinclude" in r.getMessage() for r in caplog.records)


def test_literalinclude_registered_on_visitor():
    v = _make_visitor()
    assert "literalinclude" in v._handlers


# ---------------------------------------------------------------------------
# csv_table_handler
# ---------------------------------------------------------------------------


def test_csv_table_basic():
    content = '"Alice","30"\n"Bob","25"'
    out = csv_table_handler("", {}, content)
    assert len(out) == 1
    table = out[0]
    assert isinstance(table, Table)
    assert len(table.children) == 2


def test_csv_table_header_option():
    content = '"Alice","30"\n"Bob","25"'
    opts = {"header": '"Name","Age"'}
    out = csv_table_handler("", opts, content)
    assert len(out) == 1
    table = out[0]
    assert table.children[0].header is True
    assert len(table.children) == 3  # 1 header + 2 data rows


def test_csv_table_header_rows_option():
    content = '"Name","Age"\n"Alice","30"\n"Bob","25"'
    out = csv_table_handler("", {"header-rows": "1"}, content)
    assert len(out) == 1
    table = out[0]
    assert table.children[0].header is True
    assert table.children[1].header is False


def test_csv_table_caption_emits_paragraph():
    content = '"Alice","30"'
    out = csv_table_handler("My Caption", {}, content)
    assert len(out) == 2
    assert isinstance(out[0], Paragraph)
    assert isinstance(out[1], Table)


def test_csv_table_empty_body_returns_nothing():
    assert csv_table_handler("", {}, "") == []
    assert csv_table_handler("", {}, "   \n  ") == []


def test_csv_table_registered_on_visitor():
    v = _make_visitor()
    assert "csv-table" in v._handlers


def test_csv_table_via_visitor_dispatch():
    v = _make_visitor()
    up = UnprocessedDirective(
        name="csv-table",
        args="",
        options={},
        value='"A","B"\n"1","2"',
        children=(),
        raw="",
    )
    out = v.replace_UnprocessedDirective(up)
    tables = [x for x in out if isinstance(x, Table)]
    assert len(tables) == 1
    assert len(tables[0].children) == 2


# ---------------------------------------------------------------------------
# make_include_handler
# ---------------------------------------------------------------------------


def test_include_no_doc_path_warns(caplog, tmp_path):
    handler = make_include_handler(doc_path=None, doc_root=None)
    with caplog.at_level("WARNING", logger="papyri"):
        out = handler("some/file.rst", {}, "")
    assert out == []
    assert any("include" in r.getMessage() for r in caplog.records)


def test_include_missing_file_warns(caplog, tmp_path):
    handler = make_include_handler(doc_path=tmp_path, doc_root=None)
    with caplog.at_level("WARNING", logger="papyri"):
        out = handler("nonexistent.rst", {}, "")
    assert out == []
    assert any("include" in r.getMessage() for r in caplog.records)


def test_include_empty_argument_warns(caplog, tmp_path):
    handler = make_include_handler(doc_path=tmp_path, doc_root=None)
    with caplog.at_level("WARNING", logger="papyri"):
        out = handler("", {}, "")
    assert out == []
    assert any("include" in r.getMessage() for r in caplog.records)


def test_include_nonempty_content_warns(caplog, tmp_path):
    handler = make_include_handler(doc_path=tmp_path, doc_root=None)
    with caplog.at_level("WARNING", logger="papyri"):
        out = handler("somefile.rst", {}, "unexpected body text")
    assert out == []
    assert any("include" in r.getMessage() for r in caplog.records)


def test_include_basic_rst(tmp_path):
    rst_file = tmp_path / "fragment.rst"
    rst_file.write_text("Hello world.\n", encoding="utf-8")
    handler = make_include_handler(doc_path=tmp_path, doc_root=None)
    out = handler("fragment.rst", {}, "")
    # parse() returns Section nodes; the handler returns them as-is
    assert len(out) >= 1
    assert isinstance(out[0], Section)


def test_include_returns_parsed_nodes(tmp_path):
    rst_file = tmp_path / "frag.rst"
    rst_file.write_text("Some included paragraph.\n", encoding="utf-8")
    handler = make_include_handler(doc_path=tmp_path, doc_root=None)
    out = handler("frag.rst", {}, "")
    # Flatten all children from all returned sections and check for Text content
    all_text = [
        item.value
        for section in out
        for child in section.children
        if isinstance(child, Paragraph)
        for item in child.children
        if isinstance(item, Text)
    ]
    assert any("included" in t for t in all_text)


def test_include_start_line_option(tmp_path):
    rst_file = tmp_path / "lines.rst"
    rst_file.write_text("line0\n\nline1\n\nline2\n", encoding="utf-8")
    handler = make_include_handler(doc_path=tmp_path, doc_root=None)
    out = handler("lines.rst", {"start-line": "2"}, "")
    # Content from line index 2 onward — "line1\n\nline2\n"
    flat = _flatten_text(out)
    assert "line0" not in flat
    assert "line2" in flat


def test_include_end_line_option(tmp_path):
    rst_file = tmp_path / "lines.rst"
    rst_file.write_text("line0\n\nline1\n\nline2\n", encoding="utf-8")
    handler = make_include_handler(doc_path=tmp_path, doc_root=None)
    out = handler("lines.rst", {"end-line": "2"}, "")
    # Content up to (not including) line index 2 — "line0\n\n"
    flat = _flatten_text(out)
    assert "line0" in flat
    assert "line2" not in flat


def test_include_start_after_option(tmp_path):
    rst_file = tmp_path / "sa.rst"
    rst_file.write_text("BEFORE\n\nAFTER TEXT\n", encoding="utf-8")
    handler = make_include_handler(doc_path=tmp_path, doc_root=None)
    out = handler("sa.rst", {"start-after": "BEFORE"}, "")
    flat = _flatten_text(out)
    assert "BEFORE" not in flat
    assert "AFTER TEXT" in flat


def test_include_end_after_option(tmp_path):
    rst_file = tmp_path / "ea.rst"
    rst_file.write_text("KEEP THIS\n\nSTOP HERE\n\nDROP THIS\n", encoding="utf-8")
    handler = make_include_handler(doc_path=tmp_path, doc_root=None)
    out = handler("ea.rst", {"end-after": "STOP HERE"}, "")
    flat = _flatten_text(out)
    assert "KEEP THIS" in flat
    assert "STOP HERE" in flat
    assert "DROP THIS" not in flat


def test_include_absolute_path_with_doc_root(tmp_path):
    doc_root = tmp_path / "docs"
    doc_root.mkdir()
    (doc_root / "shared.rst").write_text("Shared content.\n", encoding="utf-8")
    handler = make_include_handler(doc_path=None, doc_root=doc_root)
    out = handler("/shared.rst", {}, "")
    assert len(out) >= 1


def test_include_absolute_path_no_doc_root_warns(caplog, tmp_path):
    handler = make_include_handler(doc_path=tmp_path, doc_root=None)
    with caplog.at_level("WARNING", logger="papyri"):
        out = handler("/absolute/path.rst", {}, "")
    assert out == []
    assert any("include" in r.getMessage() for r in caplog.records)


def test_include_registered_on_visitor():
    v = _make_visitor()
    assert "include" in v._handlers


def test_include_via_visitor_dispatch(tmp_path):
    rst_file = tmp_path / "snippet.rst"
    rst_file.write_text("Dispatched content.\n", encoding="utf-8")
    v = DirectiveVisiter(
        qa="pkg.mod",
        known_refs=frozenset(),
        local_refs=frozenset(),
        aliases={},
        version="1.0",
        doc_path=tmp_path,
    )
    up = UnprocessedDirective(
        name="include",
        args="snippet.rst",
        options={},
        value="",
        children=(),
        raw="",
    )
    out = v.replace_UnprocessedDirective(up)
    flat = _flatten_text(out)
    assert "Dispatched" in flat


def _flatten_text(nodes: list[Any]) -> str:
    """Recursively collect all Text node values from a list of IR nodes."""
    parts: list[str] = []
    for node in nodes:
        if isinstance(node, Text):
            parts.append(node.value)
        elif hasattr(node, "children") and node.children:
            parts.append(_flatten_text(list(node.children)))
    return " ".join(parts)


# ---------------------------------------------------------------------------
# _SPHINX_ONLY_DIRECTIVES additions
# ---------------------------------------------------------------------------


def test_sphinx_only_directives_includes_doctest_infra():
    from papyri.tree import _SPHINX_ONLY_DIRECTIVES

    for name in ("testsetup", "testcleanup", "testcode", "testoutput"):
        assert name in _SPHINX_ONLY_DIRECTIVES, (
            f"{name!r} not in _SPHINX_ONLY_DIRECTIVES"
        )


def test_sphinx_only_directives_includes_highlight():
    from papyri.tree import _SPHINX_ONLY_DIRECTIVES

    assert "highlight" in _SPHINX_ONLY_DIRECTIVES


def test_sphinx_only_directives_includes_currentmodule():
    from papyri.tree import _SPHINX_ONLY_DIRECTIVES

    assert "currentmodule" in _SPHINX_ONLY_DIRECTIVES


def test_sphinx_only_directives_includes_py_domain_manual():
    from papyri.tree import _SPHINX_ONLY_DIRECTIVES

    for name in (
        "function",
        "class",
        "method",
        "attribute",
        "data",
        "exception",
        "module",
    ):
        assert name in _SPHINX_ONLY_DIRECTIVES, (
            f"{name!r} not in _SPHINX_ONLY_DIRECTIVES"
        )


def test_sphinx_only_drops_testcleanup_via_visitor(caplog):
    v = _make_visitor()
    ud = UnprocessedDirective(
        name="testcleanup",
        args="",
        options={},
        value="del x",
        children=[],
        raw=".. testcleanup::\n\n   del x",
    )
    with caplog.at_level("WARNING", logger="papyri"):
        out = v.replace_UnprocessedDirective(ud)
    assert out == []


def test_sphinx_only_drops_currentmodule_via_visitor():
    v = _make_visitor()
    ud = UnprocessedDirective(
        name="currentmodule",
        args="numpy",
        options={},
        value="",
        children=[],
        raw=".. currentmodule:: numpy",
    )
    out = v.replace_UnprocessedDirective(ud)
    assert out == []


# ---------------------------------------------------------------------------
# Standard RST admonitions
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "handler,kind",
    [
        (attention_handler, "attention"),
        (caution_handler, "caution"),
        (danger_handler, "danger"),
        (error_handler, "error"),
        (hint_handler, "hint"),
        (important_handler, "important"),
        (tip_handler, "tip"),
    ],
)
def test_standard_admonition_handler_produces_admonition(handler, kind):
    out = handler("", {}, "Some body text.")
    assert len(out) == 1
    adm = out[0]
    assert isinstance(adm, Admonition)
    assert adm.kind == kind


@pytest.mark.parametrize(
    "name",
    ["attention", "caution", "danger", "error", "hint", "important", "tip"],
)
def test_standard_admonition_registered_on_visitor(name):
    v = _make_visitor()
    assert name in v._handlers


@pytest.mark.parametrize(
    "name",
    ["attention", "caution", "danger", "error", "hint", "important", "tip"],
)
def test_standard_admonition_via_visitor_dispatch(name):
    v = _make_visitor()
    ud = UnprocessedDirective(
        name=name,
        args="",
        options={},
        value="Be careful.",
        children=(),
        raw=f".. {name}::\n\n   Be careful.",
    )
    out = v.replace_UnprocessedDirective(ud)
    assert len(out) == 1
    assert isinstance(out[0], Admonition)
    assert out[0].kind == name


# ---------------------------------------------------------------------------
# Generic admonition directive
# ---------------------------------------------------------------------------


def test_admonition_handler_with_title():
    out = admonition_handler("My Custom Title", {}, "Some body.")
    assert len(out) == 1
    adm = out[0]
    assert isinstance(adm, Admonition)
    assert adm.kind == "admonition"
    from papyri.nodes import AdmonitionTitle

    title = adm.children[0]
    assert isinstance(title, AdmonitionTitle)
    first = title.children[0]
    assert isinstance(first, Text)
    assert first.value == "My Custom Title"


def test_admonition_handler_no_body():
    out = admonition_handler("Just a Title", {}, "")
    assert len(out) == 1
    adm = out[0]
    assert isinstance(adm, Admonition)
    assert adm.kind == "admonition"


def test_admonition_registered_on_visitor():
    v = _make_visitor()
    assert "admonition" in v._handlers


def test_admonition_via_visitor_dispatch():
    v = _make_visitor()
    ud = UnprocessedDirective(
        name="admonition",
        args="Custom Warning",
        options={},
        value="Pay attention to this.",
        children=(),
        raw=".. admonition:: Custom Warning\n\n   Pay attention to this.",
    )
    out = v.replace_UnprocessedDirective(ud)
    assert len(out) == 1
    assert isinstance(out[0], Admonition)
    assert out[0].kind == "admonition"


# ---------------------------------------------------------------------------
# topic_handler
# ---------------------------------------------------------------------------


def test_topic_handler_produces_admonition():
    out = topic_handler("Overview", {}, "This is the overview.")
    assert len(out) == 1
    adm = out[0]
    assert isinstance(adm, Admonition)
    assert adm.kind == "topic"


def test_topic_handler_title_in_admonition_title():
    out = topic_handler("My Topic", {}, "Body text.")
    adm = out[0]
    from papyri.nodes import AdmonitionTitle

    title = adm.children[0]
    assert isinstance(title, AdmonitionTitle)
    first = title.children[0]
    assert isinstance(first, Text)
    assert first.value == "My Topic"


def test_topic_registered_on_visitor():
    v = _make_visitor()
    assert "topic" in v._handlers


def test_topic_via_visitor_dispatch():
    v = _make_visitor()
    ud = UnprocessedDirective(
        name="topic",
        args="Quick Info",
        options={},
        value="Details here.",
        children=(),
        raw=".. topic:: Quick Info\n\n   Details here.",
    )
    out = v.replace_UnprocessedDirective(ud)
    assert len(out) == 1
    assert isinstance(out[0], Admonition)
    assert out[0].kind == "topic"


# ---------------------------------------------------------------------------
# raw_handler
# ---------------------------------------------------------------------------


def test_raw_handler_drops_html_with_warning(caplog):
    with caplog.at_level("WARNING", logger="papyri"):
        out = raw_handler("html", {}, "<p>some html</p>")
    assert out == []
    assert any("raw" in r.getMessage() for r in caplog.records)


def test_raw_handler_drops_latex_with_warning(caplog):
    with caplog.at_level("WARNING", logger="papyri"):
        out = raw_handler("latex", {}, r"\textbf{bold}")
    assert out == []


def test_raw_handler_registered_on_visitor():
    v = _make_visitor()
    assert "raw" in v._handlers


def test_raw_via_visitor_dispatch_drops_content(caplog):
    v = _make_visitor()
    ud = UnprocessedDirective(
        name="raw",
        args="html",
        options={},
        value="<script>alert('xss')</script>",
        children=(),
        raw=".. raw:: html\n\n   <script>alert('xss')</script>",
    )
    with caplog.at_level("WARNING", logger="papyri"):
        out = v.replace_UnprocessedDirective(ud)
    assert out == []


# ---------------------------------------------------------------------------
# container_handler
# ---------------------------------------------------------------------------


def test_container_handler_unfolds_content():
    out = container_handler("myclass", {}, "Content paragraph.\n")
    assert len(out) >= 1
    assert isinstance(out[0], Paragraph)


def test_container_handler_empty_returns_empty():
    assert container_handler("", {}, "") == []
    assert container_handler("", {}, "   ") == []


def test_container_registered_on_visitor():
    v = _make_visitor()
    assert "container" in v._handlers


def test_container_via_visitor_dispatch():
    v = _make_visitor()
    ud = UnprocessedDirective(
        name="container",
        args="highlight",
        options={},
        value="Highlighted content.",
        children=(),
        raw=".. container:: highlight\n\n   Highlighted content.",
    )
    out = v.replace_UnprocessedDirective(ud)
    assert len(out) >= 1
    assert isinstance(out[0], Paragraph)


# ---------------------------------------------------------------------------
# plot_handler
# ---------------------------------------------------------------------------


def test_plot_handler_with_code_body_returns_code():
    from papyri.nodes import Code

    out = plot_handler("", {}, "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])")
    assert len(out) == 1
    assert isinstance(out[0], Code)


def test_plot_handler_empty_body_returns_empty():
    out = plot_handler("", {}, "")
    assert out == []


def test_plot_handler_file_arg_drops_with_warning(caplog):
    with caplog.at_level("WARNING", logger="papyri"):
        out = plot_handler("examples/myplot.py", {}, "")
    assert out == []
    assert any("plot" in r.getMessage() for r in caplog.records)


def test_plot_registered_on_visitor():
    v = _make_visitor()
    assert "plot" in v._handlers


def test_plot_via_visitor_dispatch_preserves_code():
    from papyri.nodes import Code

    v = _make_visitor()
    ud = UnprocessedDirective(
        name="plot",
        args="",
        options={},
        value="import numpy as np\nnp.sin(0)",
        children=(),
        raw=".. plot::\n\n   import numpy as np\n   np.sin(0)",
    )
    out = v.replace_UnprocessedDirective(ud)
    assert len(out) == 1
    assert isinstance(out[0], Code)


# ---------------------------------------------------------------------------
# make_figure_handler
# ---------------------------------------------------------------------------


def test_figure_handler_external_url():
    h = make_figure_handler(None, None, "pkg", "1.0")
    out = h("https://example.com/img.png", {"alt": "logo"}, "")
    assert len(out) == 1
    assert isinstance(out[0], Image)


def test_figure_handler_with_caption(tmp_path):
    img_dir = tmp_path / "docs"
    img_dir.mkdir()
    (img_dir / "chart.png").write_bytes(b"\x89PNG fake")

    stored: dict[str, bytes] = {}
    h = make_figure_handler(img_dir, stored.__setitem__, "pkg", "1.0")

    out = h("chart.png", {}, "This is the caption.\n")
    # First node is the figure, rest is the parsed caption.
    assert len(out) >= 1
    assert isinstance(out[0], Figure)
    flat = _flatten_text(out[1:])
    assert "caption" in flat


def test_figure_handler_no_caption(tmp_path):
    img_dir = tmp_path / "docs"
    img_dir.mkdir()
    (img_dir / "chart.png").write_bytes(b"\x89PNG fake")

    stored: dict[str, bytes] = {}
    h = make_figure_handler(img_dir, stored.__setitem__, "pkg", "1.0")

    out = h("chart.png", {}, "")
    assert len(out) == 1
    assert isinstance(out[0], Figure)


def test_figure_registered_on_visitor():
    v = _make_visitor()
    assert "figure" in v._handlers


def test_figure_via_visitor_dispatch_external_url():
    v = _make_visitor()
    ud = UnprocessedDirective(
        name="figure",
        args="https://example.com/logo.png",
        options={"alt": "logo"},
        value="The project logo.",
        children=(),
        raw=".. figure:: https://example.com/logo.png\n   :alt: logo\n\n   The project logo.",
    )
    out = v.replace_UnprocessedDirective(ud)
    # Should have at least the Image node.
    assert len(out) >= 1
    assert isinstance(out[0], Image)
