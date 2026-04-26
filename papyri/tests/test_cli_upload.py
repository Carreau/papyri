"""Tests for the ``papyri upload`` CLI command."""

from __future__ import annotations

import io
import json
import tarfile
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import MagicMock, patch

import typer
from typer.testing import CliRunner

from papyri.cli.upload import _DEFAULT_URL, _make_tarball, upload

# ---------------------------------------------------------------------------
# Minimal typer app for test invocation
# ---------------------------------------------------------------------------

_app = typer.Typer()
_app.command()(upload)

runner = CliRunner()


# ---------------------------------------------------------------------------
# _make_tarball
# ---------------------------------------------------------------------------


def test_make_tarball_creates_valid_gzip(tmp_path):
    (tmp_path / "papyri.json").write_text('{"module":"mypkg","version":"1.0"}')
    (tmp_path / "module").mkdir()
    (tmp_path / "module" / "mypkg.foo.cbor").write_bytes(b"\x00\x01\x02")

    data = _make_tarball(tmp_path)

    assert data[:2] == b"\x1f\x8b", "expected gzip magic bytes"
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        names = {m.name for m in tar.getmembers()}
    assert "papyri.json" in names
    assert "module/mypkg.foo.cbor" in names


def test_make_tarball_contents_correct(tmp_path):
    payload = b"hello bundle"
    (tmp_path / "papyri.json").write_bytes(payload)

    data = _make_tarball(tmp_path)

    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        f = tar.extractfile(tar.getmember("papyri.json"))
        assert f is not None
        assert f.read() == payload


def test_make_tarball_no_leading_slash_in_arcnames(tmp_path):
    (tmp_path / "a.txt").write_bytes(b"x")

    data = _make_tarball(tmp_path)

    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for m in tar.getmembers():
            assert not m.name.startswith("/"), f"absolute path in archive: {m.name}"


# ---------------------------------------------------------------------------
# CLI validation
# ---------------------------------------------------------------------------


def test_upload_missing_dir(tmp_path):
    result = runner.invoke(_app, [str(tmp_path / "nonexistent")])
    assert result.exit_code == 1
    assert "not a directory" in result.output


def test_upload_dir_without_papyri_json(tmp_path):
    result = runner.invoke(_app, [str(tmp_path)])
    assert result.exit_code == 1
    assert "papyri.json" in result.output


def _make_bundle(root: Path, pkg: str = "mypkg", version: str = "1.0") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "papyri.json").write_text(json.dumps({"module": pkg, "version": version}))
    return root


# ---------------------------------------------------------------------------
# Successful upload
# ---------------------------------------------------------------------------


def _mock_response(body: dict, status: int = 201) -> MagicMock:
    resp = MagicMock()
    resp.read.return_value = json.dumps(body).encode()
    resp.status = status
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def test_upload_success(tmp_path):
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"}, 201)

    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        result = runner.invoke(_app, [str(bundle)])

    assert result.exit_code == 0
    assert "mypkg" in result.output
    assert "1.0" in result.output

    # Verify the request was a PUT with the right content-type and default URL.
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


def test_upload_sends_valid_tarball(tmp_path):
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
    assert isinstance(data, bytes)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        names = {m.name for m in tar.getmembers()}
    assert "papyri.json" in names


# ---------------------------------------------------------------------------
# Multiple bundles
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
