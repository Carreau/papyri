"""
Main module responsible from scrapping the code, docstrings, an (TBD) rst files,
and turning that into intermediate representation files that can be published.

This also does some code execution, and inlining of figures, though that should
likely be separated into a separate module at some point.


"""

from __future__ import annotations

import doctest
import inspect
import io
import json
import logging
import os
import site
import sys
import tempfile
import warnings
from collections import defaultdict
from functools import lru_cache
from hashlib import sha256
from itertools import count
from pathlib import Path
from types import FunctionType, ModuleType
from typing import (
    Any,
)

import tomli_w
from IPython.core.oinspect import find_file
from IPython.utils.path import compress_user
from matplotlib import _pylab_helpers
from packaging.version import parse
from rich.logging import RichHandler
from rich.progress import BarColumn, TextColumn

log = logging.getLogger("papyri")

from ._progress import TimeElapsedColumn, iter_with_progress, progress_class
from .config_loader import Config, load_configuration
from .doc import (
    GeneratedDoc,
    _first_paragraph_text,
    _normalize_see_also,
    _numpy_data_to_section,
)
from .error_collector import ErrorCollector
from .errors import (
    IncorrectInternalDocsLen,
    NumpydocParseError,
    TextSignatureParsingFailed,
)
from .executors import BlockExecutor
from .nodes import (
    DocParam,
    Figure,
    GenCode,
    GenToken,
    LocalRef,
    NumpydocExample,
    NumpydocSeeAlso,
    NumpydocSignature,
    Parameters,
    RefInfo,
    Section,
    Text,
    TocTree,
    parse_rst_section,
)
from .numpydoc_compat import NumpyDocString
from .signature import Signature as ObjectSignature
from .toc import make_tree
from .tokens import _add_classes, parse_script
from .tree import GenVisitor
from .utils import (
    Canonical,
    FullQual,
    dedent_but_first,
    full_qual,
    obj_from_qualname,
)

try:
    from . import ts
except (ImportError, OSError):
    sys.exit("""
            Tree Sitter RST parser not available; reinstall papyri to pull
            the `tree-sitter` and `tree-sitter-language-pack` wheels from PyPI:

            $ pip install -e .
            """)
SITE_PACKAGE = site.getsitepackages()


from enum import Enum


class ExecutionStatus(Enum):
    success = "success"
    failure = "failure"
    unexpected_exception = "unexpected_exception"
    none = "none"
    compiled = "compiled"
    syntax_error = "syntax_error"


def _execute_inout(item):
    script = "\n".join(item.in_)
    ce_status = ExecutionStatus.none
    try:
        compile(script, "<>", "exec")
        ce_status = ExecutionStatus.compiled
    except SyntaxError:
        ce_status = ExecutionStatus.syntax_error

    return script, item.out, ce_status.value


def _get_implied_imports(obj):
    """
    Most examples in methods or modules needs names defined in current module,
    or name of the class they are part of.
    """
    if hasattr(obj, "__qualname__"):
        if "." not in obj.__qualname__:
            return {}
        else:
            c_o = obj.__qualname__.split(".")
            if len(c_o) > 2:
                log.debug(
                    "get implied import qualname got more than 2 parts: %s",
                    obj.__qualname__,
                )
                return {}
            cname, _oname = c_o
            mod_name = obj.__module__
            import importlib

            mod = importlib.import_module(mod_name)
            return {cname: getattr(mod, cname)}

    return {}


def processed_example_data(example_section_data) -> Section:
    """this should be no-op on already ingested"""
    new_example_section_data = Section([], None)
    # Historical note: this used to strip nodes of an old `take2.Text` class
    # distinct from MText (now Text). That class no longer exists, so the
    # filter has become a passthrough.
    for in_out in example_section_data:
        new_example_section_data.append(in_out)
    return new_example_section_data


@lru_cache
def normalise_ref(ref):
    """
    Consistently normalize references.

    Refs are sometime import path, not fully qualified names, tough type
    inference in examples regularly give us fully qualified names. When visiting
    a ref, this tries to import it and replace it by the normal full-qualified form.

    This is expensive, and we likely want to move the logic of finding the
    correct ref earlier in the process and use this as an assertion the refs are
    normalized.

    It is critical to normalize in order to have the correct information when
    using interactive ?/??, or similar inspector of live objects;

    """
    if ref.startswith(("builtins.", "__main__")):
        return ref
    try:
        mod_name, name = ref.rsplit(".", maxsplit=1)
        mod = __import__(mod_name)
        for sub in mod_name.split(".")[1:]:
            mod = getattr(mod, sub)
        obj = getattr(mod, name)
        if isinstance(obj, ModuleType):
            return ref
        if getattr(obj, "__name__", None) is None:
            return ref

        return obj.__module__ + "." + obj.__name__
    except Exception:
        pass
    return ref


def gen_main(
    infer: bool | None,
    exec_: bool | None,
    target_file: str,
    debug,
    *,
    dummy_progress: bool,
    dry_run: bool,
    api: bool,
    examples: bool,
    fail,
    narrative,
    fail_early: bool,
    fail_unseen_error: bool,
    limit_to: list[str],
) -> None:
    """
    Main entry point to generate DocBundle files.

    This will take care of reading single configuration files with the options
    for the library you want to build the docs for, scrape API, narrative and
    examples, and put it into a doc bundle for later consumption.

    Parameters
    ----------
    infer : bool | None
        CLI override of whether to run type inference on examples
    exec_ : bool | None
        CLI override of whether to execute examples/code blocks
    target_file : str
        Patch of configuration file
    dummy_progress : bool
        CLI flag to disable progress that might screw up with ipdb formatting
        when debugging.
    api : bool
        CLI override of whether to build api docs
    examples : bool
        CLI override of whether to build examples docs
    fail
        TBD
    narrative : bool
        CLI override of whether to build narrative docs
    dry_run : bool
        don't write to disk
    debug : bool
        set log level to debug
    fail_early : bool
        overwrite early_error option in config file
    fail_unseen_error : bool
        raise an exception if the error is unseen

    Returns
    -------
    None

    """
    if limit_to is None:
        limit_to = set()
    target_module_name, conf, meta = load_configuration(target_file)

    conf["early_error"] = fail_early
    conf["fail_unseen_error"] = fail_unseen_error
    config = Config(**conf, dry_run=dry_run, dummy_progress=dummy_progress)
    if exec_ is not None:
        config.execute_doctests = exec_
    if infer is not None:
        config.infer = infer

    target_dir = Path("~/.papyri/data").expanduser()

    if not target_dir.exists() and not config.dry_run:
        target_dir.mkdir(parents=True, exist_ok=True)
    if dry_run:
        temp_dir = tempfile.TemporaryDirectory()
        target_dir = Path(temp_dir.name)

    g = Gen(dummy_progress=dummy_progress, config=config)

    if debug:
        g.log.setLevel(logging.DEBUG)
        g.log.debug("Log level set to debug")

    g.collect_package_metadata(
        target_module_name,
        relative_dir=Path(target_file).parent,
        meta=meta,
    )

    g.log.info("Target package is %s-%s", target_module_name, g.version)
    g.log.info("Will write data to %s", target_dir)

    if examples:
        g.collect_examples_out()
    if api:
        g.collect_api_docs(target_module_name, limit_to=limit_to)
    if narrative:
        g.collect_narrative_docs()

    p = target_dir / (g.root + "_" + g.version)
    p.mkdir(exist_ok=True)

    g.log.info("Saving current Doc bundle to %s", p)
    if not limit_to:
        g.clean(p)
        g.write(p)
    else:
        g.partial_write(p)
    if dry_run:
        temp_dir.cleanup()


class DFSCollector:
    """
    Depth first search collector.

    Will scan documentation to find all reachable items in the namespace
    of our root object (we don't want to go scan other libraries).

    Three was some issues with BFS collector originally, I'm not sure I remember what.


    """

    def __init__(self, root: ModuleType, others: list[ModuleType]):
        """
        Parameters
        ----------
        root
            Base object, typically module we want to scan itself.
            We will attempt to no scan any object which does not belong
            to the root or one of its children.
        others
            List of other objects to use a base to explore the object graph.
            Typically this is because some packages do not import some
            submodules by default, so we need to pass these submodules
            explicitly.
        """

        assert isinstance(root, ModuleType), root
        self.root = root.__name__
        assert "." not in self.root
        self.obj: dict[str, Any] = dict()
        self.aliases: dict[str, list[str]] = defaultdict(lambda: [])
        self._open_list = [(root, [root.__name__])]
        for o in others:
            self._open_list.append((o, o.__name__.split(".")))
        self.log = logging.getLogger("papyri")

    def scan(self) -> None:
        """
        Attempt to find all objects.
        """
        seen: set[int] = set()
        while self._open_list:
            current, stack = self._open_list.pop(0)

            # numpy objects have no bool values.
            if id(current) not in seen:
                seen.add(id(current))
                self.visit(current, stack)

    def prune(self) -> None:
        """
        Some object can be reached many times via multiple path.
        We try to remove duplicate path we use to reach given objects.

        Notes
        -----
        At some point we might want to save all objects aliases,
        in order to extract the canonical import name (visible to users),
        and to resolve references.
        """
        for qa, item in self.obj.items():
            if (nqa := full_qual(item)) != qa:
                log.debug("after import qa differs: %s -> %s", qa, nqa)
                assert isinstance(nqa, str)
                if self.obj[nqa] == item:
                    log.debug("present twice")
                    del self.obj[nqa]
                else:
                    log.debug("differs: %r != %r", item, self.obj.get(nqa))

    def items(self) -> dict[str, Any]:
        self.scan()
        self.prune()
        return self.obj

    def visit(self, obj, stack):
        """
        Recursively visit Module, Classes, and Functions by tracking which path
        we took there.
        """

        try:
            qa = full_qual(obj)
        except Exception as e:
            raise RuntimeError(f"error visiting {'.'.join(stack)}") from e
        if not qa:
            if (
                "__doc__" not in stack
                and hasattr(obj, "__doc__")
                and not full_qual(type(obj)).startswith("builtins.")  # type: ignore[union-attr]
            ):
                # might be worth looking into like np.exp.
                pass
            return

        if ":" in qa:
            omod, _name = qa.split(":")
        else:
            omod = qa

        oroot = omod.split(".")[0] if "." in omod else omod

        if oroot != self.root:
            return
        if obj in self.obj.values():
            return
        if (qa in self.obj) and self.obj[qa] != obj:
            pass

        self.obj[qa] = obj
        self.aliases[qa].append(".".join(stack))

        if isinstance(obj, ModuleType):
            return self.visit_ModuleType(obj, stack)
        elif isinstance(obj, FunctionType):
            return self.visit_FunctionType(obj, stack)
        elif isinstance(obj, type):
            return self.visit_ClassType(obj, stack)
        else:
            pass

    def visit_ModuleType(self, mod, stack):
        for k in dir(mod):
            # Defensive: modules with a custom __dir__ / __getattr__ can list
            # names that aren't actually resolvable, or raise non-AttributeError
            # exceptions (e.g. scipy raises ModuleNotFoundError from __getattr__).
            # Log at DEBUG — observable under verbose tracing, not end-user noise.
            try:
                val = getattr(mod, k)
            except Exception as e:
                self.log.debug("Could not access %s.%s: %s", mod.__name__, k, e)
                continue
            self._open_list.append((val, [*stack, k]))

    def visit_ClassType(self, klass, stack):
        for k, v in klass.__dict__.items():
            self._open_list.append((v, [*stack, k]))

    def visit_FunctionType(self, fun, stack):
        pass

    def compute_aliases(self) -> tuple[dict[FullQual, Canonical], list[Any]]:
        aliases = {}
        not_found = []
        for k, v in self.aliases.items():
            if [item for item in v if item != k]:
                if shorter := find_canonical(k, v):
                    aliases[FullQual(k)] = Canonical(shorter)
                else:
                    not_found.append((k, v))
        return aliases, not_found


_numpydoc_sections_with_param = {
    "Parameters",
    "Returns",
    "Raises",
    "Yields",
    "Attributes",
    "Other Parameters",
    "Warns",
    "Methods",
    "Receives",
}

_numpydoc_sections_with_text = {
    "Summary",
    "Notes",
    "Extended Summary",
    "References",
    "Warnings",
}


class APIObjectInfo:
    """
    Describes the object's type and other relevant information

    This object can be many things, such as a Module, Class, method, function.

    """

    kind: str
    docstring: str
    signature: ObjectSignature | None
    name: str

    def __repr__(self):
        return f"<APIObject {self.kind=} {self.docstring=} self.signature={self.signature!s} {self.name=}>"

    def __init__(
        self,
        kind: str,
        docstring: str,
        signature: ObjectSignature | None,
        name: str,
        qa: str,
    ):
        assert isinstance(signature, (ObjectSignature, type(None)))
        self.kind = kind
        self.name = name
        self.docstring = docstring
        self.parsed: list[Any] = []
        self.signature = signature
        self._qa = qa

        if docstring is not None and kind != "module":
            # TS is going to choke on this as See Also and other
            # sections are technically invalid.
            try:
                ndoc = NumpyDocString(dedent_but_first(docstring))
            except Exception as e:
                raise NumpydocParseError("APIObjectInfoParse Error in numpydoc") from e

            for title in ndoc.ordered_sections:
                if not ndoc[title]:
                    continue
                if title in _numpydoc_sections_with_param:
                    section = _numpy_data_to_section(ndoc[title], title, self._qa)
                    assert isinstance(section, Section)
                    self.parsed.append(section)
                elif title in _numpydoc_sections_with_text:
                    predoc = "\n".join(ndoc[title])
                    docs = ts.parse(predoc.encode(), qa)
                    if len(docs) != 1:
                        # TODO
                        # potential reasons
                        # Summary and Extended Summary should be parsed as one.
                        # References with ` : ` in them fail parsing.Issue opened in Tree-sitter.
                        raise IncorrectInternalDocsLen(predoc, docs)
                    section = docs[0]
                    assert isinstance(section, Section), section
                    self.parsed.append(section)
                elif title == "Signature":
                    self.parsed.append(NumpydocSignature(ndoc[title]))
                elif title == "Examples":
                    self.parsed.append(NumpydocExample(ndoc[title]))
                elif title == "See Also":
                    see_also = ndoc[title]
                    xx = NumpydocSeeAlso(_normalize_see_also(see_also, qa="??"))
                    self.parsed.append(xx)
                else:
                    raise AssertionError
        elif docstring and kind == "module":
            self.parsed = ts.parse(docstring.encode(), qa)
        self.validate()

    def special(self, title):
        if self.kind == "module":
            return None
        res = [s for s in self.parsed if s.title == title]
        if not res:
            return None
        assert len(res) == 1
        assert not isinstance(res[0], Section), self.parsed
        return res[0]

    def validate(self):
        for p in self.parsed:
            assert isinstance(
                p, (Section, NumpydocExample, NumpydocSeeAlso, NumpydocSignature)
            )
            p.validate()


class PapyriDocTestRunner(doctest.DocTestRunner):
    def __init__(self, *args, gen, obj, qa, config, **kwargs):
        self._count = count(0)
        self.gen = gen
        self.obj = obj
        self.qa = qa
        self.config = config
        self._example_section_data = Section([], None)
        super().__init__(*args, **kwargs)
        import matplotlib
        import matplotlib.pyplot as plt
        import numpy as np

        matplotlib.use("agg")

        self.globs = {"np": np, "plt": plt, obj.__name__: obj}
        self.globs.update(_get_implied_imports(obj))
        for k, v in config.implied_imports.items():
            self.globs[k] = obj_from_qualname(v)

        self.figs = []

    def _get_tok_entries(self, example):
        entries = parse_script(
            example.source, ns=self.globs, prev="", config=self.config, where=self.qa
        )
        if entries is None:
            entries = [("jedi failed", "jedi failed")]
        entries = _add_classes(entries)
        tok_entries = [GenToken(*x) for x in entries]
        return tok_entries

    def _next_figure_name(self):
        """
        File system can be case insensitive, we are not.
        """
        i = next(self._count)
        pat = f"fig-{self.qa}-{i}"
        sha = sha256(pat.encode()).hexdigest()[:8]
        return f"{pat}-{sha}.png"

    def report_start(self, out, test, example):
        pass

    def report_success(self, out, test, example, got):
        import matplotlib.pyplot as plt

        tok_entries = self._get_tok_entries(example)

        self._example_section_data.append(
            GenCode(tok_entries, got, ExecutionStatus.success)
        )

        wait_for_show = self.config.wait_for_plt_show
        fig_managers = _pylab_helpers.Gcf.get_all_fig_managers()
        figs = []
        if fig_managers and (("plt.show" in example.source) or not wait_for_show):
            for fig in fig_managers:
                figname = self._next_figure_name()
                buf = io.BytesIO()
                fig.canvas.figure.savefig(buf, dpi=300)  # , bbox_inches="tight"
                buf.seek(0)
                figs.append((figname, buf.read()))
            plt.close("all")

        for figname, _ in figs:
            self._example_section_data.append(
                Figure(
                    RefInfo.from_untrusted(
                        self.gen.root, self.gen.version, "assets", figname
                    )
                )
            )
        self.figs.extend(figs)

    def report_unexpected_exception(self, out, test, example, exc_info):
        out(f"Unexpected exception after running example in `{self.qa}`", exc_info)
        tok_entries = self._get_tok_entries(example)
        self._example_section_data.append(
            GenCode(tok_entries, exc_info, ExecutionStatus.unexpected_exception)
        )

    def report_failure(self, out, test, example, got):
        tok_entries = self._get_tok_entries(example)
        self._example_section_data.append(
            GenCode(tok_entries, got, ExecutionStatus.failure)
        )

    def get_example_section_data(self) -> Section:
        example_section_data = self._example_section_data
        self._example_section_data = Section([], None)
        return example_section_data

    def _compact(self, example_section_data) -> Section:
        """
        Compact consecutive execution items that do have the same execution status.

        TODO:

        This is not perfect as doctest tests that the output is the same, thus when we have a multiline block
        If any of the intermediate items produce an output, the result will be failure.
        """
        acc: list[Text | GenCode] = []
        current_code: GenCode | None = None

        for item in example_section_data:
            if not isinstance(item, GenCode):
                if current_code is not None:
                    acc.append(current_code)
                    acc.append(Text(str(current_code.out)))
                    acc.append(Text(str(current_code.ce_status)))
                    current_code = None
                acc.append(item)
            else:
                if current_code is None:
                    assert item is not None
                    current_code = item
                    continue

                if current_code.ce_status == item.ce_status:
                    current_code = GenCode(
                        current_code.entries + item.entries, item.out, item.ce_status
                    )
                else:
                    acc.append(current_code)
                    acc.append(Text(str(current_code.out)))
                    acc.append(Text(str(current_code.ce_status)))
                    assert item is not None
                    current_code = item

        if current_code:
            acc.append(current_code)
        return Section(acc, None)


class Gen:
    """
    Core class to generate a DocBundle for a given library.

    This is responsible for finding all objects, extracting the doc, parsing it,
    and saving that into the right folder.

    """

    docs: dict[str, bytes]
    examples: dict[str, bytes]
    data: dict[str, GeneratedDoc]
    bdata: dict[str, bytes]

    def __init__(self, dummy_progress: bool, config: Config):
        self._dummy_progress = dummy_progress
        self.Progress = progress_class(dummy=dummy_progress)

        self.progress = lambda: self.Progress(
            TextColumn("[progress.description]{task.description}", justify="right"),
            BarColumn(bar_width=None),
            "[progress.percentage]{task.percentage:>3.1f}%",
            "[progress.completed]{task.completed} / {task.total}",
            TimeElapsedColumn(),
        )

        # TODO:
        # At some point it would be better to have that be matplotlib
        # specific and not hardcoded.
        class MF(logging.Filter):
            """
            This is a matplotlib filter to temporarily silence a bunch of warning
            messages that are emitted if font are not found

            """

            def filter(self, record):
                if "Generic family" in record.msg:
                    return 0
                if "found for the serif fontfamily" in record.msg:
                    return 0
                if "not found. Falling back to" in record.msg:
                    return 0
                if "Substituting symbol" in record.msg:
                    return 0
                return 1

        mlog = logging.getLogger("matplotlib.font_manager")
        mlog.addFilter(MF("serif"))

        mplog = logging.getLogger("matplotlib.mathtext")
        mplog.addFilter(MF("serif"))

        # end TODO

        FORMAT = "%(message)s"
        self.log = logging.getLogger("papyri")
        self.log.setLevel("INFO")
        formatter = logging.Formatter(FORMAT, datefmt="[%X]")
        rich_handler = RichHandler(rich_tracebacks=False)
        rich_handler.setFormatter(formatter)
        self.log.addHandler(rich_handler)

        self.config = config
        self.log.debug("Configuration: %s", self.config)

        self.data = {}
        self.bdata = {}
        self._meta: dict[str, Any] = {}
        self.examples = {}
        self.docs = {}
        self._toc_nodes: list[TocTree] = []

    def get_example_data(
        self, example_section, *, obj: Any, qa: str, config: Config, log: logging.Logger
    ) -> tuple[Section, list[Any]]:
        """Extract example section data from a NumpyDocString

        One of the section in numpydoc is "examples" that usually consist of number
        of paragraphs, interleaved with examples starting with >>> and ...,

        This attempts to parse this into structured data, with text, input and output
        as well as to infer the types of each token in the input examples.

        This is currently relatively limited as the inference does not work across
        code blocks.

        Parameters
        ----------
        example_section
            The example section of a numpydoc parsed docstring
        obj
            The current object. It is common for the current object/function to not
            have to be imported imported in docstrings. This should become a high
            level option at some point. Note that for method classes, the class should
            be made available but currently is not.
        qa : str
            The fully qualified name of current object
        config : Config
            Current configuration
        log
            Logger instance

        Examples
        --------
        Those are self examples, generating papyri documentation with papyri should
        be able to handle the following

        A simple input, should be execute and output should be shown if --exec option is set

        >>> 1+1

        >>> 2+2
        4

        Output with Syntax error should be marked as so.

        >>> [this is syntax error]

        if matplotlib and numpy available, we shoudl show graph

        >>> import matplotlib.pyplot as plt
        ... import numpy as np
        ... x = np.arange(0, 10, 0.1)
        ... plt.plot(x, np.sin(x))
        ... plt.show()

        Note that in the above we use `plt.show`,
        but we can configure papyri to automatically detect
        when figures are created.

        Notes
        -----
        We do not yet properly handle explicit exceptions in examples, and those are
        seen as Papyri failures.

        The capturing of matplotlib figures is also limited.
        """
        assert qa is not None
        example_code = "\n".join(example_section)
        import matplotlib.pyplot as plt

        if qa in config.exclude_jedi:
            config = config.replace(infer=False)
            log.debug(f"Turning off type inference for func {qa!r}")

        sys_stdout = sys.stdout

        def dbg(*args):
            for arg in args:
                sys_stdout.write(f"{arg}\n")
            sys_stdout.flush()

        try:
            filename = inspect.getfile(obj)
        except TypeError:
            filename = None
        try:
            lineno = inspect.getsourcelines(obj)[1]
        except (TypeError, OSError):
            lineno = None

        doctest_runner = PapyriDocTestRunner(
            gen=self,
            obj=obj,
            qa=qa,
            config=config,
            # TODO: Make optionflags configurable
            optionflags=doctest.ELLIPSIS,
        )
        example_section_data = Section([], None)

        def debugprint(*args):
            """
            version of print that capture current stdout to use during testing to debug
            """
            sys_stdout.write(" ".join(str(x) for x in args) + "\n")

        blocks = doctest.DocTestParser().parse(example_code, name=qa)
        for block in blocks:
            if isinstance(block, doctest.Example):
                doctests = doctest.DocTest(
                    [block],
                    globs=doctest_runner.globs,
                    name=qa,
                    filename=filename,
                    lineno=lineno,
                    docstring=example_code,
                )
                if config.execute_doctests:
                    with warnings.catch_warnings():
                        warnings.filterwarnings(
                            "ignore",
                            message="is non-interactive, and thus cannot be shown",
                            category=UserWarning,
                        )
                    doctest_runner.run(doctests, out=debugprint, clear_globs=False)
                    doctest_runner.globs.update(doctests.globs)
                    example_section_data.extend(
                        doctest_runner.get_example_section_data()
                    )
                else:
                    example_section_data.append(Text(block.source))
            elif block:
                example_section_data.append(Text(block))

        example_section_data = doctest_runner._compact(example_section_data)

        # TODO fix this if plt.close not called and still a lingering figure.
        fig_managers = _pylab_helpers.Gcf.get_all_fig_managers()
        if len(fig_managers) != 0:
            plt.close("all")

        return processed_example_data(example_section_data), doctest_runner.figs

    def clean(self, where: Path):
        """
        Erase a doc bundle folder.
        """
        subdirs = ("module", "assets", "docs", "examples")
        for i, sub in enumerate(subdirs, start=1):
            for _, path in iter_with_progress(
                (where / sub).glob("*"),
                dummy=self._dummy_progress,
                description=f"cleaning previous bundle {i}/{len(subdirs)}",
            ):
                path.unlink()

        for sub in subdirs:
            if (where / sub).exists():
                (where / sub).rmdir()
        for f in ("papyri.json", "toc.json"):
            if (where / f).exists():
                (where / f).unlink()

    def collect_narrative_docs(self):
        """
        Crawl the filesystem for all docs/rst files

        """
        if not self.config.docs_path:
            return
        path = Path(self.config.docs_path).expanduser()
        if not path.exists():
            self.log.warning(
                "docs_path %s does not exist, skipping narrative docs", path
            )
            return
        self.log.info("Scraping Documentation")
        files = list(path.glob("**/*.rst"))
        trees = {}
        title_map = {}
        blbs = {}
        with self.progress() as p2:
            task = p2.add_task("Parsing narrative", total=len(files))

            for p in files:
                p2.update(task, description=compress_user(str(p)).ljust(7))
                p2.advance(task)

                if any([k in str(p) for k in self.config.narrative_exclude]):
                    log.debug("Skipping %s - excluded in config file", p)
                    continue

                assert p.is_file()
                parts = p.relative_to(path).parts
                assert parts[-1].endswith("rst")
                try:
                    data = ts.parse(p.read_bytes(), p)
                except Exception as e:
                    self.log.warning("Could not parse %s, skipping: %s", p, e)
                    continue
                blob = GeneratedDoc.new()
                key = ":".join(parts)[:-4]
                try:
                    dv = GenVisitor(
                        key,
                        frozenset(),
                        local_refs=set(),
                        aliases={},
                        version=self._meta["version"],
                        config=self.config.directives,
                        module=self._meta.get("module"),
                        doc_path=p.parent,
                        asset_store=self.put_raw,
                        doc_root=path,
                    )
                    dv.collect_substitutions(*data)
                    blob.arbitrary = [dv.visit(s) for s in data]
                    trees[key] = dv._tocs
                    blob.item_file = None
                    blob.item_line = None
                    blob.item_type = None
                    blob.aliases = []
                    blob.example_section_data = Section([], None)
                    blob.see_also = []
                    blob.signature = None
                    blob.validate()
                except Exception as e:
                    self.log.warning("Could not process %s, skipping: %s", p, e)
                    continue
                titles = [s.title for s in blob.arbitrary if s.title]
                title = f"<No Title {key}>" if not titles else titles[0]
                title_map[key] = title
                if "generated" not in key and title_map[key] is None:
                    log.debug("%s %s", key, title)

                blbs[key] = blob
        for k, b in blbs.items():
            self.docs[k] = b.to_json()

        raw_tree = make_tree(trees)

        def _build_toc(tree: dict) -> list[TocTree]:
            result = []
            for k, children in tree.items():
                result.append(
                    TocTree(
                        children=_build_toc(children),
                        title=title_map.get(k, k),
                        ref=LocalRef("docs", k),
                    )
                )
            return result

        self._toc_nodes = _build_toc(raw_tree)

    def write_narrative(self, where: Path) -> None:
        if self._toc_nodes:
            (where / "toc.json").write_bytes(
                json.dumps(
                    [t.to_dict() for t in self._toc_nodes], indent=2, sort_keys=True
                ).encode()
            )
        (where / "docs").mkdir(exist_ok=True)
        for file, v in self.docs.items():
            subf = where / "docs"
            subf.mkdir(exist_ok=True, parents=True)
            (subf / file).write_bytes(v)

    def write_examples(self, where: Path) -> None:
        (where / "examples").mkdir(exist_ok=True)
        for k, v in self.examples.items():
            (where / "examples" / k).write_bytes(v)

    def write_api(self, where: Path):
        """
        Write the API section of the DocBundle.
        """
        (where / "module").mkdir(exist_ok=True)
        for k, v in self.data.items():
            (where / "module" / (k + ".json")).write_bytes(v.to_json())

    def partial_write(self, where):
        self.write_api(where)

    def write(self, where: Path):
        """
        Write a DocBundle folder.
        """
        self.write_api(where)
        self.write_narrative(where)
        self.write_examples(where)
        self.write_assets(where)
        with (where / "papyri.json").open("w") as f:
            assert "version" in self._meta
            f.write(json.dumps(self._meta, indent=2, sort_keys=True))

    def write_assets(self, where: Path) -> None:
        assets = where / "assets"
        assets.mkdir(exist_ok=True)
        for k, v in self.bdata.items():
            (assets / k).write_bytes(v)

    def put(self, path: str, obj):
        """
        put some json data at the given path
        """
        self.data[path] = obj

    def put_raw(self, path: str, data: bytes):
        """
        put some binary data at the given path.
        """
        self.bdata[path] = data

    def _transform_1(self, blob: GeneratedDoc, ndoc) -> GeneratedDoc:
        """
        Populates GeneratedDoc content field from numpydoc parsed docstring.

        """
        for k, v in ndoc._parsed_data.items():
            blob.content[k] = v
        for v in blob.content.values():
            assert isinstance(v, (str, list, dict)), type(v)
        return blob

    def _transform_2(self, blob: GeneratedDoc, target_item, qa: str) -> GeneratedDoc:
        """
        Try to find relative path WRT site package and populate item_file field
        for GeneratedDoc.
        """
        # will not work for dev install. Maybe an option to set the root location ?
        item_file: str | None = find_file(target_item)
        if item_file is not None and item_file.endswith("<string>"):
            # dynamically generated object (like dataclass __eq__ method
            item_file = None
        r = qa.split(".")[0]
        if item_file is not None:
            # TODO: find a better way to get a relative path with respect to the
            # root of the package ?
            for s in [
                *SITE_PACKAGE,
                os.path.expanduser(f"~/dev/{r}/"),
                os.path.expanduser("~"),
                os.getcwd(),
            ]:
                if item_file.startswith(s):
                    item_file = item_file[len(s) :]
        blob.item_file = item_file
        if item_file is None:
            if type(target_item).__name__ in (
                "builtin_function_or_method",
                "fused_cython_function",
                "cython_function_or_method",
            ):
                self.log.debug(
                    "Could not find source file for built-in function method."
                    "Likely compiled extension %s %s %s, will not be able to link to it.",
                    repr(qa),
                    target_item,
                    repr(type(target_item).__name__),
                )
            else:
                rqan = str(qa).split(".")[-1]
                if not (rqan.startswith("__") and rqan.endswith("__")):
                    self.log.warning(
                        "Could not find source file for %s (%s) [%s], will not be able to link to it.",
                        repr(qa) + ":" + rqan,
                        target_item,
                        type(target_item).__name__,
                    )

        return blob

    def _transform_3(self, blob, target_item):
        """
        Try to find source line number for target object and populate item_line
        field for GeneratedDoc.
        """
        item_line = None
        try:
            item_line = inspect.getsourcelines(target_item)[1]
        except OSError:
            self.log.debug("Could not find item_line for %s, (OSERROR)", target_item)
        except TypeError:
            if type(target_item).__name__ in (
                "builtin_function_or_method",
                "fused_cython_function",
                "cython_function_or_method",
            ):
                self.log.debug(
                    "Could not find item_line for %s, (TYPEERROR), likely from a .so file",
                    target_item,
                )
            else:
                self.log.debug(
                    "Could not find item_line for %s, (TYPEERROR)", target_item
                )
        blob.item_line = item_line

        return blob

    def prepare_doc_for_one_object(
        self,
        target_item: Any,
        ndoc,
        *,
        qa: str,
        config: Config,
        aliases: list[str],
        api_object: APIObjectInfo,
    ) -> tuple[GeneratedDoc, list]:
        """
        Get documentation information for one python object

        Parameters
        ----------
        target_item : any
            the object you want to get documentation for
        ndoc
            numpydoc parsed docstring.
        qa : str
            fully qualified object path.
        config : Config
            current configuratin
        aliases : sequence
            other aliases for cuttent object.
        api_object : APIObjectInfo
            Describes the object's type and other relevant information

        Returns
        -------
        Tuple of two items,
        blob:
            GeneratedDoc with info for current object.
        figs:
            dict mapping figure names to figure data.

        See Also
        --------
        collect_api_docs
        """
        assert isinstance(aliases, list)
        blob: GeneratedDoc = GeneratedDoc.new()

        blob = self._transform_1(blob, ndoc)
        blob = self._transform_2(blob, target_item, qa)
        blob = self._transform_3(blob, target_item)
        assert set(blob.content.keys()) == set(blob.ordered_sections), (
            set(blob.content.keys()) - set(blob.ordered_sections),
            set(blob.ordered_sections) - set(blob.content.keys()),
        )

        item_type = str(type(target_item))
        if blob.content["Signature"]:
            try:
                # the type ignore below is wrong and need to be refactored.
                # we basically modify blob.content in place, but should not.
                if "Signature" in blob.content:
                    ss = blob.content["Signature"]
                    del blob.content["Signature"]
                else:
                    ss = None
                sig = ObjectSignature.from_str(ss)
                if sig is not None:
                    blob.signature = sig.to_node()
            except TextSignatureParsingFailed:
                # this really fails often when the first line is not Signature.
                # or when numpy has the def f(,...[a,b,c]) optional parameter.
                pass
        else:
            assert blob is not None
            assert api_object is not None
            if api_object.signature is None:
                blob.signature = None
            else:
                blob.signature = api_object.signature.to_node()
            del blob.content["Signature"]
        self.log.debug("SIG %r", blob.signature)

        if api_object.special("Examples"):
            # warnings this is true only for non-modules
            # things.
            try:
                example_section_data, figs = self.get_example_data(
                    api_object.special("Examples").value,
                    obj=target_item,
                    qa=qa,
                    config=config,
                    log=self.log,
                )
            except Exception as e:
                example_section_data = Section([], None)
                self.log.error("Error getting example data in %s", repr(qa))
                from .errors import ExampleError1

                raise ExampleError1(f"Error getting example data in {qa!r}") from e
        else:
            example_section_data = Section([], None)
            figs = []

        refs_I = []
        refs_Ib = []
        if ndoc["See Also"]:
            for line in ndoc["See Also"]:
                rt, desc = line
                assert isinstance(desc, list), line
                for ref, _type in rt:
                    refs_I.append(ref)
        if api_object.special("See Also"):
            refs_Ib.extend(
                [sa.name.value for sa in api_object.special("See Also").value]
            )

        if api_object.kind != "module":
            # TODO: most module docstring are not properly parsed by numpydoc.
            # but some are.
            assert refs_I == refs_Ib, (refs_I, refs_Ib)

        blob.example_section_data = example_section_data

        blob.item_type = item_type

        del blob.content["Examples"]
        del blob.content["index"]

        ref = blob.content["References"]
        if ref == "":
            blob.references = None
        else:
            blob.references = ref
        del blob.content["References"]

        blob.aliases = aliases
        assert set(blob.content.keys()) == set(blob.ordered_sections), (
            set(blob.content.keys()),
            set(blob.ordered_sections),
        )
        for section in ["Extended Summary", "Summary", "Notes", "Warnings"]:
            try:
                data = blob.content.get(section, None)
                if data is None:
                    # don't exists
                    pass
                elif not data:
                    # is empty
                    blob.content[section] = Section([], None)
                else:
                    tsc = ts.parse("\n".join(data).encode(), qa)
                    assert len(tsc) in (0, 1), (tsc, data)
                    tssc = tsc[0] if tsc else Section([], None)
                    assert isinstance(tssc, Section)
                    blob.content[section] = tssc
            except Exception:
                self.log.exception(f"Skipping section {section!r} in {qa!r} (Error)")
                raise
        assert isinstance(blob.content["Summary"], Section)
        assert isinstance(blob.content.get("Summary", Section([], None)), Section), (
            blob.content["Summary"]
        )

        sections_ = [
            "Parameters",
            "Returns",
            "Raises",
            "Yields",
            "Attributes",
            "Other Parameters",
            "Warns",
            "Methods",
            "Receives",
        ]

        for s in set(sections_).intersection(blob.content.keys()):
            assert isinstance(blob.content[s], list), f"{s}, {blob.content[s]} {qa} "
            new_content = []

            for param, type_, desc in blob.content[s]:
                assert isinstance(desc, list)
                items = []
                if desc:
                    try:
                        items = parse_rst_section("\n".join(desc), qa)
                    except Exception as e:
                        raise type(e)(f"from {qa}") from e
                    for l in items:
                        assert not isinstance(l, Section)
                new_content.append(DocParam(param, type_, desc=items).validate())
            if new_content:
                blob.content[s] = Section([Parameters(new_content)], None)
            else:
                blob.content[s] = Section([], None)

        blob.see_also = _normalize_see_also(blob.content.get("See Also", Section()), qa)
        del blob.content["See Also"]

        assert set(blob.content.keys()) == set(blob.ordered_sections), (
            set(blob.content.keys()),
            set(blob.ordered_sections),
        )
        return blob, figs

    def collect_examples(self, folder: Path, config):
        acc = []
        examples = list(folder.glob("**/*.py"))

        valid_examples = []
        for e in examples:
            if any(str(e).endswith(p) for p in config.examples_exclude):
                continue
            valid_examples.append(e)
        examples = valid_examples

        # TODO: resolve this path with respect the configuration file.
        # this is of course if we have configuration file.
        #        assert (
        #            len(examples) > 0
        #        ), "we haven't found any examples, it is likely that the path is incorrect."

        with self.progress() as p2:
            failed = []

            taskp = p2.add_task(description="Collecting examples", total=len(examples))
            for example in examples:
                p2.update(taskp, description=compress_user(str(example)).ljust(7))
                p2.advance(taskp)
                executor = BlockExecutor({})
                script = example.read_text()
                ce_status = "None"
                figs = []
                if config.execute_doctests:
                    with executor:
                        try:
                            executor.exec(script, name=str(example))
                            figs = [
                                (f"ex-{example.name}-{i}.png", f)
                                for i, f in enumerate(executor.get_figs())
                            ]
                            ce_status = "execed"
                        except Exception as e:
                            failed.append(str(example))
                            if config.exec_failure == "fallback":
                                self.log.exception("%s failed %s", example, type(e))
                            else:
                                raise type(e)(f"Within {example}") from e
                entries_p = parse_script(
                    script,
                    ns={},
                    prev="",
                    config=config,
                )

                entries: list[Any]
                if entries_p is None:
                    log.warning("Issue in %r", example)
                    entries = [("fail", "fail")]
                else:
                    entries = list(entries_p)

                assert isinstance(entries, list), entries

                entries = _add_classes(entries)
                assert set(len(x) for x in entries) == {3}

                tok_entries = [GenToken(*x) for x in entries]
                l: list[Any] = []  # get typechecker to shut up.
                s = Section(
                    l
                    + [GenCode(tok_entries, "", ce_status)]  # ignore: type
                    + [
                        Figure(
                            RefInfo.from_untrusted(
                                self.root, self.version, "assets", name
                            )
                        )  # ignore: type
                        for name, _ in figs
                    ],  # ignore: type
                    None,
                )
                s = processed_example_data(s)
                dv = GenVisitor(
                    example.name,
                    frozenset(),
                    local_refs=frozenset(),
                    aliases={},
                    version=self.version,
                    config=self.config.directives,
                    module=self.root,
                )
                dv.collect_substitutions(s)
                s2 = dv.visit(s)

                acc.append(
                    (
                        {example.name: s2},
                        figs,
                    )
                )
        assert len(failed) == 0, failed
        return acc

    def _get_collector(self) -> DFSCollector:
        """
        Construct a depth first search collector that will try to find all
        the objects it can.

        We give it the root module, and a few submodules as seed.
        """
        assert "." not in self.root
        n0 = __import__(self.root)
        submodules = []

        subs = self.config.submodules
        extra_from_conf = [self.root + "." + s for s in subs]
        for name in extra_from_conf:
            _, *r = name.split(".")
            nx = __import__(name)
            for sub in r:
                nx = getattr(nx, sub)
            submodules.append(nx)

        self.log.debug(
            "Collecting API starting from [%r], and %s",
            n0.__name__,
            [m.__name__ for m in submodules],
        )
        return DFSCollector(n0, submodules)

    def collect_examples_out(self):
        examples_folder = self.config.examples_folder
        self.log.debug("Example Folder: %s", examples_folder)
        if examples_folder is not None:
            examples_path = Path(examples_folder).expanduser()
            examples_data = self.collect_examples(
                examples_path,
                config=self.config,
            )
            for edoc, figs in examples_data:
                self.examples.update({k: v.to_json() for k, v in edoc.items()})
                for name, data in figs:
                    self.put_raw(name, data)

    def extract_docstring(
        self, *, qa: str, target_item: Any
    ) -> tuple[str | None, list[Section], APIObjectInfo]:
        """
        Extract docstring from an object.

        Detects whether an object includes a docstring and parses the object's
        type.

        Parameters
        ----------
        qa : str
            Fully qualified name of the object we are extracting the
            documentation from
        target_item : Any
            Object we wish inspect. Can be any kind of object.

        Returns
        -------
        item_docstring : str
            The unprocessed object's docstring
        sections : list of Section
            A list of serialized sections of the docstring
        api_object : APIObjectInfo
            Describes the object's type and other relevant information

        """
        item_docstring: str = target_item.__doc__
        if item_docstring is not None:
            item_docstring = dedent_but_first(item_docstring)
        builtin_function_or_method = type(sum)

        if isinstance(target_item, ModuleType):
            api_object = APIObjectInfo(
                "module", item_docstring, None, target_item.__name__, qa
            )
        elif isinstance(
            target_item, (FunctionType, builtin_function_or_method)
        ) or callable(target_item):
            sig: ObjectSignature | None
            try:
                sig = ObjectSignature(target_item)
            except (ValueError, TypeError):
                sig = None
            try:
                api_object = APIObjectInfo(
                    "function", item_docstring, sig, target_item.__name__, qa
                )
            except Exception as e:
                e.add_note(f"For object {qa!r}")
                raise
        elif isinstance(target_item, type):
            api_object = APIObjectInfo(
                "class", item_docstring, None, target_item.__name__, qa
            )
        else:
            api_object = APIObjectInfo(
                "other", item_docstring, None, target_item.__name__, qa
            )
            # assert False, type(target_item)

        if item_docstring is None and not isinstance(target_item, ModuleType):
            return None, [], api_object
        elif item_docstring is None and isinstance(target_item, ModuleType):
            item_docstring = """This module has no documentation"""

        try:
            sections = ts.parse(item_docstring.encode(), qa)
        except (AssertionError, NotImplementedError) as e:
            self.log.error("TS could not parse %s, %s", repr(qa), e)
            raise type(e)(f"from {qa}") from e
            sections = []
        except Exception as e:
            raise type(e)(f"from {qa}") from e

        assert api_object is not None
        return item_docstring, sections, api_object

    def collect_package_metadata(self, root, relative_dir, meta):
        """
        Try to gather generic metadata about the current package we are going to
        build the documentation for.
        """
        self.root = root
        if self.config.logo:
            logo_path = relative_dir / self.config.logo
            self.put_raw(logo_path.name, logo_path.read_bytes())
            logo = logo_path.name
        else:
            logo = None
        module = __import__(root)
        # Prefer the module's own __version__ when available; fall back to
        # installed-distribution metadata for projects that stopped exposing
        # it (e.g. xarray). Distribution name may differ from the import
        # name, so allow callers to override via [meta].pypi.
        version = getattr(module, "__version__", None)
        if version is None:
            from importlib.metadata import PackageNotFoundError
            from importlib.metadata import version as _dist_version

            dist_name = meta.get("pypi") or root
            try:
                version = _dist_version(dist_name)
            except PackageNotFoundError:
                version = "0.0.0"
        self.version = version
        assert parse(self.version)

        try:
            meta["tag"] = meta["tag"].format(version=self.version)
        except KeyError:
            meta["tag"] = self.version

        self._meta.update({"logo": logo, "module": root, "version": self.version})
        self._meta.update(meta)

        # Configure :ghpull: / :ghissue: to point at this project's repo when
        # [meta].github_slug is set (falls back to the IPython default inside
        # tree.set_github_slug). Previously both roles were hardcoded to
        # github.com/ipython/ipython for every bundle.
        from .tree import set_github_slug

        set_github_slug(self._meta.get("github_slug"))

    def collect_api_docs(self, root: str, limit_to: list[str]) -> None:
        """
        Crawl one module and stores resulting DocBundle in json files.

        Parameters
        ----------
        root : str
            Module name to generate DocBundle for.
        limit_to : list of string
            For partial documentation building and testing purposes
            we may want to generate documentation for only a single item.
            If this list is non-empty we will collect documentation
            just for these items.

        See Also
        --------
        prepare_doc_for_one_object

        """

        collector: DFSCollector = self._get_collector()
        collected: dict[str, Any] = collector.items()

        # collect all items we want to document.
        excluded = sorted(self.config.exclude)
        if excluded:
            self.log.info(
                "The following items will be excluded by the configurations:\n %s",
                json.dumps(excluded, indent=2, sort_keys=True),
            )
        else:
            self.log.info("No items excluded by the configuration")
        missing = list(set(excluded) - set(collected.keys()))
        if missing:
            self.log.warning(
                "The following items have been excluded but were not found:\n %s",
                json.dumps(sorted(missing), indent=2, sort_keys=True),
            )

        collected = {k: v for k, v in collected.items() if k not in excluded}

        if limit_to:
            non_existinsing = [k for k in limit_to if k not in collected]
            if non_existinsing:
                self.log.warning(
                    "You asked to build docs only for following items,"
                    " but they don't exist:\n %s, existing items are %s",
                    non_existinsing,
                    collected.keys(),
                )
            collected = {k: v for k, v in collected.items() if k in limit_to}
            self.log.info("DEV: regenerating docs only for")
            for k, v in collected.items():
                self.log.info(f"    {k}:{v}")

        aliases: dict[FullQual, Canonical]
        aliases, _not_found = collector.compute_aliases()
        rev_aliases: dict[Canonical, FullQual] = {v: k for k, v in aliases.items()}

        known_refs = frozenset(
            {
                RefInfo.from_untrusted(root, self.version, "module", qa)
                for qa in collected
            }
        )

        error_collector = ErrorCollector(self.config, self.log)
        # with self.progress() as p2:
        # just nice display of progression.
        # taskp = p2.add_task(description="parsing", total=len(collected))

        failure_collection: dict[str, list[str]] = defaultdict(lambda: [])
        api_object: APIObjectInfo
        for qa, target_item in collected.items():
            self.log.debug("treating %r", qa)

            with error_collector(qa=qa) as ecollector:
                item_docstring, arbitrary, api_object = self.extract_docstring(
                    qa=qa,
                    target_item=target_item,
                )
                self.log.debug("APIOBJECT %r", api_object)
            if ecollector.errored:
                if ecollector._unexpected_errors.keys():
                    self.log.warning(
                        "error with %s %s",
                        qa,
                        list(ecollector._unexpected_errors.keys()),
                    )
                else:
                    self.log.info(
                        "only expected error with %s, %s",
                        qa,
                        list(ecollector._expected_errors.keys()),
                    )
                continue

            try:
                if item_docstring is None:
                    ndoc = NumpyDocString(dedent_but_first("No Docstrings"))
                else:
                    ndoc = NumpyDocString(dedent_but_first(item_docstring))
                    # note currently in ndoc we use:
                    # _parsed_data
                    # direct access to  ["See Also"], and [""]
                    # and :
                    # ndoc.ordered_sections
            except Exception as e:
                if not isinstance(target_item, ModuleType):
                    self.log.exception(
                        "Unexpected error parsing %s - %s",
                        qa,
                        target_item.__name__,
                    )
                    failure_collection["NumpydocError-" + str(type(e))].append(qa)
                if isinstance(target_item, ModuleType):
                    # Module docstrings that numpydoc cannot parse fall
                    # through to the same empty shell we use when a module
                    # has no docstring at all. Previously the placeholder
                    # read ``"To remove in the future -- <qa>"`` which
                    # leaked into the rendered output.
                    self.log.debug(
                        "numpydoc failed to parse module docstring for %s; "
                        "using empty placeholder",
                        qa,
                    )
                    ndoc = NumpyDocString(dedent_but_first("No Docstrings"))
                else:
                    continue
            if not isinstance(target_item, ModuleType):
                arbitrary = []
            ex = self.config.execute_doctests
            if self.config.execute_doctests and any(
                qa.startswith(pat) for pat in self.config.execute_exclude_patterns
            ):
                ex = False

            # TODO: ndoc-placeholder : make sure ndoc placeholder handled here.
            with error_collector(qa=qa) as c:
                doc_blob, figs = self.prepare_doc_for_one_object(
                    target_item,
                    ndoc,
                    qa=qa,
                    config=self.config.replace(execute_doctests=ex),
                    aliases=collector.aliases[qa],
                    api_object=api_object,
                )
            del api_object
            if c.errored:
                continue
            _local_refs: list[str] = []

            sections_ = [
                "Parameters",
                "Returns",
                "Raises",
                "Yields",
                "Attributes",
                "Other Parameters",
                "Warns",
                ##"Warnings",
                "Methods",
                # "Summary",
                "Receives",
            ]
            for s in sections_:
                for child in doc_blob.content.get(s, []):
                    if isinstance(child, Parameters):
                        for param in child.children:
                            new_ref = [u.strip() for u in param[0].split(",") if u]
                            if new_ref:
                                _local_refs.extend(new_ref)

            for lr1 in _local_refs:
                assert isinstance(lr1, str)
            lr: frozenset[str] = frozenset(_local_refs)
            doc_blob.local_refs = sorted(lr)
            try:
                _src_file = find_file(target_item)
                _doc_path = (
                    Path(_src_file).parent
                    if _src_file and not _src_file.endswith("<string>")
                    else None
                )
                dv = GenVisitor(
                    qa,
                    known_refs,
                    local_refs=lr,
                    aliases={},
                    version=self.version,
                    config=self.config.directives,
                    doc_path=_doc_path,
                    asset_store=self.put_raw,
                )
                dv.collect_substitutions(
                    *arbitrary,
                    *doc_blob._content.values(),
                    *[
                        doc_blob.content[s]
                        for s in ["Extended Summary", "Summary", "Notes", *sections_]
                        if s in doc_blob.content
                    ],
                )
                doc_blob.arbitrary = [dv.visit(s) for s in arbitrary]
                doc_blob.example_section_data = dv.visit(doc_blob.example_section_data)
                doc_blob._content = {
                    k: dv.visit(v) for (k, v) in doc_blob._content.items()
                }

                for section in ["Extended Summary", "Summary", "Notes", *sections_]:
                    if section in doc_blob.content:
                        doc_blob.content[section] = dv.visit(doc_blob.content[section])

                doc_blob.see_also = list(
                    sorted(set(doc_blob.see_also), key=lambda sa: sa.name.value)
                )

                for sa in doc_blob.see_also:
                    from .tree import resolve_

                    r = resolve_(
                        qa,
                        known_refs,
                        frozenset(),
                        sa.name.value,
                        rev_aliases=rev_aliases,
                    )
                    assert isinstance(r, RefInfo)
                    if r.kind == "module":
                        sa.name.reference = r
                    else:
                        imp = GenVisitor._import_solver(sa.name.value)
                        if imp:
                            self.log.debug(
                                "TODO: see also resolve for %s in %s, %s",
                                sa.name.value,
                                qa,
                                imp,
                            )

                # end processing
                assert not isinstance(doc_blob._content, str), doc_blob._content
                doc_blob.validate()
                self.log.debug(doc_blob.signature)
                self.put(qa, doc_blob)
                if figs:
                    self.log.debug("Found %s figures", len(figs))
                for name, data in figs:
                    self.put_raw(name, data)
            except Exception as _post_err:
                if self.config.early_error:
                    raise
                self.log.warning(
                    "Error post-processing %s, skipping: %s", qa, _post_err
                )
        if error_collector._unexpected_errors:
            self.log.info(
                "ERRORS:"
                + tomli_w.dumps(error_collector._unexpected_errors).replace(
                    ",", ",    \n"
                )
            )
        if error_collector._expected_unseen:
            inverted = defaultdict(lambda: [])
            for qa, errs in error_collector._expected_unseen.items():
                for err in errs:
                    inverted[err].append(qa)
            self.log.info("UNSEEN ERRORS:" + tomli_w.dumps(inverted))
        if failure_collection:
            self.log.info(
                "The following parsing failed \n%s",
                json.dumps(failure_collection, indent=2, sort_keys=True),
            )
        self._meta.update(
            {
                "aliases": aliases,
            }
        )

        top = self.data.get(self.root)
        if top is not None:
            summary_section = top._content.get("Summary")
            if summary_section is not None:
                blurb = _first_paragraph_text(summary_section)
                if blurb:
                    self._meta["summary"] = blurb


def is_private(path):
    """
    Determine if a import path, or fully qualified is private.
    that usually implies that (one of) the path part starts with a single underscore.
    """
    return any(p.startswith("_") and not p.startswith("__") for p in path.split("."))


def find_canonical(qa: str, aliases: list[str]):
    """
    Given the fully qualified name and a lit of aliases, try to find the canonical one.

    The canonical name is usually:
        - short (less depth in number of modules)
        - does not contain special chars like <, > for locals
        - none of the part start with _.
        - if there are many names that have the same depth and are shorted than the qa, we bail.

    We might want to be careful with dunders.

    If we can't find a canonical, there are many, or are identical to the fqa, return None.
    """

    def _level(c):
        return c.count(".") + c.count(":")

    qa_level = _level(qa)
    min_alias_level = min(_level(a) for a in set(aliases))
    if min_alias_level < qa_level:
        shorter_candidates = [c for c in aliases if _level(c) <= min_alias_level]
    else:
        shorter_candidates = [c for c in aliases if _level(c) <= qa_level]
    if (
        len(shorter_candidates) == 1
        and not is_private(shorter_candidates[0])
        and shorter_candidates[0] != qa
    ):
        return shorter_candidates[0]
    return None
