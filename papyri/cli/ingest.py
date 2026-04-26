"""``papyri ingest`` — merge a DocBundle into the local cross-linked store."""

from __future__ import annotations

from pathlib import Path

import typer


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
) -> None:
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
    from papyri import crosslink as cr

    for p in paths:
        cr.main(Path(p), check, dummy_progress=no_progress)
    if relink:
        cr.relink(dummy_progress=no_progress)
