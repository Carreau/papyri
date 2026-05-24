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
- ``csv_table_handler`` (CSV table → Table node)
- ``Target`` leaf-node traversal (no crash when Target appears in section children)
"""

from __future__ import annotations

import pytest

from papyri.directives import (
    csv_table_handler,
    list_table_handler,
    literalinclude_handler,
    make_image_handler,
    only_handler,
    rubric_handler,
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


def test_obj_from_qualname_plain_function():
    fn = obj_from_qualname("papyri.directives:warn")
    from papyri.directives import warn

    assert fn is warn


def test_obj_from_qualname_class_method_returns_bound():
    # "Class.method" reference: the class is instantiated once and the returned
    # callable must be bound to that instance (has __self__ pointing at it).
    import io

    method = obj_from_qualname("io:StringIO.write")
    assert callable(method)
    assert isinstance(getattr(method, "__self__", None), io.StringIO)
    # Calling it works without passing self.
    assert method("hello") == 5


def test_obj_from_qualname_class_method_ctor_args():
    # ctor_args are forwarded to the class constructor before method lookup.
    method = obj_from_qualname("io:StringIO.getvalue", ctor_args=("seed",))
    assert method() == "seed"


def test_obj_from_qualname_class_method_ctor_kwargs():
    method = obj_from_qualname(
        "io:StringIO.getvalue", ctor_kwargs={"initial_value": "seed"}
    )
    assert method() == "seed"


def test_obj_from_qualname_class_itself_unchanged():
    # When the path ends on the class (no trailing attribute), return the class.
    import io

    cls = obj_from_qualname("io:StringIO")
    assert cls is io.StringIO


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
    # is the title and whose reference is a LocalRef docs link.
    para = items[0].children[0]
    crossref = para.children[0]
    assert isinstance(crossref, CrossRef)
    assert crossref.value == "Getting Started"
    assert isinstance(crossref.reference, LocalRef)
    assert crossref.reference.kind == "docs"
    assert crossref.reference.path == "intro"


def test_toctree_resolves_relative_to_current_doc():
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


def test_toctree_absolute_path_anchored_at_root():
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


def test_toctree_strips_rst_extension():
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


def test_toctree_not_hidden_produces_crossref_links():
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


def test_toctree_uses_doc_title_for_display_text():
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


def test_toctree_falls_back_to_path_when_title_unknown():
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


def test_toctree_explicit_title_wins_over_doc_title():
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


def test_toctree_doc_title_lookup_uses_resolved_doc_key():
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


def test_toctree_nested_path_uses_colon_separator():
    # Toctree entries like "whatsnew/index" must become LocalRef("docs",
    # "whatsnew:index") so the viewer's linkForDoc produces the correct URL.
    v = _make_visitor()
    out = v._toctree_handler(argument=None, options={}, content="whatsnew/index")
    crossref = out[0].children[0].children[0].children[0]
    assert isinstance(crossref.reference, LocalRef)
    assert crossref.reference.path == "whatsnew:index"


def test_toctree_titled_nested_path_uses_colon_separator():
    v = _make_visitor()
    out = v._toctree_handler(
        argument=None, options={}, content="What's New <whatsnew/index>"
    )
    crossref = out[0].children[0].children[0].children[0]
    assert isinstance(crossref.reference, LocalRef)
    assert crossref.reference.path == "whatsnew:index"


def test_toctree_hidden_returns_no_visible_output():
    # hidden=True suppresses inline rendering while still recording the TOC
    # data so it can be used for navigation metadata.
    v = _make_visitor()
    content = "intro\nadvanced"
    out = v._toctree_handler(argument=None, options={"hidden": True}, content=content)
    assert out == []
    # The toc data is still stored for navigation use.
    assert len(v._tocs) == 1
    assert len(v._tocs[0]) == 2


def test_toctree_hidden_false_explicit_produces_links():
    # Passing hidden=False explicitly should behave like the default.
    v = _make_visitor()
    out = v._toctree_handler(argument=None, options={"hidden": False}, content="page1")
    assert len(out) == 1
    assert len(out[0].children) == 1


def test_toctree_maxdepth_option_is_accepted():
    # maxdepth is a common Sphinx option; the handler must not raise.
    v = _make_visitor()
    out = v._toctree_handler(
        argument=None, options={"maxdepth": 2}, content="chapter1\nchapter2"
    )
    assert len(out) == 1
    assert len(out[0].children) == 2


def test_toctree_numbered_option_is_accepted():
    v = _make_visitor()
    out = v._toctree_handler(
        argument=None, options={"numbered": True}, content="chapter1"
    )
    assert len(out) == 1
    assert len(out[0].children) == 1


def test_toctree_titlesonly_option_is_accepted():
    v = _make_visitor()
    out = v._toctree_handler(
        argument=None, options={"titlesonly": True}, content="chapter1"
    )
    assert len(out) == 1
    assert len(out[0].children) == 1


def test_toctree_includehidden_option_is_accepted():
    v = _make_visitor()
    out = v._toctree_handler(
        argument=None, options={"includehidden": True}, content="chapter1"
    )
    assert len(out) == 1
    assert len(out[0].children) == 1


def test_toctree_empty_content_returns_empty_bullet_list():
    v = _make_visitor()
    out = v._toctree_handler(argument=None, options={}, content="")
    assert len(out) == 1
    assert len(out[0].children) == 0


def test_toctree_empty_content_hidden_returns_empty_list():
    v = _make_visitor()
    out = v._toctree_handler(argument=None, options={"hidden": True}, content="")
    assert out == []


def test_toctree_hidden_with_maxdepth_returns_no_visible_output():
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


# ---------------------------------------------------------------------------
# seealso directive
# ---------------------------------------------------------------------------


def test_seealso_directive_produces_admonition():
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


def test_seealso_directive_empty_content_produces_admonition():
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


def test_ref_role_known_label_emits_crossref_to_localref():
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


def test_ref_role_titled_form_uses_explicit_text():
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


def test_ref_role_unknown_label_returns_directive_unchanged():
    # An unresolved :ref: must pass through as an InlineRole rather than crash.
    v = _make_visitor_with_targets({})
    role = InlineRole(domain=None, role="ref", value="no-such-label")
    out = v.replace_InlineRole(role)
    assert len(out) == 1
    assert isinstance(out[0], InlineRole)


def test_ref_role_cross_doc_resolves_to_correct_doc_key():
    # Label defined in a different doc within the same bundle.
    v = _make_visitor_with_targets({"zmq-architecture": "internals:zmq"})
    role = InlineRole(domain=None, role="ref", value="zmq-architecture")
    out = v.replace_InlineRole(role)
    cr = out[0]
    assert isinstance(cr, CrossRef)
    assert cr.reference.path == "internals:zmq"


def test_plain_hyperlink_angle_bracket_resolves_doc_target():
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


def test_plain_hyperlink_angle_bracket_unresolved_does_not_crash():
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


def test_target_node_passes_through_generic_visit():
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


def test_named_hyperlink_resolves_to_external_link():
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


def test_named_hyperlink_angle_bracket_uses_display_text():
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


def test_embedded_uri_autolink_produces_link():
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


def test_simple_hyperlink_reference_trailing_underscore_resolves():
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


def test_named_hyperlink_unknown_label_falls_through():
    # Unrecorded label must not be silently turned into a Link; falls through
    # to the existing resolution path (returns directive unchanged).
    v = _make_visitor_with_external({})
    role = InlineRole(domain=None, role=None, value="no-such-label")
    out = v.replace_InlineRole(role)
    assert len(out) == 1


def test_section_with_mixed_children_traverses_target():
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


def test_list_table_basic_shape():
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


def test_list_table_header_rows_marks_first_row():
    out = list_table_handler("", {"header-rows": "1"}, _list_table_content())
    table = out[0]
    assert table.children[0].header is True
    assert table.children[1].header is False
    assert table.children[2].header is False


def test_list_table_no_header_rows_option_defaults_to_zero():
    out = list_table_handler("", {}, _list_table_content())
    table = out[0]
    assert all(row.header is False for row in table.children)


def test_list_table_cell_contents_are_flow_nodes():
    out = list_table_handler("", {"header-rows": "1"}, _list_table_content())
    table = out[0]
    cell = table.children[0].children[0]
    # First cell holds a Paragraph(Text("Header A")).
    para = cell.children[0]
    assert isinstance(para, Paragraph)
    inline = para.children[0]
    assert isinstance(inline, Text)
    assert inline.value == "Header A"


def test_list_table_caption_emitted_as_paragraph():
    out = list_table_handler("My Caption", {}, _list_table_content())
    assert len(out) == 2
    caption = out[0]
    assert isinstance(caption, Paragraph)
    inline = caption.children[0]
    assert isinstance(inline, Text)
    assert inline.value == "My Caption"
    assert isinstance(out[1], Table)


def test_list_table_empty_body_returns_nothing():
    assert list_table_handler("", {}, "") == []
    assert list_table_handler("", {}, "   \n  \n") == []


def test_list_table_registered_on_visitor():
    v = _make_visitor()
    assert "list-table" in v._handlers


def test_list_table_via_full_directive_pipeline():
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
    assert title.children[0].value == "References"


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
