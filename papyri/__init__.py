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

import typer

from . import examples as examples
from .cli.about import about
from .cli.bootstrap import bootstrap
from .cli.debug import debug
from .cli.describe import describe
from .cli.diff import diff
from .cli.drop import drop
from .cli.find import find
from .cli.gen import gen
from .cli.ingest import ingest
from .cli.pack import pack
from .cli.relink import relink
from .cli.upload import upload

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


for _cmd in (
    about,
    ingest,
    relink,
    gen,
    pack,
    bootstrap,
    drop,
    find,
    describe,
    debug,
    diff,
    upload,
):
    app.command()(_cmd)


if __name__ == "__main__":
    app()
