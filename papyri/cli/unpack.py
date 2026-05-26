"""``papyri unpack`` — explode a ``.papyri`` artifact back into a JSON DocBundle directory."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer


def unpack(
    artifact: Annotated[
        Path,
        typer.Argument(
            help="Path to a `.papyri` artifact (output of `papyri pack`).",
        ),
    ],
    output: Annotated[
        Path | None,
        typer.Option(
            "--output",
            "-o",
            help=(
                "Parent directory in which to create the bundle directory. "
                "The directory is always named '<module>_<version>'. "
                "Default: the current directory."
            ),
        ),
    ] = None,
    verbose: Annotated[
        bool,
        typer.Option(
            "--verbose",
            "-v",
            help="Show per-step unpacking progress.",
        ),
    ] = False,
) -> None:
    """
    Decode a ``.papyri`` artifact and write its contents out as a
    human-readable JSON DocBundle directory (the same layout ``papyri gen``
    produces: ``papyri.json``, ``toc.json``, ``module/``, ``docs/``,
    ``examples/``, ``assets/``).

    The bundle directory is named ``<module>_<version>`` and created under the
    output directory (the current directory by default). The command fails if
    that directory already exists.
    """
    from papyri.pack import BundleError, explode_artifact_to_dir

    artifact = artifact.expanduser()
    if not artifact.is_file():
        typer.echo(f"error: {artifact} is not a file", err=True)
        raise typer.Exit(1)

    dest_parent = (output.expanduser() if output is not None else Path.cwd()).resolve()

    log = (lambda msg: typer.echo(msg, err=True)) if verbose else None
    if verbose:
        typer.echo(f"unpacking {artifact.name} …", err=True)

    try:
        out_dir = explode_artifact_to_dir(artifact, dest_parent, log=log)
    except BundleError as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc

    typer.echo(f"wrote {out_dir}")
