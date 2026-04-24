"""``papyri debug`` — inspect a raw CBOR blob from the data or ingest tree."""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import typer

if TYPE_CHECKING:
    from rich.console import Console


def _resolve_debug_path(raw: str, data_dir: Path) -> Path | None:
    """
    Return the resolved Path for *raw*, trying several strategies:

    1. Use *raw* directly if it points to an existing file.
    2. Append '.cbor' if the result exists.
    3. Treat *raw* as a path relative to *data_dir*, with and without '.cbor'.
    """
    p = Path(raw)
    if p.exists():
        return p
    with_cbor = Path(raw + ".cbor")
    if with_cbor.exists():
        return with_cbor
    in_data = data_dir / raw
    if in_data.exists():
        return in_data
    in_data_cbor = data_dir / (raw + ".cbor")
    if in_data_cbor.exists():
        return in_data_cbor
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
    if identifier.endswith(".cbor"):
        identifier = identifier[:-5]
    _con.print("\n[bold]Bundle context[/bold]")
    _con.print(f"  package : [cyan]{pkg}[/cyan]")
    if ver:
        _con.print(f"  version : [dim]{ver}[/dim]")
    if kind:
        _con.print(f"  kind    : [yellow]{kind}[/yellow]")
    if identifier:
        _con.print(f"  id      : [cyan]{identifier}[/cyan]")


def debug(
    path: Annotated[
        str,
        typer.Argument(
            help=(
                "Path to a .cbor file to inspect. "
                "Can be an absolute/relative path, or a shorthand relative to "
                "~/.papyri/data/ (e.g. 'numpy_2.3.5/module/numpy.linspace'). "
                "The .cbor extension is added automatically when absent."
            )
        ),
    ],
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

    raw = resolved.read_bytes()

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
