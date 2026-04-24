"""``papyri describe`` — print a decoded IR entry without rendering."""

from __future__ import annotations

from typing import Annotated

import typer


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
        str | None,
        typer.Option(
            help="Restrict to a specific kind: module, docs, examples, meta, assets.",
        ),
    ] = None,
    package: Annotated[
        str | None,
        typer.Option(help="Restrict to a specific package name."),
    ] = None,
    version: Annotated[
        str | None,
        typer.Option(help="Restrict to a specific package version."),
    ] = None,
) -> None:
    """
    Print the IR entry for a given qualified name, without rendering.

    Looks up an ingested document in ~/.papyri/ingest/ and prints its
    decoded structure, backrefs, and forward refs. Intended as a
    maintainer-side debug tool for inspecting the IR.
    """
    from rich.console import Console
    from rich.pretty import Pretty
    from rich.rule import Rule

    from papyri.config import ingest_dir
    from papyri.graphstore import GraphStore
    from papyri.nodes import encoder

    console = Console()

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
            typer.echo(
                f"unrecognised qualname format: {qualname!r} "
                "(expected package/version/kind/identifier)",
                err=True,
            )
            raise typer.Exit(1)

    store = GraphStore(ingest_dir, {})
    matches = [
        k for k in store.glob((package, version, kind, path_part)) if k.kind != "assets"
    ]

    if not matches:
        typer.echo(
            f"no IR entry found for {qualname!r} "
            f"(package={package!r}, version={version!r}, kind={kind!r}). "
            "Have you run `papyri ingest` yet?",
            err=True,
        )
        raise typer.Exit(1)

    for it in sorted(matches):
        console.print(
            Rule(
                f"[bold]{it.module}[/bold] [dim]{it.version}[/dim]"
                f" · [yellow]{it.kind}[/yellow] · [cyan]{it.path}[/cyan]"
            )
        )
        try:
            data, backrefs, forward_refs = store.get_all(it)
        except Exception as e:
            console.print(f"  [red]error reading:[/red] {e}")
            continue

        try:
            obj = encoder.decode(data)
        except Exception as e:
            console.print(f"  [red]error decoding:[/red] {e}")
            continue

        console.print(Pretty(obj))
        if backrefs:
            console.print("\n[bold]Backrefs[/bold]")
            for b in sorted(backrefs):
                console.print(
                    f"  [dim]{b.module} {b.version}[/dim]"
                    f" [yellow]{b.kind}[/yellow] [cyan]{b.path}[/cyan]"
                )
        if forward_refs:
            console.print("\n[bold]Forward refs[/bold]")
            for f in sorted(forward_refs):
                console.print(
                    f"  [dim]{f.module} {f.version}[/dim]"
                    f" [yellow]{f.kind}[/yellow] [cyan]{f.path}[/cyan]"
                )
