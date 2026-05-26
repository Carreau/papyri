"""``papyri debug`` — inspect a raw IR file from the data or ingest tree."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import typer

if TYPE_CHECKING:
    from rich.console import Console

    from papyri.bundle import Bundle
    from papyri.node_base import Node

# Maps an object-path kind prefix to the Bundle field holding that kind.
_BUNDLE_KIND_FIELDS = {
    "module": "api",
    "docs": "narrative",
    "examples": "examples",
}


def _resolve_debug_path(raw: str, data_dir: Path) -> Path | None:
    """
    Return the resolved Path for *raw*, trying several strategies:

    1. Use *raw* directly if it points to an existing file.
    2. Append '.cbor' or '.papyri' if the result exists.
    3. Treat *raw* as a path relative to *data_dir*, with the same suffix
       fallbacks.
    """
    p = Path(raw)
    if p.exists():
        return p
    for suffix in (".json", ".cbor", ".papyri"):
        candidate = Path(raw + suffix)
        if candidate.exists():
            return candidate
    in_data = data_dir / raw
    if in_data.exists():
        return in_data
    for suffix in (".json", ".cbor", ".papyri"):
        in_data_suf = data_dir / (raw + suffix)
        if in_data_suf.exists():
            return in_data_suf
    return None


def _print_data_context(rel: Path, console: Console | None = None) -> None:
    """Print bundle context for a path relative to data_dir."""
    from rich.console import Console as _Console

    _con = console if console is not None else _Console()
    parts = rel.parts
    if not parts:
        return
    bundle = parts[0]
    # bundle dirs are named  <pkg>_<ver>
    if "_" in bundle:
        pkg, _, ver = bundle.partition("_")
    else:
        pkg, ver = bundle, ""
    kind = parts[1] if len(parts) > 1 else ""
    identifier = "/".join(parts[2:])
    for _suf in (".json", ".cbor"):
        if identifier.endswith(_suf):
            identifier = identifier[: -len(_suf)]
            break
    _con.print("\n[bold]Bundle context[/bold]")
    _con.print(f"  package : [cyan]{pkg}[/cyan]")
    if ver:
        _con.print(f"  version : [dim]{ver}[/dim]")
    if kind:
        _con.print(f"  kind    : [yellow]{kind}[/yellow]")
    if identifier:
        _con.print(f"  id      : [cyan]{identifier}[/cyan]")


def _select_bundle_object(bundle: Bundle, object_path: str) -> Node:
    """Return the IR node addressed by *object_path* inside *bundle*.

    The path may carry a kind prefix (``module:``, ``docs:``, ``examples:``)
    selecting which of the bundle's collections to look in; a bare name is
    searched across ``api``, ``narrative`` and ``examples`` in that order.

    Raises ``KeyError`` with a human-readable message (listing the candidate
    keys) when no object matches.
    """
    if ":" in object_path:
        prefix, rest = object_path.split(":", 1)
        if prefix in _BUNDLE_KIND_FIELDS:
            collection: dict[str, Node] = getattr(bundle, _BUNDLE_KIND_FIELDS[prefix])
            if rest in collection:
                return collection[rest]
            available = ", ".join(sorted(collection)) or "(none)"
            raise KeyError(
                f"no {prefix!r} object named {rest!r} in bundle; available: {available}"
            )
        # Not a known kind prefix — the colon belongs to the qualname itself.

    for field in ("api", "narrative", "examples"):
        collection = getattr(bundle, field)
        if object_path in collection:
            return collection[object_path]

    if object_path in bundle.assets:
        raise KeyError(
            f"{object_path!r} is a binary asset, not a JSON-serialisable IR node"
        )

    everything = sorted({*bundle.api, *bundle.narrative, *bundle.examples})
    available = ", ".join(everything) or "(none)"
    raise KeyError(f"no object named {object_path!r} in bundle; available: {available}")


def debug(
    path: Annotated[
        str,
        typer.Argument(
            help=(
                "Path to a bundle IR file to inspect (.json for data-tree files, "
                ".cbor for ingest-tree files, .papyri for packed artifacts). "
                "Can be an absolute/relative path, or a shorthand relative to "
                "~/.papyri/data/ (e.g. 'numpy_2.3.5/module/numpy.linspace'). "
                "The extension is added automatically when absent."
            )
        ),
    ],
    object_path: Annotated[
        str | None,
        typer.Argument(
            help=(
                "Optional: name of a single object inside a .papyri artifact to "
                "print as JSON on stdout (for piping into jq and friends). "
                "May carry a kind prefix: 'module:numpy.linspace', 'docs:intro', "
                "'examples:foo'. A bare name searches api, narrative, then examples. "
                "All human-readable context is suppressed so stdout is pure JSON."
            ),
        ),
    ] = None,
) -> None:
    """
    Print the contents of a CBOR file in human-readable form.

    Accepts:
    - An absolute or relative path to any .cbor file.
    - A shorthand path relative to ~/.papyri/data/ — the .cbor extension is
      appended automatically if the file is not found without it.

    When the file lives inside the ingest tree (~/.papyri/ingest/) the command
    also prints backrefs from the graph store.

    When the file lives inside the data tree (~/.papyri/data/) the command
    prints the bundle context (package, version, kind) derived from the path.

    Tries to decode using the papyri IR tag registry first; falls back to
    plain cbor2 if the file does not contain tagged IR objects.

    A ``.papyri`` artifact (output of ``papyri pack``) is also accepted:
    the artifact is gunzipped + decoded to a ``Bundle`` Node and pretty-
    printed in place of the file-tree-walk path.

    Pass a second ``object_path`` argument to print a single object from a
    ``.papyri`` artifact as JSON on stdout, with no other output, so it can be
    piped into tools like ``jq``::

        papyri debug numpy.papyri module:numpy.linspace | jq .signature
    """
    import cbor2
    from rich.console import Console
    from rich.pretty import pprint as rich_pprint

    from papyri.config import data_dir, ingest_dir
    from papyri.graphstore import GraphStore, Key
    from papyri.nodes import encoder

    console = Console()

    resolved = _resolve_debug_path(path, data_dir)
    if resolved is None:
        typer.echo(f"File not found: {path!r}", err=True)
        raise typer.Exit(1)

    if resolved.suffix == ".papyri":
        from papyri.pack import load_artifact

        try:
            bundle = load_artifact(resolved.read_bytes())
        except Exception as e:
            typer.echo(f"Failed to decode artifact {resolved}: {e}", err=True)
            raise typer.Exit(1) from None

        if object_path is not None:
            try:
                obj = _select_bundle_object(bundle, object_path)
            except KeyError as e:
                typer.echo(str(e.args[0]), err=True)
                raise typer.Exit(1) from None
            # Pure JSON on stdout — nothing else — so the output pipes cleanly.
            typer.echo(obj.to_json().decode())
            return

        console.print(f"[bold].papyri artifact[/bold] {resolved}")
        console.print(
            f"  module          : [cyan]{bundle.module}[/cyan]"
            f" [dim]{bundle.version}[/dim]"
        )
        console.print(f"  pack format ver : [dim]{bundle.pack_format_version}[/dim]")
        console.print(f"  ir schema ver   : [dim]{bundle.ir_schema_version}[/dim]")
        console.print(f"  api entries     : {len(bundle.api)}")
        console.print(f"  narrative pages : {len(bundle.narrative)}")
        console.print(f"  examples        : {len(bundle.examples)}")
        console.print(f"  assets          : {len(bundle.assets)}")
        console.print(f"  toc roots       : {len(bundle.toc)}")
        return

    if object_path is not None:
        typer.echo(
            "object-path selection is only supported for .papyri artifacts; "
            f"{resolved.name} is already a single object — omit the object path.",
            err=True,
        )
        raise typer.Exit(1)

    import json as _json

    raw = resolved.read_bytes()

    if resolved.suffix == ".json":
        try:
            obj = _json.loads(raw)
            rich_pprint(obj)
        except Exception as e:
            typer.echo(f"Failed to decode {resolved}: {e}", err=True)
            raise typer.Exit(1) from None
    else:
        try:
            obj = encoder.decode(raw)
            rich_pprint(obj)
        except Exception:
            try:
                obj = cbor2.loads(raw)
                rich_pprint(obj)
            except Exception as e:
                typer.echo(f"Failed to decode {resolved}: {e}", err=True)
                raise typer.Exit(1) from None

    # Show bundle context when the file is inside the data tree.
    try:
        rel = resolved.resolve().relative_to(data_dir.resolve())
    except ValueError:
        pass
    else:
        _print_data_context(rel, console)

    # Show backrefs when the file is inside the ingest tree.
    try:
        rel = resolved.resolve().relative_to(ingest_dir.resolve())
    except ValueError:
        return

    parts = rel.parts
    if len(parts) != 4:
        return

    module, version, kind, identifier = parts
    if identifier.endswith(".cbor"):
        identifier = identifier[:-5]

    key = Key(module, version, kind, identifier)
    store = GraphStore(ingest_dir, {})
    backrefs = store.get_backref(key)
    if backrefs:
        console.print("\n[bold]Backrefs[/bold]")
        for b in sorted(backrefs):
            console.print(
                f"  [dim]{b.module} {b.version}[/dim]"
                f" [yellow]{b.kind}[/yellow] [cyan]{b.path}[/cyan]"
            )
