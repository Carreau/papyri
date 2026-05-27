"""Tests for papyri.user_config — named upload target config."""

from __future__ import annotations

import textwrap
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from papyri.user_config import (
    UploadTarget,
    UserConfig,
    get_target,
    list_targets,
    load_user_config,
)

# ---------------------------------------------------------------------------
# load_user_config
# ---------------------------------------------------------------------------


def test_load_absent_file(tmp_path: Path) -> None:
    cfg = load_user_config(tmp_path / "config.toml")
    assert cfg.default_target is None
    assert cfg.targets == {}


def test_load_minimal_target(tmp_path: Path) -> None:
    p = tmp_path / "config.toml"
    p.write_text(
        textwrap.dedent("""\
        [upload.targets.localhost]
        url = "http://localhost:4321/api/bundle"
        """)
    )
    cfg = load_user_config(p)
    assert "localhost" in cfg.targets
    assert cfg.targets["localhost"].url == "http://localhost:4321/api/bundle"
    assert cfg.targets["localhost"].token is None
    assert cfg.targets["localhost"].keychain is False


def test_load_target_with_token(tmp_path: Path) -> None:
    p = tmp_path / "config.toml"
    p.write_text(
        textwrap.dedent("""\
        [upload.targets.staging]
        url = "https://staging.example.com/api/bundle"
        token = "mytoken"
        """)
    )
    cfg = load_user_config(p)
    assert cfg.targets["staging"].token == "mytoken"
    assert cfg.targets["staging"].keychain is False


def test_load_target_with_keychain(tmp_path: Path) -> None:
    p = tmp_path / "config.toml"
    p.write_text(
        textwrap.dedent("""\
        [upload.targets.production]
        url = "https://docs.example.com/api/bundle"
        keychain = true
        """)
    )
    cfg = load_user_config(p)
    assert cfg.targets["production"].keychain is True
    assert cfg.targets["production"].token is None


def test_load_default_target(tmp_path: Path) -> None:
    p = tmp_path / "config.toml"
    p.write_text(
        textwrap.dedent("""\
        [upload]
        default_target = "localhost"

        [upload.targets.localhost]
        url = "http://localhost:4321/api/bundle"
        """)
    )
    cfg = load_user_config(p)
    assert cfg.default_target == "localhost"


def test_load_multiple_targets(tmp_path: Path) -> None:
    p = tmp_path / "config.toml"
    p.write_text(
        textwrap.dedent("""\
        [upload.targets.a]
        url = "http://a.example.com/"

        [upload.targets.b]
        url = "http://b.example.com/"
        token = "tokb"
        """)
    )
    cfg = load_user_config(p)
    assert set(cfg.targets) == {"a", "b"}
    assert cfg.targets["b"].token == "tokb"


# ---------------------------------------------------------------------------
# Validation errors
# ---------------------------------------------------------------------------


def test_missing_url_raises(tmp_path: Path) -> None:
    p = tmp_path / "config.toml"
    p.write_text("[upload.targets.bad]\ntoken = 'x'\n")
    with pytest.raises(ValueError, match="missing the required 'url'"):
        load_user_config(p)


def test_unknown_key_raises(tmp_path: Path) -> None:
    p = tmp_path / "config.toml"
    p.write_text("[upload.targets.t]\nurl = 'http://x/'\nfoo = 'bar'\n")
    with pytest.raises(ValueError, match="unknown keys"):
        load_user_config(p)


def test_token_and_keychain_raises(tmp_path: Path) -> None:
    p = tmp_path / "config.toml"
    p.write_text(
        "[upload.targets.t]\nurl = 'http://x/'\ntoken = 'abc'\nkeychain = true\n"
    )
    with pytest.raises(ValueError, match="cannot set both"):
        load_user_config(p)


def test_default_target_not_in_targets_raises(tmp_path: Path) -> None:
    p = tmp_path / "config.toml"
    p.write_text(
        textwrap.dedent("""\
        [upload]
        default_target = "missing"

        [upload.targets.localhost]
        url = "http://localhost/"
        """)
    )
    with pytest.raises(ValueError, match=r"default_target.*missing"):
        load_user_config(p)


def test_invalid_toml_raises(tmp_path: Path) -> None:
    p = tmp_path / "config.toml"
    p.write_text("[[[ not valid toml")
    with pytest.raises(ValueError, match="Cannot parse"):
        load_user_config(p)


# ---------------------------------------------------------------------------
# UploadTarget.resolve_token
# ---------------------------------------------------------------------------


def test_resolve_token_plain() -> None:
    t = UploadTarget(url="http://x/", token="abc")
    assert t.resolve_token("myname") == "abc"


def test_resolve_token_none() -> None:
    t = UploadTarget(url="http://x/")
    assert t.resolve_token("myname") is None


def test_resolve_token_keychain_found() -> None:
    t = UploadTarget(url="http://x/", keychain=True)
    fake_keyring = MagicMock()
    fake_keyring.get_password.return_value = "secret"
    with patch.dict("sys.modules", {"keyring": fake_keyring}):
        assert t.resolve_token("prod") == "secret"
    fake_keyring.get_password.assert_called_once_with("papyri", "prod")


def test_resolve_token_keychain_missing() -> None:
    t = UploadTarget(url="http://x/", keychain=True)
    fake_keyring = MagicMock()
    fake_keyring.get_password.return_value = None
    with (
        patch.dict("sys.modules", {"keyring": fake_keyring}),
        pytest.raises(RuntimeError, match="No token found in keychain"),
    ):
        t.resolve_token("prod")


def test_resolve_token_keychain_no_keyring() -> None:
    t = UploadTarget(url="http://x/", keychain=True)
    with (
        patch.dict("sys.modules", {"keyring": None}),
        pytest.raises((RuntimeError, ImportError)),
    ):
        t.resolve_token("prod")


# ---------------------------------------------------------------------------
# get_target / list_targets
# ---------------------------------------------------------------------------


def test_get_target_found() -> None:
    cfg = UserConfig(
        targets={"a": UploadTarget(url="http://a/"), "b": UploadTarget(url="http://b/")}
    )
    assert get_target(cfg, "a").url == "http://a/"


def test_get_target_not_found() -> None:
    cfg = UserConfig(targets={"a": UploadTarget(url="http://a/")})
    with pytest.raises(KeyError, match="not found"):
        get_target(cfg, "missing")


def test_list_targets_sorted() -> None:
    cfg = UserConfig(
        targets={
            "z": UploadTarget(url="http://z/"),
            "a": UploadTarget(url="http://a/"),
            "m": UploadTarget(url="http://m/"),
        }
    )
    assert list_targets(cfg) == ["a", "m", "z"]
