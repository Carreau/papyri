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
import re
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from .bundle import IR_SCHEMA_VERSION, PACK_FORMAT_VERSION, Bundle, BundleManifest
from .node_base import Node
from .nodes import Image, Link, encoder
from .serde import get_type_hints

_ALLOWED_TOPLEVEL = {"papyri.json", "toc.json", "module", "docs", "examples", "assets"}
_OPTIONAL_DIRS = ("docs", "examples", "assets")


def _safe_child(base: Path, name: str) -> Path:
    """Resolve ``base / name`` and refuse any result that escapes ``base``.

    ``name`` comes from decoded (untrusted) artifact keys; a value like
    ``../../etc/x`` or an absolute path would otherwise let a crafted
    ``.papyri`` file write outside the target directory on ``papyri unpack``.
    """
    base_resolved = base.resolve()
    child = (base / name).resolve()
    if not child.is_relative_to(base_resolved):
        raise BundleError(f"unsafe path in bundle: {name!r}")
    return child


_SAFE_URL_SCHEMES = frozenset({"http", "https", "mailto"})
_URL_SCHEME_RE = re.compile(r"^([a-z][a-z0-9+.-]*):", re.IGNORECASE)


def _is_safe_url(url: str) -> bool:
    """Mirror of ingest's ``isSafeUrl``: only http/https/mailto + relative URLs.

    Disallows ``javascript:``/``data:``/… which would become an XSS vector
    once a Link/Image reaches a renderer. Control chars and whitespace are
    stripped first so ``java\\tscript:`` cannot smuggle a scheme past the test.
    """
    stripped = "".join(c for c in url if ord(c) > 0x20 and not (0x7F <= ord(c) <= 0x9F))
    m = _URL_SCHEME_RE.match(stripped)
    if m is None:
        return True
    return m.group(1).lower() in _SAFE_URL_SCHEMES


def _iter_nodes(obj: Any) -> Iterator[Node]:
    """Yield every Node reachable from *obj*, depth-first."""
    if isinstance(obj, Node):
        yield obj
        for attr in get_type_hints(type(obj)):  # type: ignore[arg-type]
            yield from _iter_nodes(getattr(obj, attr))
    elif isinstance(obj, (list, tuple)):
        for item in obj:
            yield from _iter_nodes(item)
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _iter_nodes(v)


def _assert_safe_urls(bundle: Bundle) -> None:
    """Refuse to pack a bundle whose Link/Image nodes use a disallowed scheme.

    Defense-in-depth alongside the ingest-time check and the renderer's own
    sanitisation — pack runs in the maintainer's build, so neither downstream
    layer can assume the bundle was vetted here.
    """
    unsafe = [
        n.url
        for n in _iter_nodes([bundle.api, bundle.narrative, bundle.examples])
        if isinstance(n, (Link, Image)) and not _is_safe_url(n.url)
    ]
    if unsafe:
        sample = ", ".join(unsafe[:3])
        raise BundleError(
            f"{len(unsafe)} link/image URL(s) use a disallowed scheme "
            f"(only http, https, mailto and relative URLs are allowed): {sample}"
        )


def _count_files(d: Path) -> int:
    return sum(1 for e in d.iterdir() if e.is_file()) if d.is_dir() else 0


def _plural(n: int) -> str:
    return "s" if n != 1 else ""


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


def _read_meta(path: Path) -> BundleManifest:
    try:
        raw: Any = json.loads((path / "papyri.json").read_text())
    except Exception as exc:
        raise BundleError(f"papyri.json is not valid JSON: {exc}") from exc
    if not isinstance(raw, dict):
        raise BundleError("papyri.json is not a JSON object")
    for key in ("module", "version"):
        if key not in raw:
            raise BundleError(f"papyri.json is missing required key {key!r}")
        if not isinstance(raw[key], str):
            raise BundleError(f"papyri.json[{key!r}] is not a string")

    known = {"module", "version", "summary", "github_slug", "tag", "logo", "aliases"}
    extra: dict[str, str] = {
        k: str(v)
        for k, v in raw.items()
        if k not in known and isinstance(v, (str, int, float, bool))
    }
    return BundleManifest(
        module=raw["module"],
        version=raw["version"],
        summary=raw.get("summary") or "",
        github_slug=raw.get("github_slug") or "",
        tag=raw.get("tag") or "",
        logo=raw.get("logo") or "",
        aliases={str(k): str(v) for k, v in (raw.get("aliases") or {}).items()},
        extra=extra,
    )


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


def read_bundle_dir(path: Path, log: Callable[[str], None] | None = None) -> Bundle:
    """Read a DocBundle directory and construct a typed ``Bundle``.

    Fail-fast: raises ``BundleError`` on the first problem encountered.
    Pass a ``log`` callable to receive fine-grained progress messages
    (one string per step, no trailing newline needed).
    """
    from .doc import GeneratedDoc
    from .nodes import Section, TocTree

    if log:
        log("  checking layout …")
    _check_layout(path)
    manifest = _read_meta(path)
    if log:
        log(f"  metadata: module={manifest.module!r}, version={manifest.version!r}")

    module_dir = path / "module"
    if log:
        n = _count_files(module_dir)
        log(f"  decoding module/   ({n} item{_plural(n)}) …")
    api = _decode_dir(module_dir, GeneratedDoc, strip_suffix=".json")

    docs_dir = path / "docs"
    if log:
        n = _count_files(docs_dir)
        log(
            f"  decoding docs/     ({n} item{_plural(n)}) …"
            if n
            else "  docs/     (none)"
        )
    narrative = _decode_dir(docs_dir, GeneratedDoc)

    examples_dir = path / "examples"
    if log:
        n = _count_files(examples_dir)
        log(
            f"  decoding examples/ ({n} item{_plural(n)}) …"
            if n
            else "  examples/ (none)"
        )
    examples = _decode_dir(examples_dir, Section)

    assets: dict[str, bytes] = {}
    assets_dir = path / "assets"
    if assets_dir.is_dir():
        if log:
            n = _count_files(assets_dir)
            log(f"  reading  assets/   ({n} item{_plural(n)}) …")
        for entry in sorted(assets_dir.iterdir()):
            if entry.is_file():
                assets[entry.name] = entry.read_bytes()
    elif log:
        log("  assets/   (none)")

    toc: tuple[TocTree, ...] = ()
    toc_path = path / "toc.json"
    if log:
        log("  decoding toc.json …" if toc_path.is_file() else "  toc.json  (absent)")
    if toc_path.is_file():
        try:
            toc = tuple(TocTree.from_dict(t) for t in json.loads(toc_path.read_bytes()))
        except Exception as exc:
            raise BundleError(f"toc.json failed to decode: {exc}") from exc

    bundle = Bundle(
        pack_format_version=PACK_FORMAT_VERSION,
        ir_schema_version=IR_SCHEMA_VERSION,
        module=manifest.module,
        version=manifest.version,
        summary=manifest.summary,
        github_slug=manifest.github_slug,
        tag=manifest.tag,
        logo=manifest.logo,
        aliases=manifest.aliases,
        extra=manifest.extra,
        api=api,
        narrative=narrative,
        examples=examples,
        assets=assets,
        toc=toc,
    )
    bundle.validate()
    return bundle


def make_artifact(bundle: Bundle, log: Callable[[str], None] | None = None) -> bytes:
    """Encode a ``Bundle`` to canonical-CBOR + gzip bytes (deterministic)."""
    _assert_safe_urls(bundle)
    if log:
        log("  encoding CBOR …")
    cbor_bytes = encoder.encode(bundle)
    if log:
        log(f"  compressing (gzip, {len(cbor_bytes) / (1024 * 1024):.1f} MiB raw) …")
    buf = io.BytesIO()
    # mtime=0 + no filename → reproducible gzip header.
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0, compresslevel=9) as gz:
        gz.write(cbor_bytes)
    data = buf.getvalue()
    if log:
        log(f"  compressed → {len(data) / (1024 * 1024):.1f} MiB")
    return data


def make_artifact_from_dir(
    path: Path, log: Callable[[str], None] | None = None
) -> tuple[bytes, Bundle]:
    """Validate and pack a DocBundle directory. Returns (artifact_bytes, bundle)."""
    bundle = read_bundle_dir(path, log=log)
    return make_artifact(bundle, log=log), bundle


def load_artifact(data: bytes) -> Bundle:
    """Inverse of ``make_artifact``: gunzip + decode to a ``Bundle``."""
    cbor_bytes = gzip.decompress(data)
    obj = encoder.decode(cbor_bytes)
    if not isinstance(obj, Bundle):
        raise ValueError(
            f"artifact did not decode to a Bundle (got {type(obj).__name__})"
        )
    return obj


def _manifest_dict(bundle: Bundle) -> dict[str, Any]:
    """Reconstruct the ``papyri.json`` manifest from a ``Bundle``.

    Inverse of ``_read_meta``: required keys are always present, optional
    fields are only emitted when non-empty, and ``extra`` scalar keys are
    merged back at the top level so the staging directory round-trips.
    """
    meta: dict[str, Any] = {"module": bundle.module, "version": bundle.version}
    if bundle.summary:
        meta["summary"] = bundle.summary
    if bundle.github_slug:
        meta["github_slug"] = bundle.github_slug
    if bundle.tag:
        meta["tag"] = bundle.tag
    if bundle.logo:
        meta["logo"] = bundle.logo
    if bundle.aliases:
        meta["aliases"] = dict(bundle.aliases)
    meta.update(bundle.extra)
    return meta


def explode_bundle_to_dir(
    bundle: Bundle, path: Path, log: Callable[[str], None] | None = None
) -> None:
    """Write a ``Bundle`` out as a JSON DocBundle staging directory.

    Inverse of ``read_bundle_dir``: produces the same human-readable layout
    that ``papyri gen`` writes (``papyri.json``, ``toc.json``, ``module/``,
    ``docs/``, ``examples/``, ``assets/``). ``path`` must not already exist.
    """
    if path.exists():
        raise BundleError(f"{path} already exists")
    path.mkdir(parents=True)

    if log:
        log(f"  writing module/   ({len(bundle.api)} item{_plural(len(bundle.api))}) …")
    module_dir = path / "module"
    module_dir.mkdir()
    for qa, doc in bundle.api.items():
        _safe_child(module_dir, f"{qa}.json").write_bytes(doc.to_json())

    if bundle.narrative:
        if log:
            n = len(bundle.narrative)
            log(f"  writing docs/     ({n} item{_plural(n)}) …")
        docs_dir = path / "docs"
        docs_dir.mkdir()
        for name, doc in bundle.narrative.items():
            _safe_child(docs_dir, name).write_bytes(doc.to_json())

    if bundle.examples:
        if log:
            n = len(bundle.examples)
            log(f"  writing examples/ ({n} item{_plural(n)}) …")
        examples_dir = path / "examples"
        examples_dir.mkdir()
        for name, section in bundle.examples.items():
            _safe_child(examples_dir, name).write_bytes(section.to_json())

    if bundle.assets:
        if log:
            n = len(bundle.assets)
            log(f"  writing assets/   ({n} item{_plural(n)}) …")
        assets_dir = path / "assets"
        assets_dir.mkdir()
        for name, data in bundle.assets.items():
            _safe_child(assets_dir, name).write_bytes(data)

    if bundle.toc:
        if log:
            log("  writing toc.json …")
        (path / "toc.json").write_bytes(
            json.dumps(
                [t.to_dict() for t in bundle.toc], indent=2, sort_keys=True
            ).encode()
        )

    if log:
        log("  writing papyri.json …")
    (path / "papyri.json").write_text(
        json.dumps(_manifest_dict(bundle), indent=2, sort_keys=True)
    )


def explode_artifact_to_dir(
    artifact: Path, dest_parent: Path, log: Callable[[str], None] | None = None
) -> Path:
    """Load a ``.papyri`` artifact and explode it into a JSON DocBundle dir.

    The bundle directory is named ``<module>_<version>`` (matching the
    ``papyri gen`` convention) and created under ``dest_parent``. Returns the
    path to the created directory. Fails if that directory already exists.
    """
    if log:
        log(f"  loading {artifact.name} …")
    bundle = load_artifact(artifact.read_bytes())
    out_dir = _safe_child(dest_parent, f"{bundle.module}_{bundle.version}")
    explode_bundle_to_dir(bundle, out_dir, log=log)
    return out_dir
