"""Build a deterministic ``.papyri`` artifact from a DocBundle directory.

The artifact is a single ``Bundle`` Node, encoded with canonical CBOR (RFC
8949 §4.2 deterministic encoding) and gzipped with a zero-mtime header.
Running ``make_artifact_from_dir`` twice on the same directory must produce
byte-identical output; that property is what makes the artifact suitable as
a publication contract (content addressing, signing, mirroring).
"""

from __future__ import annotations

import gzip
import io
import json
from pathlib import Path
from typing import Any

from .bundle import IR_SCHEMA_VERSION, PACK_FORMAT_VERSION, Bundle
from .nodes import encoder

_ALLOWED_TOPLEVEL = {"papyri.json", "toc.cbor", "module", "docs", "examples", "assets"}
_OPTIONAL_DIRS = ("docs", "examples", "assets")


class BundleError(ValueError):
    """A bundle directory is malformed.

    Carries a ``problems`` list so the user sees every issue at once instead
    of fixing them one at a time.
    """

    def __init__(self, problems: list[str]) -> None:
        self.problems = list(problems)
        super().__init__(
            "bundle is not well-formed:\n  - " + "\n  - ".join(self.problems)
        )


def _check_layout(path: Path) -> list[str]:
    problems: list[str] = []

    if not path.is_dir():
        return [f"{path} is not a directory"]

    meta_path = path / "papyri.json"
    if not meta_path.is_file():
        raise ValueError("Missing papyri.json")
        problems.append("missing papyri.json")

    module_dir = path / "module"
    if not module_dir.is_dir():
        raise ValueError("Missing module dir")

        problems.append("missing module/ directory")
    else:
        for entry in module_dir.iterdir():
            if not entry.is_file():
                problems.append(f"module/{entry.name} is not a regular file")
            elif entry.suffix != ".cbor":
                problems.append(f"module/{entry.name} does not have .cbor suffix")

    for sub in _OPTIONAL_DIRS:
        d = path / sub
        if not d.exists():
            continue
        if not d.is_dir():
            problems.append(f"{sub} exists but is not a directory")
            continue
        problems.extend(
            f"{sub}/{entry.name} is not a regular file"
            for entry in d.iterdir()
            if not entry.is_file()
        )

    problems.extend(
        f"unexpected top-level entry: {entry.name}"
        for entry in path.iterdir()
        if entry.name not in _ALLOWED_TOPLEVEL
    )

    return problems


def _read_meta(path: Path, problems: list[str]) -> dict[str, Any]:
    try:
        meta = json.loads((path / "papyri.json").read_text())
    except Exception as exc:
        problems.append(f"papyri.json is not valid JSON: {exc}")
        return {}
    if not isinstance(meta, dict):
        problems.append("papyri.json is not a JSON object")
        return {}
    for key in ("module", "version"):
        if key not in meta:
            problems.append(f"papyri.json is missing required key {key!r}")
        elif not isinstance(meta[key], str):
            problems.append(f"papyri.json[{key!r}] is not a string")
    return meta


def _decode_dir(
    path: Path, expected_type: type, problems: list[str], strip_suffix: str = ""
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if not path.is_dir():
        return out
    for entry in sorted(path.iterdir()):
        if not entry.is_file():
            continue
        try:
            value = encoder.decode(entry.read_bytes())
        except Exception as exc:
            problems.append(f"{path.name}/{entry.name} failed to decode: {exc}")
            continue
        if not isinstance(value, expected_type):
            problems.append(
                f"{path.name}/{entry.name} decoded to "
                f"{type(value).__name__}, expected {expected_type.__name__}"
            )
            continue
        key = entry.name
        if strip_suffix and key.endswith(strip_suffix):
            key = key[: -len(strip_suffix)]
        out[key] = value
    return out


def read_bundle_dir(path: Path) -> Bundle:
    """Read a DocBundle directory and construct a typed ``Bundle``.

    Raises ``BundleError`` with every problem encountered, not just the
    first one.
    """
    from .doc import GeneratedDoc
    from .nodes import Section, TocTree

    problems = _check_layout(path)
    meta = (
        _read_meta(path, problems)
        if not any(p.startswith("missing papyri.json") for p in problems)
        else {}
    )
    assert not problems

    api = _decode_dir(path / "module", GeneratedDoc, problems, strip_suffix=".cbor")
    assert not problems
    narrative = _decode_dir(path / "docs", GeneratedDoc, problems)
    assert not problems
    examples = _decode_dir(path / "examples", Section, problems)
    assert not problems

    assets: dict[str, bytes] = {}
    assets_dir = path / "assets"
    if assets_dir.is_dir():
        for entry in sorted(assets_dir.iterdir()):
            if entry.is_file():
                assets[entry.name] = entry.read_bytes()

    toc: list[TocTree] = []
    toc_path = path / "toc.cbor"
    if toc_path.is_file():
        try:
            decoded = encoder.decode(toc_path.read_bytes())
        except Exception as exc:
            raise
            problems.append(f"toc.cbor failed to decode: {exc}")
            decoded = []
        if isinstance(decoded, list) and all(isinstance(t, TocTree) for t in decoded):
            toc = decoded
        elif decoded:
            raise
            problems.append("toc.cbor did not decode to list[TocTree]")

    if problems:
        raise BundleError(problems)

    known = {"module", "version", "summary", "github_slug", "tag", "logo", "aliases"}
    extra = {
        k: str(v)
        for k, v in meta.items()
        if k not in known and isinstance(v, (str, int, float, bool))
    }

    bundle = Bundle(
        pack_format_version=PACK_FORMAT_VERSION,
        ir_schema_version=IR_SCHEMA_VERSION,
        module=meta["module"],
        version=meta["version"],
        summary=meta.get("summary") or "",
        github_slug=meta.get("github_slug") or "",
        tag=meta.get("tag") or "",
        logo=meta.get("logo") or "",
        aliases={str(k): str(v) for k, v in (meta.get("aliases") or {}).items()},
        extra=extra,
        api=api,
        narrative=narrative,
        examples=examples,
        assets=assets,
        toc=toc,
    )
    bundle.validate()
    return bundle


def make_artifact(bundle: Bundle) -> bytes:
    """Encode a ``Bundle`` to canonical-CBOR + gzip bytes (deterministic)."""
    cbor_bytes = encoder.encode(bundle)
    buf = io.BytesIO()
    # mtime=0 + no filename → reproducible gzip header.
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0, compresslevel=9) as gz:
        gz.write(cbor_bytes)
    return buf.getvalue()


def make_artifact_from_dir(path: Path) -> tuple[bytes, Bundle]:
    """Validate and pack a DocBundle directory. Returns (artifact_bytes, bundle)."""
    bundle = read_bundle_dir(path)
    return make_artifact(bundle), bundle


def load_artifact(data: bytes) -> Bundle:
    """Inverse of ``make_artifact``: gunzip + decode to a ``Bundle``."""
    cbor_bytes = gzip.decompress(data)
    obj = encoder.decode(cbor_bytes)
    if not isinstance(obj, Bundle):
        raise ValueError(
            f"artifact did not decode to a Bundle (got {type(obj).__name__})"
        )
    return obj
