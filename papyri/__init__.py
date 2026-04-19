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
    from . import nodes, common_ast

    return dir(nodes) + dir(common_ast)


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

    $ papyri find Math
    """
    from papyri.graphstore import GraphStore
    from papyri.config import ingest_dir
    from . import nodes
    from .tree import TreeVisitor
    from .nodes import encoder
    from . import common_ast
    from .crosslink import IngestedDoc

    store = GraphStore(ingest_dir, {})

    items = list(store.glob((None, None, None, None)))

    node_type = getattr(
        nodes,
        node_name,
        getattr(common_ast, node_name, None),
    )

    if node_type is None:
        sys.exit("no such node type")

    visitor = TreeVisitor([node_type])
    for it in items:
        if it.kind in ("assets", "examples", "meta"):
            continue
        data = store.get(it)
        obj = encoder.decode(data)
        if not isinstance(obj, IngestedDoc):
            print("SKIP", it)
            continue
        for a in obj.arbitrary + list(obj.content.values()):
            res = visitor.generic_visit(a)
            if res:
                print(it)
                print(res[node_type])


@app.command()
def describe(
    qualname: Annotated[
        str,
        typer.Argument(
            help=(
                "Qualified name to describe, e.g. 'numpy.linspace'. "
                "Optional prefixes select a kind or package: "
                "'module:numpy.linspace', 'docs:intro', 'numpy/1.26.0/module/numpy.linspace'."
            ),
        ),
    ],
    kind: Annotated[
        Optional[str],
        typer.Option(
            help="Restrict to a specific kind: module, docs, examples, meta, assets.",
        ),
    ] = None,
    package: Annotated[
        Optional[str],
        typer.Option(help="Restrict to a specific package name."),
    ] = None,
    version: Annotated[
        Optional[str],
        typer.Option(help="Restrict to a specific package version."),
    ] = None,
):
    """
    Print the IR entry for a given qualified name, without rendering.

    Looks up an ingested document in ~/.papyri/ingest/ and prints its
    decoded structure, backrefs, and forward refs. Intended as a
    maintainer-side debug tool for inspecting the IR.
    """
    from papyri.graphstore import GraphStore
    from papyri.config import ingest_dir
    from .nodes import encoder
    from .crosslink import IngestedDoc  # noqa: F401 — registers tag 4010

    path_part = qualname
    # Only treat a leading "<kind>:" as a kind prefix when it matches a known
    # kind; otherwise the colon is part of the qualname itself (e.g.
    # "papyri.nodes:RefInfo").
    _known_kinds = {"module", "docs", "examples", "meta", "assets"}
    if ":" in path_part and "/" not in path_part:
        prefix, rest = path_part.split(":", 1)
        if prefix in _known_kinds:
            path_part = rest
            if kind is None:
                kind = prefix
    if "/" in path_part:
        parts = path_part.split("/")
        if len(parts) == 4:
            package, version, kind, path_part = parts
        else:
            sys.exit(
                f"unrecognised qualname format: {qualname!r} "
                "(expected package/version/kind/identifier)"
            )

    store = GraphStore(ingest_dir, {})
    matches = [
        k for k in store.glob((package, version, kind, path_part)) if k.kind != "assets"
    ]

    if not matches:
        sys.exit(
            f"no IR entry found for {qualname!r} "
            f"(package={package!r}, version={version!r}, kind={kind!r}). "
            "Have you run `papyri ingest` yet?"
        )

    for it in sorted(matches):
        print(f"=== {it.module} {it.version} {it.kind} {it.path} ===")
        try:
            data, backrefs, forward_refs = store.get_all(it)
        except Exception as e:
            print(f"  <error reading: {e}>")
            continue

        try:
            obj = encoder.decode(data)
        except Exception as e:
            print(f"  <error decoding: {e}>")
            continue

        print(obj)
        if backrefs:
            print("-- backrefs --")
            for b in sorted(backrefs):
                print(f"  {b.module} {b.version} {b.kind} {b.path}")
        if forward_refs:
            print("-- forward refs --")
            for f in sorted(forward_refs):
                print(f"  {f.module} {f.version} {f.kind} {f.path}")


intersphinx_app = typer.Typer(
    help="Manage intersphinx inventories used for outbound links.",
    no_args_is_help=True,
)
app.add_typer(intersphinx_app, name="intersphinx")


@intersphinx_app.command("fetch")
def intersphinx_fetch(
    projects: Annotated[
        Optional[List[str]],
        typer.Argument(
            help=(
                "Project keys to fetch (e.g. numpy scipy python). "
                "Defaults to every project in the intersphinx registry."
            ),
        ),
    ] = None,
    out_dir: Annotated[
        Optional[Path],
        typer.Option(
            "--out-dir",
            help="Override the cache directory (default: ~/.papyri/inventories/).",
        ),
    ] = None,
):
    """
    Download Sphinx `objects.inv` files into the local inventory cache.

    The viewer reads the cache at build time and uses it to deep-link
    intersphinx-tagged cross-references (RefInfo.kind="intersphinx") into
    their upstream Sphinx-hosted documentation sites. Also writes a
    `registry.json` manifest alongside the inventories so the viewer can
    resolve a project key to its docs base URL without re-reading the
    Python-side registry.
    """
    import json
    import urllib.request
    from . import intersphinx as isr

    registry = isr.load_registry()
    if not registry:
        raise typer.Exit(
            "intersphinx_registry isn't installed or produced an empty "
            "mapping; install papyri with its full dependencies."
        )

    if projects:
        unknown = [p for p in projects if p not in registry]
        if unknown:
            raise typer.Exit(
                f"unknown project(s): {', '.join(unknown)}. "
                f"Use one of: {', '.join(sorted(registry))[:200]}..."
            )
        keys = list(projects)
    else:
        keys = sorted(registry)

    dest = out_dir or (Path.home() / ".papyri" / "inventories")
    dest.mkdir(parents=True, exist_ok=True)

    manifest: dict = {}
    ok = 0
    fail = 0
    for project in keys:
        inv_url = isr.inventory_url(project)
        base = isr.base_url(project)
        if not inv_url or not base:
            print(f"  {project}: skipped (no url in registry)")
            fail += 1
            continue
        try:
            with urllib.request.urlopen(inv_url, timeout=30) as resp:
                buf = resp.read()
        except Exception as e:
            print(f"  {project}: fetch failed: {e}")
            fail += 1
            continue
        (dest / f"{project}.inv").write_bytes(buf)
        manifest[project] = {"url": base, "inventory_url": inv_url}
        print(f"  {project}: {len(buf)} bytes")
        ok += 1

    (dest / "registry.json").write_text(json.dumps(manifest, indent=2, sort_keys=True))
    print(f"\n{ok} ok, {fail} failed. Cache: {dest}")
    if fail:
        raise typer.Exit(code=1)


if __name__ == "__main__":
    app()
