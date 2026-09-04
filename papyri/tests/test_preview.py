"""Tests for the PR-preview upload path (`--preview`, OIDC, `drop-preview`)."""

from __future__ import annotations

import io
import json
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import typer
from typer.testing import CliRunner

from papyri.cli.drop_preview import _preview_endpoint, drop_preview
from papyri.cli.upload import upload
from papyri.github_oidc import (
    OidcUnavailable,
    id_token_available,
    preview_id_from_environment,
    request_id_token,
    resolve_audience,
)

_upload_app = typer.Typer()
_upload_app.command()(upload)
_drop_app = typer.Typer()
_drop_app.command()(drop_preview)

runner = CliRunner()

_ACTIONS_ENV = {
    "ACTIONS_ID_TOKEN_REQUEST_URL": "https://run.actions.local/token?api-version=2.0",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "runtime-secret",
}


def _make_bundle(root: Path, pkg: str = "mypkg", version: str = "1.0") -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / "papyri.json").write_text(json.dumps({"module": pkg, "version": version}))
    (root / "module").mkdir()
    return root


def _ndjson_response(events: list[dict[str, Any]]) -> MagicMock:
    raw = b"".join(json.dumps(e).encode() + b"\n" for e in events)
    resp = MagicMock()
    resp.status = 200
    buf = io.BytesIO(raw)
    resp.readline = buf.readline
    resp.__enter__ = lambda s: (buf.seek(0), s)[1]
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def _json_response(body: dict[str, Any]) -> MagicMock:
    resp = MagicMock()
    resp.status = 200
    resp.read = MagicMock(return_value=json.dumps(body).encode())
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


# ---------------------------------------------------------------------------
# github_oidc
# ---------------------------------------------------------------------------


def test_id_token_requires_actions_environment(monkeypatch: Any) -> None:
    monkeypatch.delenv("ACTIONS_ID_TOKEN_REQUEST_URL", raising=False)
    monkeypatch.delenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", raising=False)
    assert id_token_available() is False
    with pytest.raises(OidcUnavailable, match="id-token: write"):
        request_id_token("papyri")


def test_id_token_request_carries_audience_and_runtime_token(monkeypatch: Any) -> None:
    for k, v in _ACTIONS_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("PAPYRI_OIDC_AUDIENCE", raising=False)

    with patch(
        "urllib.request.urlopen",
        return_value=_json_response({"value": "the.jwt.token"}),
    ) as mock_open:
        assert request_id_token("papyri") == "the.jwt.token"

    req: urllib.request.Request = mock_open.call_args[0][0]
    query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(req.full_url).query))
    # The api-version already on the endpoint must survive the audience append.
    assert query == {"api-version": "2.0", "audience": "papyri"}
    assert req.get_header("Authorization") == "Bearer runtime-secret"


def test_id_token_rejects_a_response_without_a_token(monkeypatch: Any) -> None:
    for k, v in _ACTIONS_ENV.items():
        monkeypatch.setenv(k, v)
    with (
        patch("urllib.request.urlopen", return_value=_json_response({"nope": 1})),
        pytest.raises(OidcUnavailable, match="carried no token"),
    ):
        request_id_token("papyri")


def test_resolve_audience_prefers_override_then_env_then_discovery(
    monkeypatch: Any,
) -> None:
    url = "https://docs.example.com/api/bundle"
    monkeypatch.setenv("PAPYRI_OIDC_AUDIENCE", "from-env")
    with patch("urllib.request.urlopen") as mock_open:
        # An explicit --oidc-audience beats the environment...
        assert resolve_audience(url, "from-flag") == "from-flag"
        # ...and the environment beats asking the viewer.
        assert resolve_audience(url) == "from-env"
    mock_open.assert_not_called()

    monkeypatch.delenv("PAPYRI_OIDC_AUDIENCE", raising=False)
    with patch(
        "urllib.request.urlopen",
        return_value=_json_response({"audience": "https://docs.example.com"}),
    ):
        assert resolve_audience(url) == "https://docs.example.com"


def test_preview_id_from_environment(monkeypatch: Any) -> None:
    monkeypatch.setenv("GITHUB_REPOSITORY", "numpy/numpy")
    monkeypatch.setenv("GITHUB_REF", "refs/pull/42/merge")
    assert preview_id_from_environment() == "numpy/numpy#42"

    monkeypatch.setenv("GITHUB_REF", "refs/heads/main")
    assert preview_id_from_environment() is None


# ---------------------------------------------------------------------------
# papyri upload --preview
# ---------------------------------------------------------------------------


def test_upload_preview_sends_the_oidc_token(tmp_path: Path, monkeypatch: Any) -> None:
    for k, v in _ACTIONS_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("PAPYRI_UPLOAD_TOKEN", raising=False)
    # Pin the audience so no discovery request joins the mocked sequence.
    monkeypatch.setenv("PAPYRI_OIDC_AUDIENCE", "papyri")
    bundle = _make_bundle(tmp_path / "mypkg_1.0")

    responses = [
        _json_response({"value": "id.token.value"}),  # OIDC token request
        _json_response({"ok": True, "exists": False}),  # dedup check
        _ndjson_response(
            [
                {
                    "event": "done",
                    "pkg": "mypkg",
                    "version": "1.0",
                    "preview": "numpy/numpy#42",
                    "url": "https://v.example/preview/numpy/numpy/42/project/mypkg/1.0/",
                }
            ]
        ),
    ]
    with patch("urllib.request.urlopen", side_effect=responses) as mock_open:
        result = runner.invoke(
            _upload_app,
            ["--preview", "--url", "https://v.example/api/bundle", str(bundle)],
        )

    assert result.exit_code == 0, result.output
    put: urllib.request.Request = mock_open.call_args_list[-1][0][0]
    assert put.get_method() == "PUT"
    # The ID token is the bearer, and nothing names the preview on the wire:
    # the server derives it from the token's claims.
    assert put.get_header("Authorization") == "Bearer id.token.value"
    assert "preview=" not in put.full_url
    # The preview URL is echoed on stdout so a CI step can capture it.
    assert (
        "https://v.example/preview/numpy/numpy/42/project/mypkg/1.0/" in result.stdout
    )


def test_upload_preview_fails_clearly_outside_actions(
    tmp_path: Path, monkeypatch: Any
) -> None:
    monkeypatch.delenv("ACTIONS_ID_TOKEN_REQUEST_URL", raising=False)
    monkeypatch.delenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN", raising=False)
    monkeypatch.setenv("PAPYRI_OIDC_AUDIENCE", "papyri")
    bundle = _make_bundle(tmp_path / "mypkg_1.0")

    with patch("urllib.request.urlopen") as mock_open:
        result = runner.invoke(_upload_app, ["--preview", str(bundle)])

    assert result.exit_code == 1
    assert "id-token: write" in result.output
    assert "--preview-id" in result.output
    mock_open.assert_not_called()


def test_upload_preview_id_uses_the_query_string(
    tmp_path: Path, monkeypatch: Any
) -> None:
    monkeypatch.setenv("PAPYRI_UPLOAD_TOKEN", "deployment-token")
    bundle = _make_bundle(tmp_path / "mypkg_1.0")

    responses = [
        _json_response({"ok": True, "exists": False}),
        _ndjson_response([{"event": "done", "pkg": "mypkg", "version": "1.0"}]),
    ]
    with patch("urllib.request.urlopen", side_effect=responses) as mock_open:
        result = runner.invoke(
            _upload_app,
            [
                "--preview-id",
                "numpy/numpy#42",
                "--url",
                "https://v.example/api/bundle",
                str(bundle),
            ],
        )

    assert result.exit_code == 0, result.output
    for call in mock_open.call_args_list:
        req: urllib.request.Request = call[0][0]
        query = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(req.full_url).query))
        assert query["preview"] == "numpy/numpy#42"
        assert req.get_header("Authorization") == "Bearer deployment-token"


# ---------------------------------------------------------------------------
# papyri drop-preview
# ---------------------------------------------------------------------------


def test_preview_endpoint_derivation() -> None:
    assert (
        _preview_endpoint("https://v.example/api/bundle")
        == "https://v.example/api/preview"
    )
    assert (
        _preview_endpoint("https://v.example/api/bundle/")
        == "https://v.example/api/preview"
    )
    # An endpoint that isn't the bundle route still lands on a sibling.
    assert _preview_endpoint("https://v.example/api") == "https://v.example/api/preview"


def test_drop_preview_by_id(monkeypatch: Any) -> None:
    monkeypatch.setenv("PAPYRI_UPLOAD_TOKEN", "deployment-token")
    resp = _json_response({"ok": True, "id": "numpy/numpy#42", "dropped": True})

    with patch("urllib.request.urlopen", return_value=resp) as mock_open:
        result = runner.invoke(
            _drop_app,
            ["--preview-id", "numpy/numpy#42", "--url", "https://v.example/api/bundle"],
        )

    assert result.exit_code == 0, result.output
    req: urllib.request.Request = mock_open.call_args[0][0]
    assert req.get_method() == "DELETE"
    assert req.full_url == "https://v.example/api/preview?id=numpy%2Fnumpy%2342"
    assert "dropped preview numpy/numpy#42" in result.output


def test_drop_preview_uses_oidc_in_actions(monkeypatch: Any) -> None:
    for k, v in _ACTIONS_ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setenv("PAPYRI_OIDC_AUDIENCE", "papyri")
    responses = [
        _json_response({"value": "id.token.value"}),
        _json_response({"ok": True, "id": "numpy/numpy#42", "dropped": True}),
    ]
    with patch("urllib.request.urlopen", side_effect=responses) as mock_open:
        result = runner.invoke(_drop_app, ["--url", "https://v.example/api/bundle"])

    assert result.exit_code == 0, result.output
    req: urllib.request.Request = mock_open.call_args_list[-1][0][0]
    assert req.get_header("Authorization") == "Bearer id.token.value"
    assert req.full_url == "https://v.example/api/preview"


def test_drop_preview_missing_preview_is_not_an_error(monkeypatch: Any) -> None:
    monkeypatch.setenv("PAPYRI_UPLOAD_TOKEN", "deployment-token")
    resp = _json_response({"ok": True, "id": "numpy/numpy#42", "dropped": False})

    with patch("urllib.request.urlopen", return_value=resp):
        result = runner.invoke(
            _drop_app,
            ["--preview-id", "numpy/numpy#42", "--url", "https://v.example/api/bundle"],
        )

    assert result.exit_code == 0, result.output
    assert "nothing to drop" in result.output
