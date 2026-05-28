"""Tests for the ``papyri upload`` CLI command."""

from __future__ import annotations

import gzip
import io
import json
import textwrap
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
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


def _mock_response(body: dict[str, Any], status: int = 200) -> MagicMock:
    """Mock an HTTPResponse for ``papyri upload``'s NDJSON streaming path.

    The supplied ``body`` is emitted as a single ``done`` event on the
    NDJSON stream — enough to drive the upload's success summary in
    tests that don't care about per-phase progress.
    """
    event = {"event": "done", **body}
    raw = json.dumps(event).encode() + b"\n"
    resp = MagicMock()
    resp.status = status
    # The client reads the response line-by-line via readline().
    # Reset the buffer on each __enter__ so the same mock can be reused
    # across multiple urlopen calls (e.g. multi-bundle tests).
    buf = io.BytesIO(raw)
    resp.readline = buf.readline

    def _enter(s: MagicMock) -> MagicMock:
        buf.seek(0)
        return s

    resp.__enter__ = _enter
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def _mock_stream_response(events: list[dict[str, Any]], status: int = 200) -> MagicMock:
    """Mock an NDJSON-streaming HTTPResponse: one event per yielded line."""
    raw = b"".join(json.dumps(e).encode() + b"\n" for e in events)
    resp = MagicMock()
    resp.status = status
    buf = io.BytesIO(raw)
    resp.readline = buf.readline

    def _enter(s: MagicMock) -> MagicMock:
        buf.seek(0)
        return s

    resp.__enter__ = _enter
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def _mock_exists_response(exists: bool = False) -> MagicMock:
    """Mock the GET /api/bundle existence-check response (a single JSON body)."""
    raw = json.dumps({"ok": True, "exists": exists}).encode()
    resp = MagicMock()
    resp.status = 200
    resp.read = MagicMock(return_value=raw)
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


# ---------------------------------------------------------------------------
# CLI validation
# ---------------------------------------------------------------------------


def test_upload_missing_path(tmp_path: Any) -> None:
    result = runner.invoke(_app, [str(tmp_path / "nonexistent")])
    assert result.exit_code == 1
    assert "not a .papyri file" in result.output


def test_upload_dir_without_papyri_json(tmp_path: Any) -> None:
    tmp_path.mkdir(exist_ok=True)
    result = runner.invoke(_app, [str(tmp_path)])
    assert result.exit_code == 1
    # BundleError surfaces structural problems.
    assert "papyri.json" in result.output or "module/" in result.output


# ---------------------------------------------------------------------------
# Successful upload from a directory (packs on the fly).
# ---------------------------------------------------------------------------


def test_upload_dir_success(tmp_path: Any) -> None:
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


def test_upload_custom_url(tmp_path: Any) -> None:
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"})

    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        result = runner.invoke(
            _app, [str(bundle), "--url", "http://example.com/api/bundle"]
        )

    assert result.exit_code == 0
    req: urllib.request.Request = mock_open.call_args[0][0]
    assert req.full_url == "http://example.com/api/bundle"


def test_upload_streams_progress_events(tmp_path: Any) -> None:
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


def test_upload_stream_error_event(tmp_path: Any) -> None:
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


def test_upload_sends_a_papyri_artifact(tmp_path: Any) -> None:
    """The wire bytes are a gzip-wrapped CBOR Bundle, not a tarball."""
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"})
    captured: list[bytes] = []

    def fake_urlopen(req: urllib.request.Request, **_kwargs: Any) -> Any:
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


def test_upload_dir_and_artifact_send_identical_bytes(tmp_path: Any) -> None:
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
    exists_resp = _mock_exists_response(False)
    captured: list[bytes] = []

    def fake_urlopen(req: urllib.request.Request, **_kwargs: Any) -> Any:
        if req.get_method() == "GET":
            return exists_resp
        assert isinstance(req.data, bytes)
        captured.append(req.data)
        return resp

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        runner.invoke(_app, [str(bundle)])
        runner.invoke(_app, [str(artifact_path)])

    assert len(captured) == 2
    assert captured[0] == captured[1]


# ---------------------------------------------------------------------------
# Deduplication (GET existence check).
# ---------------------------------------------------------------------------


def test_upload_skips_when_already_present(tmp_path: Any) -> None:
    """When the viewer reports the bundle exists, no PUT is sent."""
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    exists_resp = _mock_exists_response(True)

    def fake(req: urllib.request.Request, **_kwargs: Any) -> Any:
        assert req.get_method() == "GET", "no PUT should be issued when bundle exists"
        return exists_resp

    with patch("urllib.request.urlopen", side_effect=fake) as mock_open:
        result = runner.invoke(_app, [str(bundle)])

    assert result.exit_code == 0, result.output
    assert "skipping" in result.output
    assert all(c[0][0].get_method() == "GET" for c in mock_open.call_args_list)


def test_upload_force_bypasses_existence_check(tmp_path: Any) -> None:
    """--force uploads even when the bundle is already present (no GET check)."""
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"})

    def fake(req: urllib.request.Request, **_kwargs: Any) -> Any:
        assert req.get_method() == "PUT", "--force must skip the GET existence check"
        return resp

    with patch("urllib.request.urlopen", side_effect=fake) as mock_open:
        result = runner.invoke(_app, [str(bundle), "--force"])

    assert result.exit_code == 0, result.output
    methods = [c[0][0].get_method() for c in mock_open.call_args_list]
    assert methods == ["PUT"]


# ---------------------------------------------------------------------------
# Multiple inputs.
# ---------------------------------------------------------------------------


def test_upload_multiple_bundles(tmp_path: Any) -> None:
    b1 = _make_bundle(tmp_path / "pkg1_1.0", pkg="pkg1", version="1.0")
    b2 = _make_bundle(tmp_path / "pkg2_2.0", pkg="pkg2", version="2.0")
    resp = _mock_response({"ok": True, "pkg": "x", "version": "y"})
    exists_resp = _mock_exists_response(False)

    def fake(req: urllib.request.Request, **_kwargs: Any) -> Any:
        return exists_resp if req.get_method() == "GET" else resp

    with patch("urllib.request.urlopen", side_effect=fake) as mock_open:
        result = runner.invoke(_app, [str(b1), str(b2)])

    assert result.exit_code == 0
    puts = [c for c in mock_open.call_args_list if c[0][0].get_method() == "PUT"]
    assert len(puts) == 2


def test_upload_continues_after_first_failure(tmp_path: Any) -> None:
    """A network error on the first bundle must not skip the second."""
    b1 = _make_bundle(tmp_path / "pkg1_1.0", pkg="pkg1")
    b2 = _make_bundle(tmp_path / "pkg2_1.0", pkg="pkg2")
    resp_ok = _mock_response({"ok": True, "pkg": "pkg2", "version": "1.0"})
    exists_resp = _mock_exists_response(False)

    # Existence checks (GET) report "not present" so both uploads proceed; the
    # PUT for the first bundle fails, the second succeeds.
    put_results = iter([urllib.error.URLError("connection refused"), resp_ok])

    def fake(req: urllib.request.Request, **_kwargs: Any) -> Any:
        if req.get_method() == "GET":
            return exists_resp
        result = next(put_results)
        if isinstance(result, Exception):
            raise result
        return result

    with patch("urllib.request.urlopen", side_effect=fake) as mock_open:
        result = runner.invoke(_app, [str(b1), str(b2)])

    assert result.exit_code == 1  # overall failure because one bundle failed
    puts = [c for c in mock_open.call_args_list if c[0][0].get_method() == "PUT"]
    assert len(puts) == 2  # second bundle still attempted


# ---------------------------------------------------------------------------
# HTTP error handling
# ---------------------------------------------------------------------------


def test_upload_http_error_json(tmp_path: Any) -> None:
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


def test_upload_http_error_non_json(tmp_path: Any) -> None:
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


def test_upload_url_error(tmp_path: Any) -> None:
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


def test_upload_zip_success(tmp_path: Any) -> None:
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


def test_upload_zip_sends_same_bytes_as_artifact(tmp_path: Any) -> None:
    """Uploading via zip must put the same bytes on the wire as the raw artifact."""
    bundle_dir = _make_bundle(tmp_path / "mypkg_1.0")
    artifact_bytes, _ = make_artifact_from_dir(bundle_dir)
    artifact_path = tmp_path / "mypkg-1.0.papyri"
    artifact_path.write_bytes(artifact_bytes)
    zip_path = tmp_path / "mypkg-1.0.zip"
    _make_zip_with_artifact(zip_path, artifact_bytes, "mypkg-1.0.papyri")

    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"})
    exists_resp = _mock_exists_response(False)
    captured: list[bytes] = []

    def fake_urlopen(req: urllib.request.Request, **_kwargs: Any) -> Any:
        if req.get_method() == "GET":
            return exists_resp
        captured.append(req.data)  # type: ignore[arg-type]
        return resp

    with patch("urllib.request.urlopen", side_effect=fake_urlopen):
        runner.invoke(_app, [str(artifact_path)])
        runner.invoke(_app, [str(zip_path)])

    assert len(captured) == 2
    assert captured[0] == captured[1]


def test_upload_zip_no_papyri_file(tmp_path: Any) -> None:
    import zipfile

    zip_path = tmp_path / "empty.zip"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("readme.txt", "hello")

    result = runner.invoke(_app, [str(zip_path)])
    assert result.exit_code == 1
    assert "no .papyri file" in result.output


def test_upload_zip_multiple_papyri_files(tmp_path: Any) -> None:
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


# ---------------------------------------------------------------------------
# --to named target
# ---------------------------------------------------------------------------


def _write_config(path: Path, content: str) -> None:
    path.write_text(textwrap.dedent(content))


def test_upload_to_named_target_uses_target_url(tmp_path: Path) -> None:
    cfg = tmp_path / "config.toml"
    _write_config(
        cfg,
        """\
        [upload.targets.staging]
        url = "https://staging.example.com/api/bundle"
        token = "stagetoken"
        """,
    )
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"})

    with (
        patch("urllib.request.urlopen", return_value=resp) as mock_open,
        patch("papyri.user_config.USER_CONFIG_PATH", cfg),
    ):
        result = runner.invoke(_app, [str(bundle), "--to", "staging"])

    assert result.exit_code == 0, result.output
    req: urllib.request.Request = mock_open.call_args[0][0]
    assert req.full_url == "https://staging.example.com/api/bundle"
    assert req.get_header("Authorization") == "Bearer stagetoken"


def test_upload_explicit_url_overrides_to(tmp_path: Path) -> None:
    cfg = tmp_path / "config.toml"
    _write_config(
        cfg,
        """\
        [upload.targets.staging]
        url = "https://staging.example.com/api/bundle"
        """,
    )
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"})

    with (
        patch("urllib.request.urlopen", return_value=resp) as mock_open,
        patch("papyri.user_config.USER_CONFIG_PATH", cfg),
    ):
        result = runner.invoke(
            _app,
            [
                str(bundle),
                "--to",
                "staging",
                "--url",
                "http://override.example.com/api/bundle",
            ],
        )

    assert result.exit_code == 0, result.output
    req: urllib.request.Request = mock_open.call_args[0][0]
    assert req.full_url == "http://override.example.com/api/bundle"


def test_upload_to_unknown_target_exits_with_error(tmp_path: Path) -> None:
    cfg = tmp_path / "config.toml"
    _write_config(
        cfg,
        """\
        [upload.targets.localhost]
        url = "http://localhost:4321/api/bundle"
        """,
    )
    bundle = _make_bundle(tmp_path / "mypkg_1.0")

    with patch("papyri.user_config.USER_CONFIG_PATH", cfg):
        result = runner.invoke(_app, [str(bundle), "--to", "production"])

    assert result.exit_code == 1
    assert "production" in result.output


def test_upload_default_target_used_when_no_to(tmp_path: Path) -> None:
    cfg = tmp_path / "config.toml"
    _write_config(
        cfg,
        """\
        [upload]
        default_target = "myserver"

        [upload.targets.myserver]
        url = "http://myserver.example.com/api/bundle"
        """,
    )
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"})

    with (
        patch("urllib.request.urlopen", return_value=resp) as mock_open,
        patch("papyri.user_config.USER_CONFIG_PATH", cfg),
    ):
        result = runner.invoke(_app, [str(bundle)])

    assert result.exit_code == 0, result.output
    req: urllib.request.Request = mock_open.call_args[0][0]
    assert req.full_url == "http://myserver.example.com/api/bundle"


def test_upload_env_var_used_when_no_to_and_no_config(tmp_path: Path) -> None:
    cfg = tmp_path / "nonexistent_config.toml"  # file does not exist
    bundle = _make_bundle(tmp_path / "mypkg_1.0")
    resp = _mock_response({"ok": True, "pkg": "mypkg", "version": "1.0"})

    env_url = "http://envvar.example.com/api/bundle"

    with (
        patch("urllib.request.urlopen", return_value=resp) as mock_open,
        patch("papyri.user_config.USER_CONFIG_PATH", cfg),
        patch(
            "papyri.cli.upload.os.environ.get",
            side_effect=lambda k, d=None: env_url if k == "PAPYRI_UPLOAD_URL" else d,
        ),
    ):
        result = runner.invoke(_app, [str(bundle)])

    assert result.exit_code == 0, result.output
    req: urllib.request.Request = mock_open.call_args[0][0]
    assert req.full_url == env_url
