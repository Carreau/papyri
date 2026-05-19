"""``papyri upload`` — push a ``.papyri`` artifact, a ``.zip`` containing one, or a DocBundle directory to a viewer ingest endpoint."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

if TYPE_CHECKING:
    from papyri.bundle import Bundle

import typer

try:
    _PAPYRI_VERSION = version("papyri")
except PackageNotFoundError:
    _PAPYRI_VERSION = "0+unknown"

_DEFAULT_URL = "http://localhost:4321/api/bundle"


def _load_from_zip(path: Path) -> tuple[bytes, Bundle]:
    """Extract and load the single ``.papyri`` artifact from a zip file.

    Raises ``BundleError`` if the zip contains zero or more than one ``.papyri``
    member, or if the artifact itself is invalid.
    """
    import zipfile

    from papyri.pack import BundleError, load_artifact

    with zipfile.ZipFile(path, "r") as zf:
        papyri_members = [n for n in zf.namelist() if n.endswith(".papyri")]
        if len(papyri_members) == 0:
            raise BundleError(f"{path.name} contains no .papyri file")
        if len(papyri_members) > 1:
            names = ", ".join(papyri_members)
            raise BundleError(
                f"{path.name} contains {len(papyri_members)} .papyri files "
                f"({names}); expected exactly one"
            )
        data = zf.read(papyri_members[0])

    bundle = load_artifact(data)
    return data, bundle


def upload(
    paths: Annotated[
        list[Path],
        typer.Argument(
            help=(
                "Paths to upload. Each path is a ``.papyri`` artifact "
                "(produced by ``papyri pack``), a ``.zip`` file containing "
                "exactly one ``.papyri`` artifact, or a DocBundle directory "
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

    Accepted input forms:

    - ``.papyri`` file: loaded directly.
    - ``.zip`` file: must contain exactly one ``.papyri`` member; that
      member is extracted and uploaded.  The zip is validated before the
      network request is made.
    - DocBundle directory: passed through ``papyri.pack.make_artifact_from_dir``
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
            elif path.is_file() and path.suffix == ".zip":
                typer.echo(f"{prefix} inspecting {path.name} …", err=True)
                data, bundle = _load_from_zip(path)
                pkg, version = bundle.module, bundle.version
            elif path.is_dir():
                typer.echo(f"{prefix} packing {path.name} …", err=True)
                data, bundle = make_artifact_from_dir(path, log=log)
                pkg, version = bundle.module, bundle.version
            else:
                typer.echo(
                    f"{prefix} error: {path} is not a .papyri file, a .zip file, or a directory",
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

        # User-Agent: Cloudflare's default bot protection on *.workers.dev
        # rejects urllib's `Python-urllib/3.x` UA with a 1010 before the
        # request reaches the worker. Send a real identifier.
        # Origin: Astro's CSRF protection (`security.checkOrigin`, on by
        # default in Astro 6+) blocks PUTs whose Origin doesn't match the
        # request host with "Cross-site PUT form submissions are forbidden".
        # `/api/bundle` is meant for cross-origin CLI use, so we set Origin
        # to the upload URL's own scheme+host to satisfy the check.
        parsed = urllib.parse.urlsplit(url)
        headers: dict[str, str] = {
            "Content-Type": "application/gzip",
            "User-Agent": f"papyri-upload/{_PAPYRI_VERSION}",
            "Origin": f"{parsed.scheme}://{parsed.netloc}",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(url, data=data, method="PUT", headers=headers)
        t0 = time.monotonic()
        try:
            with urllib.request.urlopen(req) as resp:
                # The server streams NDJSON: one JSON event per line.
                # Read line-by-line so progress events surface in real
                # time on the terminal — important when the worker would
                # otherwise look hung for tens of seconds.
                final: dict[str, object] | None = None
                err_msg: str | None = None
                while True:
                    raw_line = resp.readline()
                    if not raw_line:
                        break
                    line = raw_line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError as e:
                        err_msg = f"unparseable server response: {e}"
                        break
                    kind = event.get("event")
                    elapsed = event.get("elapsed_s")
                    since = event.get("since_last_ms")
                    # Server may decorate every event with timing fields
                    # (elapsed_s seconds since the stream opened, since_last_ms
                    # since the previous event). Render them when present so
                    # the client shows live progress in real time despite
                    # console.log being unbuffered on the worker side.
                    suffix = ""
                    if elapsed is not None and since is not None:
                        suffix = f" [t={elapsed}s Δ={since}ms]"
                    if kind == "start":
                        typer.echo(
                            f"{prefix} server: starting ingest of "
                            f"{event.get('pkg')} {event.get('version')}{suffix}",
                            err=True,
                        )
                    elif kind == "progress":
                        typer.echo(
                            f"{prefix} {event.get('phase')}: "
                            f"{event.get('done')}/{event.get('total')}{suffix}",
                            err=True,
                        )
                    elif kind == "done":
                        final = event
                    elif kind == "error":
                        err_msg = str(event.get("error", "ingest failed"))
                    # Unknown event kinds: ignore forward-compatibly.
            elapsed = time.monotonic() - t0
            if err_msg is not None:
                typer.echo(f"{prefix} error: {err_msg}", err=True)
                ok = False
            elif final is None:
                typer.echo(
                    f"{prefix} error: server stream closed without a "
                    "done or error event",
                    err=True,
                )
                ok = False
            else:
                typer.echo(
                    f"{prefix} ok: {final.get('pkg')} {final.get('version')} "
                    f"ingested in {elapsed:.1f}s",
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
