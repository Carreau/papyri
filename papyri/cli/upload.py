"""``papyri upload`` — push a ``.papyri`` artifact (or a DocBundle directory) to a viewer ingest endpoint."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Annotated

import typer

_DEFAULT_URL = "http://localhost:4321/api/bundle"


def upload(
    paths: Annotated[
        list[Path],
        typer.Argument(
            help=(
                "Paths to upload. Each path is either a ``.papyri`` artifact "
                "(produced by ``papyri pack``) or a DocBundle directory "
                "(packed on the fly, output unchanged from ``papyri gen``)."
            ),
        ),
    ],
    url: Annotated[
        str,
        typer.Option(
            "--url",
            "-u",
            envvar="PAPYRI_UPLOAD_URL",
            help="URL of the viewer ingest endpoint.  Overridden by $PAPYRI_UPLOAD_URL.",
        ),
    ] = _DEFAULT_URL,
    token: Annotated[
        str | None,
        typer.Option(
            "--token",
            "-t",
            envvar="PAPYRI_UPLOAD_TOKEN",
            help=(
                "Bearer token for /api/bundle authentication.  "
                "Overridden by $PAPYRI_UPLOAD_TOKEN.  "
                "Omit when the viewer has no token configured (local dev)."
            ),
        ),
    ] = None,
    verbose: Annotated[
        bool,
        typer.Option(
            "--verbose",
            "-v",
            help="Show per-step packing progress when building a bundle on the fly.",
        ),
    ] = False,
) -> None:
    """
    Send each ``.papyri`` artifact (or pack a DocBundle directory on the
    fly) to the viewer ingest endpoint.

    Bundle directories are passed through ``papyri.pack.make_artifact_from_dir``
    so the bytes on the wire are identical to what ``papyri pack`` would
    produce — same validation, same byte-reproducibility guarantees.
    The viewer's ``/api/bundle`` endpoint runs the full ingest pipeline
    server-side; this is the canonical way to ship a bundle into the
    cross-linked graph.

    Authentication: if the viewer has ``PAPYRI_UPLOAD_TOKEN`` configured,
    set the same value here (via ``--token`` or ``$PAPYRI_UPLOAD_TOKEN``)
    so the request is accepted.
    """
    import time

    from papyri.pack import BundleError, load_artifact, make_artifact_from_dir

    ok = True
    total = len(paths)
    width = len(str(total))
    for i, path in enumerate(paths, start=1):
        path = path.expanduser().resolve()
        prefix = f"[{i:>{width}}/{total}]"

        log = (
            (lambda msg, _p=prefix: typer.echo(f"{_p} {msg}", err=True))
            if verbose
            else None
        )
        try:
            if path.is_file() and path.suffix == ".papyri":
                typer.echo(f"{prefix} loading {path.name} …", err=True)
                data = path.read_bytes()
                bundle = load_artifact(data)
                pkg, version = bundle.module, bundle.version
            elif path.is_dir():
                typer.echo(f"{prefix} packing {path.name} …", err=True)
                data, bundle = make_artifact_from_dir(path, log=log)
                pkg, version = bundle.module, bundle.version
            else:
                typer.echo(
                    f"{prefix} error: {path} is not a .papyri file or a directory",
                    err=True,
                )
                ok = False
                continue
        except BundleError as exc:
            typer.echo(f"{prefix} error: {exc}", err=True)
            ok = False
            continue
        except Exception as exc:
            typer.echo(f"{prefix} error: failed to load {path}: {exc}", err=True)
            ok = False
            continue

        size_mb = len(data) / (1024 * 1024)
        typer.echo(
            f"{prefix} uploading {pkg} {version} ({size_mb:.2f} MiB) → {url}",
            err=True,
        )

        headers: dict[str, str] = {"Content-Type": "application/gzip"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(url, data=data, method="PUT", headers=headers)
        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(req) as resp:
                body = json.loads(resp.read())
            elapsed = time.monotonic() - t0
            typer.echo(
                f"{prefix} ok: {body.get('pkg')} {body.get('version')} "
                f"ingested in {elapsed:.1f}s (HTTP {resp.status})",
                err=True,
            )
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                body = json.loads(raw)
                msg = body.get("error", raw.decode(errors="replace"))
            except Exception:
                msg = raw.decode(errors="replace")
            typer.echo(f"{prefix} error (HTTP {exc.code}): {msg}", err=True)
            ok = False
        except urllib.error.URLError as exc:
            typer.echo(f"{prefix} error: {exc.reason}", err=True)
            ok = False

    if not ok:
        raise typer.Exit(1)
