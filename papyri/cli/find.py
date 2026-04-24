"""``papyri find`` — search all ingested documents for a given IR node type."""

from __future__ import annotations

from typing import Annotated

import typer


def _complete_nodename() -> list[str]:
    from papyri import node_base, nodes

    return dir(nodes) + dir(node_base)


def find(
    node_name: Annotated[
        str,
        typer.Argument(
            help="Name of the IR node type to search for.",
            autocompletion=_complete_nodename,
        ),
    ],
) -> None:
    """
    Find all documents with a given type of AST node.

    Mostly used to debug IR. One can find all documents with, say, equations:

    $ papyri find Math
    """
    from papyri import node_base, nodes
    from papyri.config import ingest_dir
    from papyri.crosslink import IngestedDoc
    from papyri.graphstore import GraphStore
    from papyri.nodes import encoder
    from papyri.tree import TreeVisitor

    store = GraphStore(ingest_dir, {})
    items = list(store.glob((None, None, None, None)))

    node_type = getattr(
        nodes,
        node_name,
        getattr(node_base, node_name, None),
    )

    if node_type is None:
        typer.echo(f"no such node type: {node_name!r}", err=True)
        raise typer.Exit(1)

    visitor = TreeVisitor([node_type])
    for it in items:
        if it.kind in ("assets", "examples", "meta"):
            continue
        data = store.get(it)
        obj = encoder.decode(data)
        if not isinstance(obj, IngestedDoc):
            typer.echo(f"SKIP {it}")
            continue
        for a in obj.arbitrary + list(obj.content.values()):
            res = visitor.generic_visit(a)
            if res:
                typer.echo(str(it))
                typer.echo(str(res[node_type]))
