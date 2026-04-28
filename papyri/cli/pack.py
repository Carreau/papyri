"""``papyri pack`` — produce a deterministic ``.papyri`` artifact from a DocBundle directory."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

import typer

_DEFAULT_DATA_DIR = Path("~/.papyri/data").expanduser()


def pack(
    bundle_dir: Annotated[
        Path | None,
        typer.Argument(
            help=(
                "Path to a DocBundle directory (output of `papyri gen`). "
                "If omitted, pack every bundle under ~/.papyri/data/."
            ),
        ),
    ] = None,
    output: Annotated[
        Path | None,
        typer.Option(
            "--output",
            "-o",
            help=(
                "Output file path or directory (single-bundle mode only). "
                "If a directory, '<module>-<version>.papyri' is appended. "
                "Default: '<module>-<version>.papyri' next to each bundle "
                "directory (under ~/.papyri/data/ in bulk mode, or in the "
                "current directory in single-bundle mode)."
            ),
        ),
    ] = None,
) -> None:
    """
    Validate a DocBundle directory and write a single deterministic
    ``.papyri`` artifact (gzipped canonical-CBOR ``Bundle`` Node).

    Running pack twice on the same input produces byte-identical output.

    Bulk mode: if no ``bundle_dir`` is given, every directory under
    ``~/.papyri/data/`` is packed in turn and the artifacts are written
    alongside them.
    """
    from papyri.pack import BundleError

    if bundle_dir is None:
        if output is not None:
            typer.echo(
                "error: --output is only valid when packing a single bundle",
                err=True,
            )
            raise typer.Exit(2)
        if not _DEFAULT_DATA_DIR.is_dir():
            typer.echo(f"error: no bundles found under {_DEFAULT_DATA_DIR}", err=True)
            raise typer.Exit(1)
        targets = sorted(p for p in _DEFAULT_DATA_DIR.iterdir() if p.is_dir())
        if not targets:
            typer.echo(f"error: no bundles found under {_DEFAULT_DATA_DIR}", err=True)
            raise typer.Exit(1)
        ok = True
        for target in targets:
            try:
                _pack_one(target, _DEFAULT_DATA_DIR)
            except BundleError as exc:
                raise
                typer.echo(f"error packing {target}: {exc}", err=True)
                ok = False
        if not ok:
            raise typer.Exit(1)
        return

    _pack_one(bundle_dir.expanduser().resolve(), output)


def _pack_one(bundle_dir: Path, output: Path | None) -> None:
    from papyri.pack import make_artifact_from_dir

    data, bundle = make_artifact_from_dir(bundle_dir)
    default_name = f"{bundle.module}-{bundle.version}.papyri"
    if output is None:
        out_path = Path.cwd() / default_name
    else:
        output = output.expanduser()
        out_path = output / default_name if output.is_dir() else output

    out_path.write_bytes(data)
    typer.echo(f"wrote {out_path} ({len(data)} bytes)")
