"""User-level config (~/.papyri/config.toml) for papyri CLI.

Defines named upload targets so ``papyri upload --to <name>`` can resolve a
URL and token without repeating them on every invocation.

Config path: ``~/.papyri/config.toml``

Example::

    [upload]
    default_target = "localhost"

    [upload.targets.localhost]
    url = "http://localhost:4321/api/bundle"

    [upload.targets.staging]
    url = "https://staging.example.com/api/bundle"
    token = "plaintext-token"

    [upload.targets.production]
    url = "https://docs.example.com/api/bundle"
    keychain = true  # reads from system keychain; see UploadTarget.resolve_token
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Canonical path — matches papyri/config.py's base_dir.
USER_CONFIG_PATH = Path("~/.papyri/config.toml")


@dataclass
class UploadTarget:
    """A named upload destination."""

    url: str
    token: str | None = None
    keychain: bool = False

    def resolve_token(self, name: str) -> str | None:
        """Return the bearer token for this target.

        Resolution order:
        1. ``token`` field (plain-text in config).
        2. System keychain (when ``keychain = true``), looked up via
           ``keyring.get_password("papyri", name)``.
        3. ``None`` — no token configured.

        Raises ``RuntimeError`` when ``keychain = true`` but ``keyring`` is not
        installed or has no entry for this target.
        """
        if self.token is not None:
            return self.token
        if self.keychain:
            try:
                import keyring
            except ImportError as exc:
                raise RuntimeError(
                    f"Target '{name}' uses keychain storage but the 'keyring' "
                    "package is not installed.  Install it with:  pip install keyring"
                ) from exc
            stored: str | None = keyring.get_password("papyri", name)
            if stored is None:
                raise RuntimeError(
                    f"No token found in keychain for target '{name}'.  "
                    f"Store one with:  python -m keyring set papyri {name}"
                )
            return stored
        return None


@dataclass
class UserConfig:
    """Parsed contents of ``~/.papyri/config.toml``."""

    default_target: str | None = None
    targets: dict[str, UploadTarget] = field(default_factory=dict)


def load_user_config(path: Path | None = None) -> UserConfig:
    """Load the user config file, returning an empty config if the file is absent.

    ``path`` defaults to ``~/.papyri/config.toml`` and is overridable for
    testing.
    """
    resolved = (path or USER_CONFIG_PATH).expanduser()
    if not resolved.exists():
        return UserConfig()

    try:
        raw: dict[str, Any] = tomllib.loads(resolved.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        raise ValueError(f"Cannot parse {resolved}: {exc}") from exc

    upload_section: dict[str, Any] = raw.get("upload", {})
    default_target: str | None = upload_section.get("default_target")
    targets_raw: dict[str, Any] = upload_section.get("targets", {})

    targets: dict[str, UploadTarget] = {}
    for tname, tdata in targets_raw.items():
        if not isinstance(tdata, dict):
            raise ValueError(
                f"[upload.targets.{tname}] must be a TOML table, got {type(tdata).__name__}"
            )
        if "url" not in tdata:
            raise ValueError(
                f"[upload.targets.{tname}] is missing the required 'url' key"
            )
        unknown = set(tdata) - {"url", "token", "keychain"}
        if unknown:
            raise ValueError(
                f"[upload.targets.{tname}] has unknown keys: {', '.join(sorted(unknown))}"
            )
        if tdata.get("token") is not None and tdata.get("keychain"):
            raise ValueError(
                f"[upload.targets.{tname}] cannot set both 'token' and 'keychain = true'"
            )
        targets[tname] = UploadTarget(
            url=tdata["url"],
            token=tdata.get("token"),
            keychain=bool(tdata.get("keychain", False)),
        )

    if default_target is not None and default_target not in targets:
        raise ValueError(
            f"[upload] default_target = '{default_target}' does not match "
            f"any defined target.  Available: {', '.join(targets) or '(none)'}"
        )

    return UserConfig(default_target=default_target, targets=targets)


def list_targets(config: UserConfig) -> list[str]:
    """Return target names in sorted order."""
    return sorted(config.targets)


def get_target(config: UserConfig, name: str) -> UploadTarget:
    """Look up a named target, raising ``KeyError`` with a helpful message if absent."""
    if name not in config.targets:
        available = ", ".join(sorted(config.targets)) or "(none)"
        raise KeyError(
            f"Upload target '{name}' not found in {USER_CONFIG_PATH}.  "
            f"Available targets: {available}"
        )
    return config.targets[name]
