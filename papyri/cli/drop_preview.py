"""``papyri drop-preview`` — delete a pull-request documentation preview."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from importlib.metadata import PackageNotFoundError, version
from typing import Annotated

import typer

try:
    _PAPYRI_VERSION = version("papyri")
except PackageNotFoundError:
    _PAPYRI_VERSION = "0+unknown"

_TIMEOUT_S = 60


def _preview_endpoint(upload_url: str) -> str:
    """Map an upload endpoint (``…/api/bundle``) to ``…/api/preview``."""
    parsed = urllib.parse.urlsplit(upload_url)
    path = parsed.path.rstrip("/")
    if path.endswith("/bundle"):
        path = path[: -len("/bundle")] + "/preview"
    else:
        path = path + "/preview"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def drop_preview(
    to: Annotated[
        str | None,
        typer.Option("--to", help="Named upload target from ~/.papyri/config.toml."),
    ] = None,
    url: Annotated[
        str | None,
        typer.Option(
            "--url",
            "-u",
            help=(
                "Viewer ingest endpoint (…/api/bundle); the preview endpoint is "
                "derived from it. Defaults to $PAPYRI_UPLOAD_URL."
            ),
        ),
    ] = None,
    token: Annotated[
        str | None,
        typer.Option(
            "--token",
            "-t",
            help="Bearer token. Defaults to $PAPYRI_UPLOAD_TOKEN.",
        ),
    ] = None,
    preview_id: Annotated[
        str | None,
        typer.Option(
            "--preview-id",
            help=(
                "Preview to drop, as 'owner/repo#42'. Requires the "
                "deployment-wide upload token. Omit it in GitHub Actions: the "
                "OIDC token names the pull request itself."
            ),
        ),
    ] = None,
    oidc_audience: Annotated[
        str | None,
        typer.Option(
            "--oidc-audience",
            help=(
                "Audience to request for the OIDC token.  Overrides "
                "$PAPYRI_OIDC_AUDIENCE and the value the viewer publishes at "
                "/api/oidc/audience."
            ),
        ),
    ] = None,
) -> None:
    """
    Drop the documentation preview for a pull request.

    Run this from the workflow that reacts to a pull request being closed or
    merged: it deletes the preview's database, blobs, and raw archive in one
    step. Previews also expire on their own, so a missed drop costs storage for
    a while, not forever.

    Authentication mirrors ``papyri upload --preview``: inside GitHub Actions
    (``permissions: id-token: write``) the OIDC token names the pull request,
    and no ``--preview-id`` is needed. Outside CI, pass ``--preview-id`` with
    the deployment-wide upload token.
    """
    from papyri.cli.upload import _resolve_upload_params

    try:
        effective_url, effective_token = _resolve_upload_params(url, token, to)
    except (KeyError, ValueError, RuntimeError) as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc

    endpoint = _preview_endpoint(effective_url)
    if preview_id:
        endpoint += "?" + urllib.parse.urlencode({"id": preview_id})
    else:
        from papyri.github_oidc import (
            OidcUnavailable,
            request_id_token,
            resolve_audience,
        )

        try:
            effective_token = request_id_token(
                resolve_audience(effective_url, oidc_audience)
            )
        except OidcUnavailable as exc:
            typer.echo(f"error: {exc}", err=True)
            typer.echo(
                "hint: pass --preview-id owner/repo#42 with an upload token to "
                "drop a preview outside GitHub Actions",
                err=True,
            )
            raise typer.Exit(1) from exc

    parsed = urllib.parse.urlsplit(endpoint)
    headers = {
        "User-Agent": f"papyri-upload/{os.environ.get('PAPYRI_VERSION', _PAPYRI_VERSION)}",
        "Origin": f"{parsed.scheme}://{parsed.netloc}",
    }
    if effective_token:
        headers["Authorization"] = f"Bearer {effective_token}"

    req = urllib.request.Request(endpoint, method="DELETE", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            msg = json.loads(raw).get("error", raw.decode(errors="replace"))
        except Exception:
            msg = raw.decode(errors="replace")
        typer.echo(f"error (HTTP {exc.code}): {msg}", err=True)
        raise typer.Exit(1) from exc
    except urllib.error.URLError as exc:
        typer.echo(f"error: {exc.reason}", err=True)
        raise typer.Exit(1) from exc

    if body.get("dropped"):
        typer.echo(f"dropped preview {body.get('id')}", err=True)
    else:
        # Idempotent by design: a PR closed twice, or closed before any
        # preview was uploaded, is not an error.
        typer.echo(f"no live preview for {body.get('id')} (nothing to drop)", err=True)
