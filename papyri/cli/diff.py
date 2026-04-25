"""``papyri diff`` — compare two ingested versions of one package by content digest.

Operates purely on the digest column written by ``GraphStore.put`` at
ingest time; does not re-decode CBOR blobs.
"""

from __future__ import annotations

from typing import Annotated

import typer


def diff(
    package: Annotated[
        str,
        typer.Argument(help="Package name (e.g. 'numpy')."),
    ],
    version_a: Annotated[
        str,
        typer.Argument(help="First version to compare (the 'old' side)."),
    ],
    version_b: Annotated[
        str,
        typer.Argument(help="Second version to compare (the 'new' side)."),
    ],
    summary_only: Annotated[
        bool,
        typer.Option(
            "--summary",
            help="Print only the added/removed/modified counts, not each page.",
        ),
    ] = False,
) -> None:
    """
    Show pages whose content digest differs between two ingested versions.

    Each page is bucketed as **added** (only in version_b), **removed**
    (only in version_a), or **modified** (different digest on each side).
    Pages whose digests match are not printed.
    """
    from rich.console import Console

    from papyri.config import ingest_dir
    from papyri.graphstore import GraphStore

    console = Console()
    store = GraphStore(ingest_dir, {})
    rows = store.diff_versions(package, version_a, version_b)

    added: list[tuple[str, str]] = []
    removed: list[tuple[str, str]] = []
    modified: list[tuple[str, str]] = []
    for category, identifier, da, db in rows:
        if da is None:
            added.append((category, identifier))
        elif db is None:
            removed.append((category, identifier))
        else:
            modified.append((category, identifier))

    console.print(
        f"[bold]{package}[/bold] [dim]{version_a}[/dim] → [dim]{version_b}[/dim]: "
        f"[green]+{len(added)}[/green] "
        f"[red]-{len(removed)}[/red] "
        f"[yellow]~{len(modified)}[/yellow]"
    )
    if summary_only:
        return

    for label, color, group in [
        ("added", "green", added),
        ("removed", "red", removed),
        ("modified", "yellow", modified),
    ]:
        if not group:
            continue
        console.print(f"\n[bold {color}]{label}[/bold {color}] ({len(group)})")
        for category, identifier in group:
            console.print(f"  [yellow]{category}[/yellow] [cyan]{identifier}[/cyan]")
