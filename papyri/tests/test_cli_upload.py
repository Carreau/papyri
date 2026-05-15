"""Tests for the ``papyri upload`` CLI command."""

from __future__ import annotations

import gzip
import io
import json
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock, patch

import cbor2
import typer
from typer.testing import CliRunner

from papyri.bundle import Bundle
from papyri.cli.upload import _DEFAULT_URL, upload
from papyri.node_base import TAG_MAP
from papyri.pack import make_artifact_from_dir

# ---------------------------------------------------------------------------
# Minimal typer app for test invocation
# ---------------------------------------------------------------------------

_app = typer.Typer()
_app.command()(upload)

runner = CliRunner()


# ---------------------------------------------------------------------------
# Bundle helpers
# ---------------------------------------------------------------------------


def _make_bundle(root: Path, pkg: str = "mypkg", version: str = "1.0") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "papyri.json").write_text(json.dumps({"module": pkg, "version": version}))
    (root / "module").mkdir()
    return root


def _mock_response(body: dict, status: int = 200) -> MagicMock:
    """Mock an HTTPResponse for ``papyri upload``'s NDJSON streaming path.

    Single-event responses become a one-line stream: the legacy
    ``{"ok": True, "pkg": ..., "version": ...}`` shape and the new
    ``{"event": "done", "pkg": ..., "version": ...}`` shape both work
    via the client's forward-compatible parser.
    """
    line = json.dumps(body).encode() + b"\n"
    resp = MagicMock()
    resp.read.return_value = line
    resp.status = status
    # The client iterates the response file-like to read NDJSON lines.
    resp.__iter__ = lambda s: iter([line])
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def _mock_stream_response(events: list[dict], status: int = 200) -> MagicMock:
    """Mock an NDJSON-streaming HTTPResponse: one event per yielded line."""
    lines = [json.dumps(e).encode() + b"\n" for e in events]
    resp = MagicMock()
    resp.read.return_value = b"".join(lines)
    resp.status = status
    resp.__iter__ = lambda s: iter(lines)
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


# ---------------------------------------------------------------------------
# CLI validation
# ---------------------------------------------------------------------------


def test_upload_missing_path(tmp_path):
    result = runner.invoke(_app, [str(tmp_path / "nonexistent")])
    assert result.exit_code == 1
    assert "not a .papyri file" in result.output


def test_upload_dir_without_papyri_json(tmp_path):
    tmp_path.mkdir(exist_ok=True)
    result = runner.invoke(_app, [str(tmp_path)])
    assert result.exit_code == 1
    # BundleError surfaces structural problems.
    assert "papyri.json" in result.output or "module/" in result.output


# ---------------------------------------------------------------------------
# Successful upload from a directory (packs on the fly).
# ---------------------------------------------------------------------------


def test_upload_dir_success(tmp_path):
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"}, 201)

    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        result = runner.invoke(_app, [str(bundle)])

    assert result.exit_code == 0, result.output
    assert "mypkg" in result.output
    assert "1.0" in result.output

    call_args = mock_open.call_args
    req: urllib.request.Request = call_args[0][0]
    assert req.get_method() == "PUT"
    assert req.get_header("Content-type") == "application/gzip"
    assert req.full_url == _DEFAULT_URL


def test_upload_custom_url(tmp_path):
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"})

    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        result = runner.invoke(
            _app, [str(bundle), "--url", "http://example.com/api/bundle"]
        )

    assert result.exit_code == 0
    req: urllib.request.Request = mock_open.call_args[0][0]
    assert req.full_url == "http://example.com/api/bundle"


def test_upload_streams_progress_events(tmp_path):
    """NDJSON streaming path: progress events surface to stderr, the
    final `done` event drives the success summary, and an `error`
    event in the stream causes a non-zero exit."""
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    resp = _mock_stream_response(
        [
            {"event": "start", "pkg": "mypkg", "version": "1.0"},
            {"event": "progress", "phase": "module", "done": 25, "total": 50},
            {"event": "progress", "phase": "module", "done": 50, "total": 50},
            {"event": "done", "pkg": "mypkg", "version": "1.0"},
        ]
    )
    with patch("urllib.request.urlopen", return_value=resp):
        result = runner.invoke(_app, [str(bundle)])
    assert result.exit_code == 0, result.output
    assert "module: 25/50" in result.output
    assert "module: 50/50" in result.output
    assert "ok: mypkg 1.0" in result.output


def test_upload_stream_error_event(tmp_path):
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    resp = _mock_stream_response(
        [
            {"event": "start", "pkg": "mypkg", "version": "1.0"},
            {"event": "error", "error": "ingest failed: boom"},
        ]
    )
    with patch("urllib.request.urlopen", return_value=resp):
        result = runner.invoke(_app, [str(bundle)])
    assert result.exit_code == 1
    assert "ingest failed: boom" in result.output


def test_upload_sends_a_papyri_artifact(tmp_path):
    """The wire bytes are a gzip-wrapped CBOR Bundle, not a tarball."""
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"})
    captured: list[bytes] = []

    def fake_urlopen(req: urllib.request.Request):
        assert isinstance(req.data, bytes)
        captured.append(req.data)
        return resp

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        runner.invoke(_app, [str(bundle)])

    assert captured, "urlopen was never called"
    data = captured[0]
    assert data[:2] == b"\x1f\x8b", "expected gzip magic"
    decoded = cbor2.loads(gzip.decompress(data))
    assert isinstance(decoded, cbor2.CBORTag)
    assert decoded.tag == TAG_MAP[Bundle]


def test_upload_dir_and_artifact_send_identical_bytes(tmp_path):
    """
    Uploading <dir> and uploading <dir-packed-into-.papyri> must result in
    the same bytes on the wire — the artifact contract is the same in both
    cases.
    """
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    artifact_bytes, _ = make_artifact_from_dir(bundle)
    artifact_path = tmp_path / "mypkg-1.0.papyri"
    artifact_path.write_bytes(artifact_bytes)

    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"})
    captured: list[bytes] = []

    def fake_urlopen(req: urllib.request.Request):
        assert isinstance(req.data, bytes)
        captured.append(req.data)
        return resp

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        runner.invoke(_app, [str(bundle)])
        runner.invoke(_app, [str(artifact_path)])

    assert len(captured) == 2
    assert captured[0] == captured[1]


# ---------------------------------------------------------------------------
# Multiple inputs.
# ---------------------------------------------------------------------------


def test_upload_multiple_bundles(tmp_path):
    b1 = _make_bundle(tmp_path / "pkg1_1.0", pkg="pkg1", version="1.0")
    b2 = _make_bundle(tmp_path / "pkg2_2.0", pkg="pkg2", version="2.0")
    resp = _mock_response({"ok": True, "pkg": "x", "version": "y"})

    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        result = runner.invoke(_app, [str(b1), str(b2)])

    assert result.exit_code == 0
    assert mock_open.call_count == 2


def test_upload_continues_after_first_failure(tmp_path):
    """A network error on the first bundle must not skip the second."""
    b1 = _make_bundle(tmp_path / "pkg1_1.0", pkg="pkg1")
    b2 = _make_bundle(tmp_path / "pkg2_1.0", pkg="pkg2")
    resp_ok = _mock_response({"ok": True, "pkg": "pkg2", "version": "1.0"})

    side_effects = [
        urllib.error.URLError("connection refused"),
        resp_ok,
    ]

    with patch("urllib.request.urlopen", side_effect=side_effects) as mock_open:
        result = runner.invoke(_app, [str(b1), str(b2)])

    assert result.exit_code == 1  # overall failure because one bundle failed
    assert mock_open.call_count == 2  # second bundle still attempted


# ---------------------------------------------------------------------------
# HTTP error handling
# ---------------------------------------------------------------------------


def test_upload_http_error_json(tmp_path):
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    err_body = json.dumps({"ok": False, "error": "bad papyri.json"}).encode()
    http_err = urllib.error.HTTPError(
        url=_DEFAULT_URL,
        code=400,
        msg="Bad Request",
        hdrs=MagicMock(),
        fp=io.BytesIO(err_body),
    )

    with patch("urllib.request.urlopen", side_effect=http_err):
        result = runner.invoke(_app, [str(bundle)])

    assert result.exit_code == 1
    assert "400" in result.output
    assert "bad papyri.json" in result.output


def test_upload_http_error_non_json(tmp_path):
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    http_err = urllib.error.HTTPError(
        url=_DEFAULT_URL,
        code=500,
        msg="Internal Server Error",
        hdrs=MagicMock(),
        fp=io.BytesIO(b"not json"),
    )

    with patch("urllib.request.urlopen", side_effect=http_err):
        result = runner.invoke(_app, [str(bundle)])

    assert result.exit_code == 1
    assert "500" in result.output


def test_upload_url_error(tmp_path):
    bundle = _make_bundle(tmp_path / "mypkg_1.0")

    with patch(
        "urllib.request.urlopen",
        side_effect=urllib.error.URLError("connection refused"),
    ):
        result = runner.invoke(_app, [str(bundle)])

    assert result.exit_code == 1
    assert "connection refused" in result.output


# ---------------------------------------------------------------------------
# ZIP input
# ---------------------------------------------------------------------------


def _make_zip_with_artifact(zip_path: Path, artifact_bytes: bytes, name: str) -> None:
    import zipfile

    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr(name, artifact_bytes)


def test_upload_zip_success(tmp_path):
    bundle_dir = _make_bundle(tmp_path / "mypkg_1.0")
    artifact_bytes, _ = make_artifact_from_dir(bundle_dir)
    zip_path = tmp_path / "mypkg-1.0.zip"
    _make_zip_with_artifact(zip_path, artifact_bytes, "mypkg-1.0.papyri")

    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"})
    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        result = runner.invoke(_app, [str(zip_path)])

    assert result.exit_code == 0, result.output
    assert "mypkg" in result.output
    req: urllib.request.Request = mock_open.call_args[0][0]
    assert req.get_method() == "PUT"
    assert req.get_header("Content-type") == "application/gzip"


def test_upload_zip_sends_same_bytes_as_artifact(tmp_path):
    """Uploading via zip must put the same bytes on the wire as the raw artifact."""
    bundle_dir = _make_bundle(tmp_path / "mypkg_1.0")
    artifact_bytes, _ = make_artifact_from_dir(bundle_dir)
    artifact_path = tmp_path / "mypkg-1.0.papyri"
    artifact_path.write_bytes(artifact_bytes)
    zip_path = tmp_path / "mypkg-1.0.zip"
    _make_zip_with_artifact(zip_path, artifact_bytes, "mypkg-1.0.papyri")

    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"})
    captured: list[bytes] = []

    def fake_urlopen(req: urllib.request.Request):
        captured.append(req.data)  # type: ignore[arg-type]
        return resp

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        runner.invoke(_app, [str(artifact_path)])
        runner.invoke(_app, [str(zip_path)])

    assert len(captured) == 2
    assert captured[0] == captured[1]


def test_upload_zip_no_papyri_file(tmp_path):
    import zipfile

    zip_path = tmp_path / "empty.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("readme.txt", "hello")

    result = runner.invoke(_app, [str(zip_path)])
    assert result.exit_code == 1
    assert "no .papyri file" in result.output


def test_upload_zip_multiple_papyri_files(tmp_path):
    import zipfile

    bundle_dir = _make_bundle(tmp_path / "mypkg_1.0")
    artifact_bytes, _ = make_artifact_from_dir(bundle_dir)
    zip_path = tmp_path / "multi.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("a.papyri", artifact_bytes)
        zf.writestr("b.papyri", artifact_bytes)

    result = runner.invoke(_app, [str(zip_path)])
    assert result.exit_code == 1
    assert "2 .papyri files" in result.output
