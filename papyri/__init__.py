"""
Papyri - Python IR producer + local graph store.

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

from pathlib import Path
from typing import Annotated

import tomli_w
import typer

from . import examples as examples
from .cli.debug import debug
from .cli.describe import describe
from .cli.find import find

__version__ = "0.0.9"

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


def _version_callback(value: bool) -> None:
    if value:
        typer.echo(logo.strip())
        typer.echo(f"papyri {__version__}")
        raise typer.Exit()


@app.callback()
def _app_callback(
    version: bool = typer.Option(
        None,
        "--version",
        "-V",
        callback=_version_callback,
        is_eager=True,
        help="Show version and exit.",
    ),
) -> None:
    pass


@app.command()
def about() -> None:
    """
    Show the logo, version, and a short description of papyri.
    """
    typer.echo(logo.strip())
    typer.echo(f"papyri {__version__}")
    typer.echo(
        "\nGenerate and ingest Python documentation IR for cross-linked browsing."
    )
    typer.echo("https://github.com/carreau/papyri")


@app.command()
def ingest(
    paths: list[Path],
    check: bool = False,
    relink: bool = False,
    no_progress: bool = typer.Option(
        False,
        "--no-progress",
        is_flag=True,
        help="Disable progress bars (useful in CI or with debuggers).",
    ),
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
    """
    from . import crosslink as cr

    for p in paths:
        cr.main(Path(p), check, dummy_progress=no_progress)
    if relink:
        cr.relink(dummy_progress=no_progress)


@app.command()
def relink(
    no_progress: bool = typer.Option(
        False,
        "--no-progress",
        is_flag=True,
        help="Disable progress bars (useful in CI or with debuggers).",
    ),
):
    """
    Rescan all the documentation to find potential new crosslinks.
    """
    from . import crosslink as cr

    cr.relink(dummy_progress=no_progress)


def _find_toml() -> list[str]:
    from glob import glob

    return glob("**/*.toml", recursive=True)


@app.command()
def gen(
    file: Annotated[
        str,
        typer.Argument(
            help="toml configuration file",
            autocompletion=_find_toml,
        ),
    ],
    infer: bool | None = typer.Option(
        True, help="Whether to run type inference on code examples."
    ),
    exec: bool | None = typer.Option(
        None, help="Whether to attempt to execute docstring code examples."
    ),
    debug: bool = False,
    no_progress: bool = typer.Option(
        False,
        "--no-progress",
        is_flag=True,
        help="Disable progress bars (useful in CI or with debuggers).",
    ),
    dry_run: bool = False,
    api: bool = True,
    examples: bool = True,
    narrative: bool = True,
    fail: bool = typer.Option(False, help="Fail on first error."),
    fail_early: bool = typer.Option(False, help="Override early error option."),
    fail_unseen_error: bool = typer.Option(
        False, help="Fail on any previously unseen error."
    ),
    only: list[str] = typer.Option(
        None,
        "--only",
        help="Restrict generation to these qualified names (repeatable).",
    ),
):
    """
    Generate documentation IR for a given package.

    First item should be the root package to import; if subpackages need to be
    analyzed but are not accessible from the root pass them as extra arguments.

    This takes a single file and builds the IR for a single package. Building
    for multiple packages may have side effects (for example importing seaborn
    changes matplotlib defaults).
    """
    import os
    from os.path import join

    from IPython.utils.tempdir import TemporaryWorkingDirectory

    from papyri.gen import gen_main

    here = os.getcwd()

    with TemporaryWorkingDirectory():
        gen_main(
            infer=infer,
            exec_=exec,
            target_file=join(here, file),
            debug=debug,
            dummy_progress=no_progress,
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
        typer.echo(f"{p} already exists", err=True)
        raise typer.Exit(1)
    name = input(f"package name [{p.stem}]:")
    if not name:
        name = p.stem
    p.write_text(tomli_w.dumps(dict(name={"module": [name]})))


@app.command()
def drop(
    yes: bool = typer.Option(
        False,
        "--yes",
        "-y",
        is_flag=True,
        help="Skip confirmation prompt.",
    ),
):
    """
    Drop the full local database.
    """
    from papyri.config import ingest_dir

    if not yes:
        typer.confirm(
            f"This will delete {ingest_dir} and all ingested data. Continue?",
            abort=True,
        )
    from . import crosslink as cr

    cr.drop()


app.command()(find)
app.command()(describe)
app.command()(debug)


if __name__ == "__main__":
    app()
