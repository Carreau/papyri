"""``papyri upload`` — tar and upload DocBundle directories to a viewer ingest endpoint."""

from __future__ import annotations

import io
import json
import tarfile
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
            help="Paths to DocBundle directories (output of `papyri gen`).",
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
    Tar each DocBundle directory and upload it to the viewer ingest endpoint.

    Reads each bundle directory produced by ``papyri gen`` (typically
    ``~/.papyri/data/<pkg>_<version>/``), packs it as a gzip-compressed tar
    archive, and PUTs the archive to the viewer's ``/api/bundle`` endpoint.

    The endpoint runs the full ingest pipeline server-side, so no local
    ``papyri ingest`` step is needed after uploading.
    """
    ok = True
    for path in paths:
        path = path.expanduser().resolve()
        if not path.is_dir():
            typer.echo(f"error: {path} is not a directory", err=True)
            ok = False
            continue

        meta_path = path / "papyri.json"
        if not meta_path.exists():
            typer.echo(
                f"error: {path} does not contain papyri.json — is this a DocBundle?",
                err=True,
            )
            ok = False
            continue

        try:
            meta = json.loads(meta_path.read_text())
            pkg = meta.get("module", "<unknown>")
            version = meta.get("version", "<unknown>")
        except Exception as exc:
            typer.echo(
                f"warning: could not read papyri.json in {path}: {exc}", err=True
            )
            pkg = version = "<unknown>"

        typer.echo(f"uploading {pkg} {version} from {path} …")

        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            for item in sorted(path.rglob("*")):
                tar.add(item, arcname=str(item.relative_to(path)))
        data = buf.getvalue()

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
