"""``papyri about`` — show the logo, version, and a short description."""

from __future__ import annotations

import typer


def about() -> None:
    """
    Show the logo, version, and a short description of papyri.
    """
    from papyri import __version__, logo

    typer.echo(logo.strip())
    typer.echo(f"papyri {__version__}")
    typer.echo(
        "\nGenerate and ingest Python documentation IR for cross-linked browsing."
    )
    typer.echo("https://github.com/carreau/papyri")
