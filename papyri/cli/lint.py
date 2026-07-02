"""``papyri lint`` — check a DocBundle directory for IR consistency issues without packing."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer


def lint(
    bundle_dir: Annotated[
        Path,
        typer.Argument(help="Path to a DocBundle directory (output of `papyri gen`)."),
    ],
) -> None:
    """Check a DocBundle for IR consistency issues without producing a .papyri artifact.

    Runs the following checks:

    - Unresolved SubstitutionRef/SubstitutionDef nodes (should have been replaced)
    - Referenced assets that are missing from the asset store
    - DocstringSentinel placeholders (module docstrings numpydoc could not parse)
    - Unresolved LocalRef nodes (should only exist if target is present)
    """
    from papyri.pack import lint_bundle, read_bundle_dir

    bundle_dir = bundle_dir.expanduser().resolve()
    try:
        bundle = read_bundle_dir(bundle_dir)
    except Exception as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc

    issues = lint_bundle(bundle)
    if not issues:
        typer.echo("✓ no issues found")
        return

    for issue in issues:
        typer.echo(f"lint: {issue}", err=True)
    raise typer.Exit(1)
