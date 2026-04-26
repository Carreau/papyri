"""``papyri drop`` — wipe the local ingested store."""

from __future__ import annotations

import typer


def drop(
    yes: bool = typer.Option(
        False,
        "--yes",
        "-y",
        is_flag=True,
        help="Skip confirmation prompt.",
    ),
) -> None:
    """
    Drop the full local database.
    """
    from papyri import crosslink as cr
    from papyri.config import ingest_dir

    if not yes:
        typer.confirm(
            f"This will delete {ingest_dir} and all ingested data. Continue?",
            abort=True,
        )

    cr.drop()
