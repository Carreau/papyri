"""
Tests for ``papyri.tree``: small pieces of the gen-time/ingest-time IR
transformation that are easy to pin and have historically regressed.

Covered surfaces:
- ``py_doc_handler`` (:doc: role → LocalRef("docs", path))
- ``DelayedResolver`` (target/reference unification)
- ``_toctree_handler`` (blank lines, comments, glob, hidden, malformed entries, LocalRef links)
- ``_SPHINX_ONLY_DIRECTIVES`` (silent drop via warning)
- ``:ref:`` role resolution via doc_targets map
- ``Target`` leaf-node traversal (no crash when Target appears in section children)
"""

from __future__ import annotations

import pytest

from papyri.directives import make_image_handler
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
    Target,
    Text,
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


def _make_visitor_with_targets(doc_targets: dict) -> DirectiveVisiter:
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


def _make_visitor_with_external(external_targets: dict) -> DirectiveVisiter:
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
