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
from .node_base import Node
from .nodes import encoder

_ALLOWED_TOPLEVEL = {"papyri.json", "toc.json", "module", "docs", "examples", "assets"}
_OPTIONAL_DIRS = ("docs", "examples", "assets")


class BundleError(ValueError):
    """A bundle directory is malformed.

    Validation is fail-fast: the first problem encountered is raised
    immediately. ``problems`` is kept as a single-element list so callers
    that previously iterated it still work.
    """

    def __init__(self, problem: str) -> None:
        self.problems = [problem]
        super().__init__(f"bundle is not well-formed: {problem}")


def _check_layout(path: Path) -> None:
    if not path.is_dir():
        raise BundleError(f"{path} is not a directory")

    meta_path = path / "papyri.json"
    if not meta_path.is_file():
        raise BundleError("missing papyri.json")

    module_dir = path / "module"
    if not module_dir.is_dir():
        raise BundleError("missing module/ directory")
    for entry in module_dir.iterdir():
        if not entry.is_file():
            raise BundleError(f"module/{entry.name} is not a regular file")
        if entry.suffix != ".json":
            raise BundleError(f"module/{entry.name} does not have .json suffix")

    for sub in _OPTIONAL_DIRS:
        d = path / sub
        if not d.exists():
            continue
        if not d.is_dir():
            raise BundleError(f"{sub} exists but is not a directory")
        for entry in d.iterdir():
            if not entry.is_file():
                raise BundleError(f"{sub}/{entry.name} is not a regular file")

    for entry in path.iterdir():
        if entry.name not in _ALLOWED_TOPLEVEL:
            raise BundleError(f"unexpected top-level entry: {entry.name}")


def _read_meta(path: Path) -> dict[str, Any]:
    try:
        meta = json.loads((path / "papyri.json").read_text())
    except Exception as exc:
        raise BundleError(f"papyri.json is not valid JSON: {exc}") from exc
    if not isinstance(meta, dict):
        raise BundleError("papyri.json is not a JSON object")
    for key in ("module", "version"):
        if key not in meta:
            raise BundleError(f"papyri.json is missing required key {key!r}")
        if not isinstance(meta[key], str):
            raise BundleError(f"papyri.json[{key!r}] is not a string")
    return meta


def _decode_dir(
    path: Path, expected_type: type[Node], strip_suffix: str = ""
) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if not path.is_dir():
        return out
    for entry in sorted(path.iterdir()):
        if not entry.is_file():
            continue
        try:
            value = expected_type.from_dict(json.loads(entry.read_bytes()))
        except Exception as exc:
            raise BundleError(
                f"{path.name}/{entry.name} failed to decode: {exc}"
            ) from exc
        if not isinstance(value, expected_type):
            raise BundleError(
                f"{path.name}/{entry.name} decoded to "
                f"{type(value).__name__}, expected {expected_type.__name__}"
            )
        key = entry.name
        if strip_suffix and key.endswith(strip_suffix):
            key = key[: -len(strip_suffix)]
        out[key] = value
    return out


def read_bundle_dir(path: Path) -> Bundle:
    """Read a DocBundle directory and construct a typed ``Bundle``.

    Fail-fast: raises ``BundleError`` on the first problem encountered.
    """
    from .doc import GeneratedDoc
    from .nodes import Section, TocTree

    _check_layout(path)
    meta = _read_meta(path)

    api = _decode_dir(path / "module", GeneratedDoc, strip_suffix=".json")
    narrative = _decode_dir(path / "docs", GeneratedDoc)
    examples = _decode_dir(path / "examples", Section)

    assets: dict[str, bytes] = {}
    assets_dir = path / "assets"
    if assets_dir.is_dir():
        for entry in sorted(assets_dir.iterdir()):
            if entry.is_file():
                assets[entry.name] = entry.read_bytes()

    toc: list[TocTree] = []
    toc_path = path / "toc.json"
    if toc_path.is_file():
        try:
            decoded = [TocTree.from_dict(t) for t in json.loads(toc_path.read_bytes())]
        except Exception as exc:
            raise BundleError(f"toc.json failed to decode: {exc}") from exc
        if isinstance(decoded, list) and all(isinstance(t, TocTree) for t in decoded):
            toc = decoded
        elif decoded:
            raise BundleError("toc.json did not decode to list[TocTree]")

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
