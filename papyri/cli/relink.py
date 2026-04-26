"""``papyri relink`` — rescan all ingested docs to find new crosslinks."""

from __future__ import annotations

import typer


def relink(
    no_progress: bool = typer.Option(
        False,
        "--no-progress",
        is_flag=True,
        help="Disable progress bars (useful in CI or with debuggers).",
    ),
) -> None:
    """
    Rescan all the documentation to find potential new crosslinks.
    """
    from papyri import crosslink as cr

    cr.relink(dummy_progress=no_progress)
