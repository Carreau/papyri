"""``papyri gen`` — produce a DocBundle from a TOML configuration file."""

from __future__ import annotations

from typing import Annotated

import typer


def _find_toml() -> list[str]:
    from glob import glob

    return glob("**/*.toml", recursive=True)


def gen(
    file: Annotated[
        str,
        typer.Argument(
            help="toml configuration file",
            autocompletion=_find_toml,
        ),
    ],
    infer: bool | None = typer.Option(
        True, help="Whether to run type inference on code examples."
    ),
    exec: bool | None = typer.Option(
        None, help="Whether to attempt to execute docstring code examples."
    ),
    debug: bool = False,
    no_progress: bool = typer.Option(
        False,
        "--no-progress",
        is_flag=True,
        help="Disable progress bars (useful in CI or with debuggers).",
    ),
    dry_run: bool = False,
    api: bool = True,
    examples: bool = True,
    narrative: bool = True,
    fail: bool = typer.Option(False, help="Fail on first error."),
    fail_early: bool = typer.Option(False, help="Override early error option."),
    fail_unseen_error: bool = typer.Option(
        False, help="Fail on any previously unseen error."
    ),
    only: list[str] = typer.Option(
        None,
        "--only",
        help="Restrict generation to these qualified names (repeatable).",
    ),
) -> None:
    """
    Generate documentation IR for a given package.

    First item should be the root package to import; if subpackages need to be
    analyzed but are not accessible from the root pass them as extra arguments.

    This takes a single file and builds the IR for a single package. Building
    for multiple packages may have side effects (for example importing seaborn
    changes matplotlib defaults).
    """
    import os
    from os.path import join

    from IPython.utils.tempdir import TemporaryWorkingDirectory

    from papyri.gen import gen_main

    here = os.getcwd()

    with TemporaryWorkingDirectory():
        gen_main(
            infer=infer,
            exec_=exec,
            target_file=join(here, file),
            debug=debug,
            dummy_progress=no_progress,
            dry_run=dry_run,
            api=api,
            examples=examples,
            fail=fail,
            narrative=narrative,
            fail_early=fail_early,
            fail_unseen_error=fail_unseen_error,
            limit_to=only,
        )
