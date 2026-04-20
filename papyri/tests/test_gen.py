import tempfile
from functools import lru_cache
from pathlib import Path

import pytest

from papyri.gen import APIObjectInfo, BlockExecutor, Config, Gen, NumpyDocString, _normalize_see_also


@lru_cache
def ex1():
    pass


def test_BlockExecutor():
    b = BlockExecutor({})
    b.exec("# this is a comment")


def test_find_beyond_decorators():
    """test that we find function locations

    For example the lru_decorator.
    """
    config = Config(execute_doctests=True, infer=True)
    gen = Gen(dummy_progress=True, config=config)

    api_object = APIObjectInfo("function", "", None, None, qa=None)
    doc, figs = gen.prepare_doc_for_one_object(
        ex1,
        NumpyDocString(""),
        qa="irrelevant",
        config=config,
        aliases=[],
        api_object=api_object,
    )

    assert doc.item_file.endswith("test_gen.py")


def test_infer():
    scipy = pytest.importorskip("scipy")
    from scipy._lib._uarray._backend import Dispatchable

    from papyri.gen import Config, parse_script

    c = Config(infer=True)
    res = parse_script(
        "\nx = Dispatchable(1, str)\nx",
        {"Dispatchable": Dispatchable, "scipy": scipy},
        "",
        c,
    )

    expected = (
        ("\n", ""),
        ("x", "scipy._lib._uarray._backend.Dispatchable"),
        (" ", ""),
        ("=", ""),
        (" ", ""),
        ("Dispatchable", "scipy._lib._uarray._backend.Dispatchable"),
        ("(", ""),
        ("1", ""),
        (",", ""),
        (" ", ""),
        ("str", "builtins.str"),
        (")", ""),
        ("\n", ""),
        ("x", "scipy._lib._uarray._backend.Dispatchable"),
    )

    assert list(res) == list(expected)


@pytest.mark.parametrize(
    "module, submodules, objects",
    [
        (
            "numpy",
            ("_core",),
            (
                "numpy:array",
                "numpy:histogram2d",
            ),
        ),
        ("IPython", (), ("IPython:embed_kernel",)),
    ],
)
def test_numpy(module, submodules, objects):
    config = Config(execute_doctests=False, infer=False, submodules=submodules)
    gen = Gen(dummy_progress=True, config=config)

    with tempfile.TemporaryDirectory() as tempdir:
        td = Path(tempdir)
        gen.collect_package_metadata(
            module,
            relative_dir=Path("."),
            meta={},
        )
        gen.collect_api_docs(module, limit_to=objects)
        gen.partial_write(td)

        for o in objects:
            assert (td / "module" / f"{o}.cbor").exists()


@pytest.mark.parametrize(
    "module, submodules, objects",
    [
        (
            "numpy",
            ("core",),
            ("numpy:histogram2d",),
        ),
    ],
)
def test_numpy_2(module, submodules, objects):
    config = Config(execute_doctests=False, infer=False, submodules=submodules)
    gen = Gen(dummy_progress=True, config=config)

    gen.collect_package_metadata(
        module,
        relative_dir=Path("."),
        meta={},
    )
    gen.collect_api_docs(module, limit_to=objects)
    assert tuple(gen.data.keys()) == objects
    for o in objects:
        assert gen.data[o].signature is not None


def test_self():
    from papyri.gen import Config, Gen

    c = Config(dry_run=True, dummy_progress=True)
    g = Gen(False, config=c)
    g.collect_package_metadata("papyri", ".", {})
    g.collect_api_docs("papyri", {"papyri.examples:example1", "papyri"})
    assert g.data["papyri.examples:example1"].to_dict()["signature"] == {
        "type": "signature",
        "kind": "coroutine function",
        "parameters": [
            {
                "type": "SigParam",
                "name": "pos",
                "annotation": {"data": "int", "type": "str"},
                "kind": "POSITIONAL_ONLY",
                "default": {"type": "Empty"},
            },
            {
                "type": "SigParam",
                "name": "only",
                "annotation": {"data": "None", "type": "str"},
                "kind": "POSITIONAL_ONLY",
                "default": {"type": "Empty"},
            },
            {
                "type": "SigParam",
                "name": "var",
                "annotation": {"data": "float | bool", "type": "str"},
                "kind": "POSITIONAL_OR_KEYWORD",
                "default": {"type": "Empty"},
            },
            {
                "type": "SigParam",
                "name": "args",
                "annotation": {"type": "Empty"},
                "kind": "POSITIONAL_OR_KEYWORD",
                "default": {"data": "1", "type": "str"},
            },
            {
                "type": "SigParam",
                "name": "kwarg",
                "annotation": {"type": "Empty"},
                "kind": "KEYWORD_ONLY",
                "default": {"type": "Empty"},
            },
            {
                "type": "SigParam",
                "name": "also",
                "annotation": {"type": "Empty"},
                "kind": "KEYWORD_ONLY",
                "default": {"data": "None", "type": "str"},
            },
            {
                "annotation": {"type": "Empty"},
                "default": {"type": "Empty"},
                "kind": "VAR_KEYWORD",
                "name": "kwargs",
                "type": "SigParam",
            },
        ],
        "return_annotation": {"data": "str | None", "type": "str"},
        "target_name": "example1",
    }
    assert g.data["papyri"].to_dict()["signature"] is None


def test_self_2():
    """RefInfo class should resolve its source file; private methods should not."""
    c = Config(dry_run=True, dummy_progress=True)
    g = Gen(False, config=c)
    g.collect_package_metadata("papyri", ".", {})
    g.collect_api_docs(
        "papyri", {"papyri.nodes:RefInfo", "papyri.nodes:RefInfo.__eq__"}
    )

    item_file = g.data["papyri.nodes:RefInfo"].to_dict()["item_file"]
    assert item_file is not None
    assert item_file.endswith("papyri/nodes.py")
    assert g.data["papyri.nodes:RefInfo.__eq__"].to_dict()["item_file"] is None


def test_normalize_see_also_rst_comment_description():
    """RST `..` used as placeholder description should yield an empty description.

    Some scipy docstrings use bare `..` in See Also sections, e.g.
    scipy.ndimage._measurements:minimum_position.  numpydoc passes ['..'] as
    the raw_description, which tree-sitter parses as a Comment node.  The
    SeeAlsoItem.descriptions field only accepts Paragraph nodes, so Comment
    nodes must be dropped rather than forwarded.
    """
    from papyri.nodes import Paragraph

    # Mirrors what numpydoc produces for:
    #   :func:`minimum_position`, :func:`extrema`
    #       ..
    #   :func:`standard_deviation`
    #       ..
    see_also = [
        ([("minimum_position", ""), ("extrema", "")], [".."]),
        ([("standard_deviation", "")], [".."]),
    ]
    items = _normalize_see_also(see_also, qa="test:func")
    assert len(items) == 3  # one SeeAlsoItem per name
    for item in items:
        assert item.descriptions == [], (
            f"Expected empty descriptions for '..', got {item.descriptions!r}"
        )


def test_normalize_see_also_real_description():
    """Real descriptions (non-comment) should be preserved."""
    from papyri.nodes import Paragraph

    see_also = [
        ([("minimum_position", "")], ["Finds the position of the minimum."]),
    ]
    items = _normalize_see_also(see_also, qa="test:func")
    assert len(items) == 1
    assert len(items[0].descriptions) == 1
    assert isinstance(items[0].descriptions[0], Paragraph)
