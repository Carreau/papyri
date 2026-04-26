"""``papyri bootstrap`` — write a starter TOML config for a package."""

from __future__ import annotations

from pathlib import Path

import typer


def bootstrap(file: str) -> None:
    """
    Create a basic TOML configuration file for ``papyri gen``.

    The resulting file has a single ``[global]`` section with ``module``
    set to the chosen package name. See ``examples/`` for richer
    configurations (``submodules``, ``docs_path``, ``execute_doctests``,
    ``[meta]``, ``[global.expected_errors]``, ...).
    """
    import tomli_w

    p = Path(file)
    if p.exists():
        typer.echo(f"{p} already exists", err=True)
        raise typer.Exit(1)
    name = input(f"package name [{p.stem}]:")
    if not name:
        name = p.stem
    p.write_text(tomli_w.dumps({"global": {"module": name}}))
