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
            help="URL of the viewer ingest endpoint.",
        ),
    ] = _DEFAULT_URL,
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
    """
    from papyri.pack import BundleError, load_artifact, make_artifact_from_dir

    ok = True
    for path in paths:
        path = path.expanduser().resolve()

        try:
            if path.is_file() and path.suffix == ".papyri":
                data = path.read_bytes()
                bundle = load_artifact(data)
                pkg, version = bundle.module, bundle.version
            elif path.is_dir():
                data, bundle = make_artifact_from_dir(path)
                pkg, version = bundle.module, bundle.version
            else:
                typer.echo(
                    f"error: {path} is not a .papyri file or a directory",
                    err=True,
                )
                ok = False
                continue
        except BundleError as exc:
            typer.echo(f"error: {exc}", err=True)
            ok = False
            continue
        except Exception as exc:
            typer.echo(f"error: failed to load {path}: {exc}", err=True)
            ok = False
            continue

        typer.echo(f"uploading {pkg} {version} from {path} …")

        req = urllib.request.Request(
            url,
            data=data,
            method="PUT",
            headers={"Content-Type": "application/gzip"},
        )
        try:
            with urllib.request.urlopen(req) as resp:
                body = json.loads(resp.read())
            typer.echo(
                f"  ok: {body.get('pkg')} {body.get('version')} ingested "
                f"(HTTP {resp.status})"
            )
        except urllib.error.HTTPError as exc:
            raw = exc.read()
            try:
                body = json.loads(raw)
                msg = body.get("error", raw.decode(errors="replace"))
            except Exception:
                msg = raw.decode(errors="replace")
            typer.echo(f"  error (HTTP {exc.code}): {msg}", err=True)
            ok = False
        except urllib.error.URLError as exc:
            typer.echo(f"  error: {exc.reason}", err=True)
            ok = False

    if not ok:
        raise typer.Exit(1)
