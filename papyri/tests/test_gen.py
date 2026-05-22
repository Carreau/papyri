import tempfile
from functools import lru_cache
from pathlib import Path

import pytest

from papyri.config_loader import Config
from papyri.doc import GeneratedDoc, _normalize_see_also
from papyri.executors import BlockExecutor
from papyri.gen import APIObjectInfo, Gen
from papyri.numpydoc_compat import NumpyDocString
from papyri.utils import strip_clinic_signature


@lru_cache
def ex1():
    pass


def test_BlockExecutor():
    b = BlockExecutor({})
    b.exec("# this is a comment")


def test_generated_doc_new():
    """ClassVar annotations on GeneratedDoc must not shift positional args.

    Regression: adding `sections: ClassVar[list[str]]` caused get_type_hints to
    include `sections` as the first entry, shifting all positional arguments by
    one so that `_ordered_sections` received None instead of [].
    """
    doc = GeneratedDoc.new()
    assert isinstance(doc._ordered_sections, (list, tuple)), doc._ordered_sections
    assert isinstance(doc._content, dict), doc._content


def test_find_beyond_decorators():
    """test that we find function locations

    For example the lru_decorator.
    """
    config = Config(execute_doctests=True, infer=True)
    gen = Gen(dummy_progress=True, config=config)

    api_object = APIObjectInfo("function", "", None, "test_example", qa="test")
    doc, _figs = gen.prepare_doc_for_one_object(
        ex1,
        NumpyDocString(""),
        qa="irrelevant",
        config=config,
        aliases=[],
        api_object=api_object,
    )

    assert doc.item_file is not None
    assert doc.item_file.endswith("test_gen.py")


def test_infer():
    pytest.importorskip("scipy")
    from scipy.linalg import LinAlgError

    from papyri.config_loader import Config
    from papyri.tokens import parse_script

    c = Config(infer=True)
    res = parse_script(
        "\nx = LinAlgError('test')\nx",
        {"LinAlgError": LinAlgError},
        "",
        c,
    )

    if res is None:
        pytest.skip("jedi could not infer types")

    assert res is not None
    results = list(res)
    x_fqns = [fqn for token, fqn in results if token == "x" and fqn]
    assert x_fqns, f"Expected jedi to infer a type for 'x': {results}"
    assert all("LinAlgError" in fqn for fqn in x_fqns), x_fqns


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
            assert (td / "module" / f"{o}.json").exists()


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
    from papyri.config_loader import Config
    from papyri.gen import Gen

    c = Config(dry_run=True, dummy_progress=True, execute_doctests=False)
    g = Gen(False, config=c)
    g.collect_package_metadata("papyri", ".", {})
    g.collect_api_docs("papyri", list({"papyri.examples:example1", "papyri"}))
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
                "annotation": {"data": "int", "type": "str"},
                "kind": "POSITIONAL_OR_KEYWORD",
                "default": {"data": "1", "type": "str"},
            },
            {
                "type": "SigParam",
                "name": "kwarg",
                "annotation": {"data": "Any", "type": "str"},
                "kind": "KEYWORD_ONLY",
                "default": {"type": "Empty"},
            },
            {
                "type": "SigParam",
                "name": "also",
                "annotation": {"data": "Any", "type": "str"},
                "kind": "KEYWORD_ONLY",
                "default": {"data": "None", "type": "str"},
            },
            {
                "annotation": {"data": "Any", "type": "str"},
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
    c = Config(dry_run=True, dummy_progress=True, execute_doctests=False)
    g = Gen(False, config=c)
    g.collect_package_metadata("papyri", ".", {})
    g.collect_api_docs(
        "papyri", list({"papyri.nodes:RefInfo", "papyri.nodes:RefInfo.__eq__"})
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
    # Mirrors what numpydoc produces for:
    #   :func:`minimum_position`, :func:`extrema`
    #       ..
    #   :func:`standard_deviation`
    #       ..
    see_also = [
        ([("minimum_position", ""), ("extrema", "")], [".."]),
        ([("standard_deviation", "")], [".."]),
    ]
    items = _normalize_see_also(see_also, qa="test:func")  # type: ignore[arg-type]
    assert len(items) == 3  # one SeeAlsoItem per name
    for item in items:
        assert len(item.descriptions) == 0, (
            f"Expected empty descriptions for '..', got {item.descriptions!r}"
        )


def test_kaiser_bessel_derived_example_has_figure_and_code():
    """kaiser_bessel_derived examples must produce at least one figure and one code block.

    The docstring contains a matplotlib plot executed via doctest.  We call
    get_example_data directly (bypassing APIObjectInfo construction, which raises
    WrongTypeAtField for this function and would abort the normal gen pipeline).
    wait_for_plt_show=False ensures figures are captured even if the example
    omits an explicit plt.show() call.
    """
    pytest.importorskip("scipy")
    pytest.importorskip("matplotlib")

    from scipy.signal.windows import kaiser_bessel_derived

    from papyri.gen import Gen
    from papyri.nodes import Figure, GenCode
    from papyri.numpydoc_compat import NumpyDocString
    from papyri.utils import dedent_but_first

    qa = "scipy.signal.windows._windows:kaiser_bessel_derived"
    config = Config(execute_doctests=True, infer=False, wait_for_plt_show=False)
    gen = Gen(dummy_progress=True, config=config)
    gen.root = "scipy"
    gen.version = "test"

    ndoc = NumpyDocString(dedent_but_first(kaiser_bessel_derived.__doc__))
    examples = ndoc["Examples"]
    assert examples, "kaiser_bessel_derived has no Examples section"

    section, _figs = gen.get_example_data(
        examples,
        obj=kaiser_bessel_derived,
        qa=qa,
        config=config,
        log=gen.log,
    )

    children = section.children
    assert any(isinstance(c, Figure) for c in children), (
        "Expected at least one Figure in kaiser_bessel_derived examples"
    )
    assert any(isinstance(c, GenCode) for c in children), (
        "Expected at least one code block in kaiser_bessel_derived examples"
    )


def _fn_with_syntax_error_example():
    """A function whose example triggers an unexpected exception.

    Examples
    --------
    >>> [this is syntax error]
    """


def test_get_example_data_unexpected_exception_is_str():
    """report_unexpected_exception must store a str in GenCode.out.

    Regression: previously the raw `(type, value, traceback)` tuple from
    doctest was stored as `Code.out`, which is typed as `str`. The
    post-processing type check then rejected the whole example with
    "Wrong type at field ... expecting str got tuple", and the example
    was silently skipped.
    """
    from papyri.gen import Gen
    from papyri.nodes import GenCode

    qa = "papyri.tests.test_gen:_fn_with_syntax_error_example"
    config = Config(execute_doctests=True, infer=False, wait_for_plt_show=False)
    gen = Gen(dummy_progress=True, config=config)
    gen.root = "papyri"
    gen.version = "test"

    ndoc = NumpyDocString(_fn_with_syntax_error_example.__doc__)
    examples = ndoc["Examples"]
    assert examples

    section, _figs = gen.get_example_data(
        examples,
        obj=_fn_with_syntax_error_example,
        qa=qa,
        config=config,
        log=gen.log,
    )

    code_blocks = [c for c in section.children if isinstance(c, GenCode)]
    assert code_blocks, "Expected at least one GenCode block"
    assert any(
        isinstance(c.out, str) and "SyntaxError" in c.out for c in code_blocks
    ), (
        f"Expected a formatted SyntaxError str in GenCode.out; got {[(type(c.out), c.out) for c in code_blocks]!r}"
    )


def test_normalize_see_also_real_description():
    """Real descriptions (non-comment) should be preserved."""
    from papyri.nodes import Paragraph

    see_also = [
        ([("minimum_position", "")], ["Finds the position of the minimum."]),
    ]
    items = _normalize_see_also(see_also, qa="test:func")  # type: ignore[arg-type]
    assert len(items) == 1
    assert len(items[0].descriptions) == 1
    assert isinstance(items[0].descriptions[0], Paragraph)


# ---------------------------------------------------------------------------
# strip_clinic_signature
# ---------------------------------------------------------------------------


def test_strip_clinic_signature_strips_prefix():
    doc = "MyClass(x, y=1)\n--\n\nDescription here."
    assert strip_clinic_signature(doc) == "Description here."


def test_strip_clinic_signature_no_prefix():
    doc = "Just a plain docstring.\n\nNo clinic header."
    assert strip_clinic_signature(doc) == doc


def test_strip_clinic_signature_double_dash_not_on_line2():
    # '--' appearing later in the doc must not be stripped
    doc = "First line.\nSecond line.\n--\n\nBody."
    assert strip_clinic_signature(doc) == doc


def test_strip_clinic_signature_empty():
    assert strip_clinic_signature("") == ""


def test_strip_clinic_signature_only_header_no_body():
    doc = "Func()\n--\n"
    assert strip_clinic_signature(doc) == ""


def test_strip_clinic_signature_leading_blank_stripped():
    # Body typically starts with a blank line after '--'; that blank is removed.
    doc = "Func(a, b)\n--\n\nActual body."
    result = strip_clinic_signature(doc)
    assert not result.startswith("\n")
    assert result == "Actual body."


# ---------------------------------------------------------------------------
# Integration: C extension types with clinic signatures must not fail gen
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "qa",
    [
        "numpy:dtype",
        "numpy.dtypes:BoolDType",
        "numpy.dtypes:Int8DType",
    ],
)
def test_clinic_signature_objects_are_generated(qa):
    """C extension types whose __doc__ has a clinic prefix must not be skipped.

    Before the fix, extract_docstring raised TreeSitterParseError for these
    objects because tree-sitter RST misread the '--' separator as a too-short
    section underline.  The objects were silently dropped from gen.data.
    """
    from papyri.nodes import Paragraph, Text

    pytest.importorskip("numpy")
    dotted, _, _ = qa.partition(":")
    module = dotted.split(".")[0]
    config = Config(execute_doctests=False, infer=False, submodules=())
    gen = Gen(dummy_progress=True, config=config)
    gen.collect_package_metadata(module, relative_dir=Path("."), meta={})
    gen.collect_api_docs(module, limit_to=(qa,))
    assert qa in gen.data, (
        f"{qa} was dropped from gen.data (clinic prefix not stripped)"
    )
    # The numpydoc Summary section must contain meaningful content, not the
    # bare '--' separator that was the symptom of an unstripped clinic prefix.
    summary = gen.data[qa]._content.get("Summary", ())
    assert summary, f"{qa}: Summary section is empty"
    first = summary[0]
    assert isinstance(first, Paragraph), (
        f"{qa}: Summary[0] is not a Paragraph: {first!r}"
    )
    texts = [c.value for c in first.children if isinstance(c, Text)]
    assert "--" not in texts, (
        f"{qa}: Summary contains bare '--' (clinic separator not stripped)"
    )
