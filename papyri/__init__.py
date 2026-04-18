"""
Papyri – Python IR producer + local graph store.

Papyri parses Python library docstrings into an intermediate representation
(IR) and ingests many libraries' IR into a local cross-linked SQLite graph.

Rendering (HTML / terminal / TUI) has been removed from this repo; a future
separate project is expected to consume the IR directly. See ``PLAN.md``.


Installation (dev)
------------------

.. code::

    git clone https://github.com/carreau/papyri
    cd papyri
    pip install -e .


Usage
-----

Two stages:

- As a library maintainer, generate papyri IR files::

    $ papyri gen <config file>

  Example TOML configs live under ``examples/``. Output lands in
  ``~/.papyri/data/<library>_<version>/``.

- As a system operator, ingest IR into the local cross-linked graph::

    $ papyri ingest ~/.papyri/data/<library>_<version>/


Changes in behavior
-------------------

Papyri parsing might be a bit different from docutils/sphinx parsing. As
docutils tries to keep backward compatibility for historical reasons, we may
be a bit stricter on some syntax. This allows us to catch more errors.

Directive must not have spaces before double colon::

    .. directive :: will be seen as a comment.
            and thus this will not appear in final output.

    .. directive:: is the proper way to write block directive.
            it will be properly interpreted.

"""

import sys
from pathlib import Path
from typing import List, Optional, Annotated

import tomli_w
import typer

from . import examples  # noqa

__version__ = "0.0.8"

logo = r"""
  ___                    _
 | _ \__ _ _ __ _  _ _ _(_)
 |  _/ _` | '_ \ || | '_| |
 |_| \__,_| .__/\_, |_| |_|
          |_|   |__/
"""

app = typer.Typer(
    help="""

Generate Papyri IR for Python libraries and ingest it into a local
cross-linked graph.

Generating IR:

    $ papyri gen examples/numpy.toml

    Will generate in ~/.papyri/data/ the folder `numpy_$numpyversion`.

Ingesting IR:

    $ papyri ingest ~/.papyri/data/numpy_$numpyversion

""",
    pretty_exceptions_enable=False,
    no_args_is_help=True,
)


def _intro():
    """
    Print the logo and current version to stdout.
    """
    print(logo)
    print(__version__)


@app.command()
def ingest(
    paths: List[Path],
    check: bool = False,
    relink: bool = False,
    dummy_progress: bool = typer.Option(False, help="Disable rich progress bar"),
):
    """
    Given paths to a DocBundle folder, ingest it into the known libraries.

    Parameters
    ----------
    paths : List of Path
        list of paths (directories) to ingest.
    relink : bool
        after ingesting all the paths, rescan the whole library to find new
        crosslinks.
    check : bool
        run extra consistency checks while ingesting.
    dummy_progress : bool
        disable the rich progress bar.
    """
    _intro()
    from . import crosslink as cr

    for p in paths:
        cr.main(Path(p), check, dummy_progress=dummy_progress)
    if relink:
        cr.relink(dummy_progress=dummy_progress)


@app.command()
def relink(
    dummy_progress: bool = typer.Option(False, help="Disable rich progress bar"),
):
    """
    Rescan all the documentation to find potential new crosslinks.
    """
    _intro()
    from . import crosslink as cr

    cr.relink(dummy_progress=dummy_progress)


def find_toml():
    from glob import glob

    return glob("**/*.toml", recursive=True)


@app.command()
def gen(
    file: Annotated[
        str,
        typer.Argument(
            help="toml configuration file",
            autocompletion=find_toml,
        ),
    ],
    infer: Optional[bool] = typer.Option(
        True, help="Whether to run type inference on code examples."
    ),
    exec: Optional[bool] = typer.Option(
        None, help="Whether to attempt to execute doctring code."
    ),
    debug: bool = False,
    dummy_progress: bool = typer.Option(False, help="Disable rich progress bar"),
    dry_run: bool = False,
    api: bool = True,
    examples: bool = True,
    narrative: bool = True,
    fail: bool = typer.Option(False, help="Fail on first error"),
    fail_early: bool = typer.Option(False, help="Overwrite early error option"),
    fail_unseen_error: bool = typer.Option(
        False, help="Overwrite fail on unseen error option"
    ),
    only: List[str] = typer.Option(None, "--only"),
):
    """
    Generate documentation IR for a given package.

    First item should be the root package to import; if subpackages need to be
    analyzed but are not accessible from the root pass them as extra arguments.

    This takes a single file and builds the IR for a single package. Building
    for multiple packages may have side effects (for example importing seaborn
    changes matplotlib defaults).
    """
    _intro()
    from papyri.gen import gen_main
    from IPython.utils.tempdir import TemporaryWorkingDirectory

    from os.path import join
    import os

    here = os.getcwd()

    with TemporaryWorkingDirectory():
        gen_main(
            infer=infer,
            exec_=exec,
            target_file=join(here, file),
            debug=debug,
            dummy_progress=dummy_progress,
            dry_run=dry_run,
            api=api,
            examples=examples,
            fail=fail,
            narrative=narrative,
            fail_early=fail_early,
            fail_unseen_error=fail_unseen_error,
            limit_to=only,
        )


@app.command()
def pack():
    from papyri.gen import pack

    pack()


@app.command()
def bootstrap(file: str):
    """
    create a basic toml configuration file (draft)
    """
    p = Path(file)
    if p.exists():
        sys.exit(f"{p} already exists")
    name = input(f"package name [{p.stem}]:")
    if not name:
        name = p.stem
    p.write_text(tomli_w.dumps(dict(name={"module": [name]})))


@app.command()
def drop():
    """
    Drop the full local database.
    """
    _intro()
    from . import crosslink as cr

    cr.drop()


def complete_nodename():
    from . import take2, myst_ast, common_ast

    return dir(take2) + dir(common_ast) + dir(myst_ast)


@app.command()
def find(
    node_name: Annotated[
        str,
        typer.Argument(
            help="Name of the node to search",
            autocompletion=complete_nodename,
        ),
    ],
):
    """
    Find all documents with a given type of AST node.

    Mostly used to debug IR. One can find all documents with, say, equations:

    $ papyri find MMath
    """
    from papyri.graphstore import GraphStore
    from papyri.config import ingest_dir
    from . import take2
    from .tree import TreeVisitor
    from .take2 import encoder
    from . import myst_ast, common_ast
    from .crosslink import IngestedBlobs

    store = GraphStore(ingest_dir, {})

    items = list(store.glob((None, None, None, None)))

    node_type = getattr(
        take2,
        node_name,
        getattr(common_ast, node_name, getattr(myst_ast, node_name, None)),
    )

    if node_type is None:
        sys.exit("no such node type")

    visitor = TreeVisitor([node_type])
    for it in items:
        if it.kind in ("assets", "examples", "meta"):
            continue
        data = store.get(it)
        obj = encoder.decode(data)
        if not isinstance(obj, IngestedBlobs):
            print("SKIP", it)
            continue
        for a in obj.arbitrary + list(obj.content.values()):
            res = visitor.generic_visit(a)
            if res:
                print(it)
                print(res[node_type])


if __name__ == "__main__":
    app()
