"""
Robustness tests for ``papyri.toc`` (narrative TOC assembly).

These cover small pure-function surfaces that had regressions in Phase 4
(no "index" root document, malformed entries, glob expansion) and make sure
those guarantees don't silently disappear.
"""

import pytest

from papyri.toc import _tree, dotdotcount, flatten, make_tree


def test_flatten_concatenates_sublists():
    data = {
        "a": [[("x", "p1"), ("y", "p2")], [("z", "p3")]],
        "b": [],
    }
    out = flatten(data)
    assert out == {
        "a": [("x", "p1"), ("y", "p2"), ("z", "p3")],
        "b": [],
    }


def test_dotdotcount_no_dotdot():
    n, parts = dotdotcount(["a", "b", "c"])
    assert n == 0
    assert parts == ["a", "b", "c"]


def test_dotdotcount_leading_dotdot():
    n, parts = dotdotcount(["..", "..", "a", "b"])
    assert n == 2
    assert parts == ["a", "b"]


def test_dotdotcount_rejects_non_leading():
    with pytest.raises(AssertionError):
        dotdotcount(["a", "..", "b"])


def test_make_tree_empty_input_returns_empty_dict():
    # No entries collected — must not crash, must return an empty tree.
    assert make_tree({}) == {}


def test_make_tree_prefers_index_root():
    # Sphinx-style layout: "index" exists and references the other docs.
    data = {
        "index": [[(None, "tutorial"), (None, "api")]],
        "tutorial": [],
        "api": [],
    }
    tree = make_tree(data)
    assert set(tree.keys()) == {"tutorial", "api"}


def test_make_tree_falls_back_to_unreferenced_root(caplog):
    # IPython-style: no "index" key; pick the unique unreferenced node.
    data = {
        "whatsnew": [[(None, "tutorial"), (None, "api")]],
        "tutorial": [],
        "api": [],
    }
    with caplog.at_level("WARNING", logger="papyri"):
        tree = make_tree(data)
    assert set(tree.keys()) == {"tutorial", "api"}
    # The fallback must say so — otherwise a silent choice makes debugging hard.
    assert any("no 'index' root found" in r.getMessage() for r in caplog.records)


def test_tree_skips_absolute_paths(capsys):
    counter = {"index": 0, "sub": 0}
    data = {"index": ["/absolute/path", "sub"], "sub": []}
    result = _tree("index", data, counter)
    # absolute paths are dropped; only the relative "sub" remains
    assert list(result.keys()) == ["sub"]
    captured = capsys.readouterr()
    assert "absolute path" in captured.out


def test_tree_skips_external_urls():
    counter = {"index": 0, "sub": 0}
    data = {"index": ["https://example.org/docs", "sub"], "sub": []}
    result = _tree("index", data, counter)
    assert list(result.keys()) == ["sub"]


def test_tree_strips_rst_suffix():
    counter = {"index": 0, "chapter": 0}
    data = {"index": ["chapter.rst"], "chapter": []}
    result = _tree("index", data, counter)
    assert "chapter" in result


def test_tree_appends_index_for_trailing_slash():
    counter = {"index": 0, "sub:index": 0}
    data = {"index": ["sub/"], "sub:index": []}
    result = _tree("index", data, counter)
    assert "sub:index" in result
