"""
Various directive handlers.
"""

import logging
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .nodes import (
    Admonition,
    AdmonitionTitle,
    BulletList,
    Figure,
    Image,
    ListItem,
    Math,
    Paragraph,
    RefInfo,
    Section,
    Table,
    TableCell,
    TableRow,
    Text,
)
from .ts import parse

log = logging.getLogger("papyri")


def drop(argument: str, options: dict[str, str], content: str) -> list[Any]:
    """Directive handler that silently discards the directive and returns nothing.

    Register this for any directive whose content should not appear in the IR::

        [global.directives]
        testsetup = 'papyri.directives:drop'
        plot      = 'papyri.directives:drop'

    """
    return []


def warn(argument: str, options: dict[str, str], content: str) -> list[Any]:
    """Directive handler that silently discards the directive and returns nothing.

    Register this for any directive whose content should not appear in the IR::

        [global.directives]
        testsetup = 'papyri.directives:warn'

    """
    # TODO: in directive handler pass the name of the current directive ?
    log.warning(".. directive ignored (name missing) ")
    return []


def block_math_handler(
    argument: str, options: dict[str, str], content: str
) -> list[Any]:
    """
    Handler for the block math directive handler.
    """
    if argument and content:
        log.info(
            "For consistency, please use the math directive"
            " with all the equations in the content of the directive",
        )
        content = argument + content
    elif argument and not content:
        # Terse form: ``.. math:: x^2`` with the equation on the directive
        # line and no body. Promote the argument to the content.
        content = argument
    return [Math(content)]


#  A number of directives that so far are just small wrappers around admonitions.


def admonition_helper(
    name: str, argument: str | None, options: dict[str, str], content: str | None
) -> list[Any]:
    """
    This is a helper to return admonition.
    """
    assert not options
    if content:
        inner = parse(content.encode(), qa="")
        if len(inner) != 1 or not isinstance(inner[0], Section):
            log.warning(
                "admonition %r: expected 1 Section, got %r; rendering as plain text",
                name,
                inner,
            )
            return [
                Admonition(
                    kind=name,
                    children=[AdmonitionTitle([Text(f"{name} {argument}")])],
                )
            ]

        return [
            Admonition(
                kind=name,
                children=[
                    AdmonitionTitle([Text(f"{name} {argument}")]),
                    *inner[0].children,
                ],
            )
        ]
    else:
        return [
            Admonition(
                kind=name,
                children=[AdmonitionTitle([Text(f"{name} {argument}")])],
            )
        ]


def warning_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
    return admonition_helper("warning", argument, options, content)


def note_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
    return admonition_helper("note", argument, options, content)


def versionadded_handler(
    argument: str, options: dict[str, str], content: str
) -> list[Any]:
    return admonition_helper("versionadded", argument, options, content)


def versionchanged_handler(
    argument: str, options: dict[str, str], content: str
) -> list[Any]:
    return admonition_helper("versionchanged", argument, options, content)


def deprecated_handler(
    argument: str, options: dict[str, str], content: str
) -> list[Any]:
    return admonition_helper("deprecated", argument, options, content)


def seealso_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
    return admonition_helper("seealso", argument, options, content)


def _parse_int_option(options: dict[str, str], key: str, default: int = 0) -> int:
    raw = (options or {}).get(key)
    if raw is None:
        return default
    try:
        return int(str(raw).strip())
    except ValueError:
        log.warning("list-table: option %r is not an integer: %r", key, raw)
        return default


def list_table_handler(
    argument: str, options: dict[str, str], content: str
) -> list[Any]:
    """Handler for the ``.. list-table::`` directive.

    The directive body is a two-level bullet list — outer items are rows,
    inner items are cells.  The ``:header-rows:`` option (an integer count)
    marks how many leading rows are headers.

    ``argument`` is the optional caption; if present it's emitted as a
    leading ``Paragraph`` before the table (papyri has no caption-aware
    Table node yet — keeps the text from being silently dropped).

    Unsupported options (``:widths:``, ``:stub-columns:``, ``:align:``,
    ``:class:``, ``:name:``) are tolerated and ignored — the structured
    Table model doesn't carry presentation hints.
    """

    if not content.strip():
        log.warning("list-table: empty body; dropping directive")
        return []

    parsed = parse(content.encode(), qa="")
    bullet_list: BulletList | None = None
    if parsed and isinstance(parsed[0], Section):
        for node in parsed[0].children:
            if isinstance(node, BulletList):
                bullet_list = node
                break

    if bullet_list is None:
        log.warning(
            "list-table: body did not parse as a bullet list; dropping directive"
        )
        return []

    header_count = _parse_int_option(options or {}, "header-rows", 0)

    rows: list[TableRow] = []
    for row_idx, outer_item in enumerate(bullet_list.children):
        if not isinstance(outer_item, ListItem):
            log.warning(
                "list-table: outer row %d is not a list item; skipping", row_idx
            )
            continue
        inner_list: BulletList | None = None
        for c in outer_item.children:
            if isinstance(c, BulletList):
                inner_list = c
                break
        if inner_list is None:
            log.warning(
                "list-table: row %d has no inner bullet list of cells; skipping",
                row_idx,
            )
            continue

        cells: list[TableCell] = []
        for cell_item in inner_list.children:
            if not isinstance(cell_item, ListItem):
                continue
            cells.append(TableCell(children=tuple(cell_item.children)))

        rows.append(TableRow(header=row_idx < header_count, children=tuple(cells)))

    if not rows:
        log.warning("list-table: no rows parsed; dropping directive")
        return []

    out: list[Any] = []
    if argument and argument.strip():
        out.append(Paragraph([Text(argument.strip())]))
    out.append(Table(children=tuple(rows)))
    return out


def rubric_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
    """Handler for ``.. rubric::`` — an unnumbered section heading.

    Produces an ``Admonition(kind="rubric")`` so the text is visible without
    polluting the table-of-contents.  The argument is the heading text; an
    optional body (uncommon in practice) is parsed and appended.
    """
    title_text = (argument or "").strip()
    children: list[Any] = [AdmonitionTitle([Text(title_text)])] if title_text else []
    if content and content.strip():
        parsed = parse(content.encode(), qa="")
        if parsed and isinstance(parsed[0], Section):
            children.extend(parsed[0].children)
    return [Admonition(kind="rubric", children=tuple(children))]


def only_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
    """Handler for ``.. only::`` — always drop with a warning.

    ``.. only:: html`` blocks frequently contain ``.. raw:: html`` nodes, which
    must never reach the IR — raw HTML in untrusted doc sources is a security
    risk.  We cannot safely parse Sphinx conditional expressions, so we drop
    every ``only`` block regardless of the condition.

    TODO: this is the only HTML-adjacent handler and it should probably accept
    a ``passthrough=True`` option (or a set of safe condition expressions) so
    callers can opt in to receiving the parsed RST content when they know the
    block does not contain raw HTML.  The handler would then parse *content*
    via ``parse()`` and return the resulting nodes just like other handlers do,
    rather than always returning ``[]``.  Until that option exists, maintainers
    who want the content must rewrite or remove the ``.. only::`` wrapper in
    their source.
    """
    expr = (argument or "").strip()
    log.warning(
        "only directive: dropping block (condition=%r); "
        "raw HTML content is not safe to include in the IR",
        expr,
    )
    return []


def literalinclude_handler(
    argument: str, options: dict[str, str], content: str
) -> list[Any]:
    """Handler for ``.. literalinclude::`` — drop with a warning.

    Verbatim file inclusion requires filesystem access at gen time; we emit
    nothing and warn so the maintainer knows content was skipped.
    """
    log.warning(
        "literalinclude directive: file %r not embedded (filesystem access "
        "not available at gen time); dropping",
        (argument or "").strip(),
    )
    return []


def _parse_csv_row(line: str) -> list[str]:
    """Parse a single CSV row, respecting quoted fields."""
    import csv

    rows = list(csv.reader([line]))
    return rows[0] if rows else []


def csv_table_handler(
    argument: str, options: dict[str, str], content: str
) -> list[Any]:
    """Handler for ``.. csv-table::`` — CSV-formatted table directive.

    Mirrors ``list-table`` in producing ``Table`` / ``TableRow`` / ``TableCell``
    nodes.  Supported options: ``:header:`` (comma-separated header cells),
    ``:header-rows:`` (integer).  Unsupported presentation options
    (``:widths:``, ``:stub-columns:``, ``:align:``, etc.) are tolerated and
    ignored.
    """
    import csv as csv_mod

    opts = options or {}
    header_rows: list[TableRow] = []

    # Header from the :header: option (comma-separated quoted values).
    header_opt = opts.get("header", "")
    if header_opt and header_opt.strip():
        cells = [
            TableCell(children=(Paragraph([Text(cell.strip())]),))
            for cell in _parse_csv_row(header_opt)
        ]
        if cells:
            header_rows.append(TableRow(header=True, children=tuple(cells)))

    header_count = _parse_int_option(opts, "header-rows", 0)

    data_rows: list[TableRow] = []
    if content and content.strip():
        reader = csv_mod.reader(content.splitlines())
        for row_idx, raw_row in enumerate(reader):
            if not raw_row:
                continue
            cells = [
                TableCell(children=(Paragraph([Text(cell.strip())]),))
                for cell in raw_row
            ]
            data_rows.append(
                TableRow(header=row_idx < header_count, children=tuple(cells))
            )

    all_rows = header_rows + data_rows
    if not all_rows:
        log.warning("csv-table: no rows parsed; dropping directive")
        return []

    out: list[Any] = []
    if argument and argument.strip():
        out.append(Paragraph([Text(argument.strip())]))
    out.append(Table(children=tuple(all_rows)))
    return out


def make_image_handler(
    doc_path: Path | None,
    asset_store: Callable[[str, bytes], None] | None,
    module: str,
    version: str,
    doc_root: Path | None = None,
) -> Callable[[str, dict[str, str], str], list[Any]]:
    """Return an ``.. image::`` directive handler bound to the given asset context.

    The returned callable has the standard ``(argument, options, content)``
    handler signature and can be registered in ``DirectiveVisiter._handlers``
    like any other handler.

    Path resolution rules:

    - ``http://`` / ``https://`` URIs → ``Image`` node (no download).
    - Paths starting with ``/`` → resolved relative to *doc_root* (Sphinx
      absolute-path convention, e.g. ``/_images/foo.png``).  Falls back to
      an ``Image`` node with a warning when *doc_root* is ``None``.
    - All other paths → resolved relative to *doc_path* (sibling-relative).
      Falls back to an ``Image`` node with a warning when *doc_path* is
      ``None``.

    Parameters
    ----------
    doc_path
        Directory of the RST or Python source file being processed.  Used to
        resolve relative image paths.  ``None`` disables local-file embedding
        for relative paths.
    asset_store
        Callable ``(name, data)`` that stores raw bytes under *name* in the
        bundle's ``assets/`` directory.  ``None`` disables local-file embedding.
    module
        Root module name for the bundle (used to build the ``RefInfo``).
    version
        Bundle version string (used to build the ``RefInfo``).
    doc_root
        Root of the documentation tree.  Used to resolve ``/``-prefixed
        (Sphinx-absolute) paths such as ``/_images/foo.png``.  ``None``
        disables resolution of those paths.
    """

    def image_handler(
        argument: str, options: dict[str, str], content: str
    ) -> list[Figure | Image]:
        uri = (argument or "").strip()
        alt = (options or {}).get("alt", "") if isinstance(options, dict) else ""

        if uri.startswith(("http://", "https://")):
            return [Image(url=uri, alt=alt)]

        # Sphinx absolute paths (e.g. ``/_images/foo.png``) are relative to the
        # documentation root, not the current file's directory.
        if uri.startswith("/"):
            if doc_root is None or asset_store is None:
                log.warning(
                    "image directive: cannot embed root-relative path %r - "
                    "no doc_root/asset_store available",
                    uri,
                )
                return [Image(url=uri, alt=alt)]
            img_path = (doc_root / uri.lstrip("/")).resolve()
        else:
            if doc_path is None or asset_store is None:
                log.warning(
                    "image directive: cannot embed local path %r - "
                    "no doc_path/asset_store available (external URLs only)",
                    uri,
                )
                return [Image(url=uri, alt=alt)]
            img_path = (doc_path / uri).resolve()

        if not img_path.is_file():
            log.warning(
                "image directive: %s not found",
                img_path,
            )
            return [Image(url=uri, alt=alt)]

        asset_name = img_path.name
        asset_store(asset_name, img_path.read_bytes())
        return [Figure(RefInfo.from_untrusted(module, version, "assets", asset_name))]

    return image_handler


def make_include_handler(
    doc_path: Path | None,
    doc_root: Path | None,
) -> "Callable[[str, dict[str, str], str], list[Any]]":
    """Return an ``.. include::`` directive handler bound to the given path context.

    The returned callable has the standard ``(argument, options, content)``
    handler signature.  It resolves the included file relative to *doc_path*
    (for relative paths) or *doc_root* (for ``/``-prefixed Sphinx-absolute
    paths), reads it as RST, and returns the parsed IR nodes inline.

    Supported options:

    - ``:start-line:`` — first line to include (0-based, inclusive; negative
      values count from the end).
    - ``:end-line:``   — line at which to stop (0-based, exclusive; negative
      values count from the end).
    - ``:start-after:`` — skip everything up to and including the first
      occurrence of this text.
    - ``:end-after:``   — stop after the first occurrence of this text
      (the matching text itself is included in the output).

    When the file cannot be found, or when the required path context is absent,
    a warning is logged and an empty list is returned.
    """

    def include_handler(
        argument: str, options: dict[str, str], content: str
    ) -> list[Any]:
        from .ts import parse

        uri = (argument or "").strip()
        if not uri:
            log.warning("include directive: no file argument given; dropping")
            return []

        if uri.startswith("/"):
            if doc_root is None:
                log.warning(
                    "include directive: cannot resolve root-relative path %r "
                    "— no doc_root available",
                    uri,
                )
                return []
            inc_path = (doc_root / uri.lstrip("/")).resolve()
        else:
            if doc_path is None:
                log.warning(
                    "include directive: cannot resolve relative path %r "
                    "— no doc_path available",
                    uri,
                )
                return []
            inc_path = (doc_path / uri).resolve()

        if not inc_path.is_file():
            log.warning("include directive: %s not found; dropping", inc_path)
            return []

        text = inc_path.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines(keepends=True)

        # Line-range options (Python slice semantics handle negatives naturally).
        opts = options or {}
        start_line: int = _parse_int_option(opts, "start-line", 0)
        end_line: int | None = None
        raw_end = opts.get("end-line")
        if raw_end is not None:
            try:
                end_line = int(str(raw_end).strip())
            except ValueError:
                log.warning(
                    "include directive: :end-line: is not an integer: %r; ignoring",
                    raw_end,
                )

        lines = lines[start_line:end_line]

        # Text-search options applied to the (possibly sliced) lines.
        start_after = opts.get("start-after")
        if start_after:
            joined = "".join(lines)
            idx = joined.find(start_after)
            if idx == -1:
                log.warning(
                    "include directive: :start-after: text %r not found; "
                    "including entire (sliced) content",
                    start_after,
                )
            else:
                lines = (joined[idx + len(start_after) :]).splitlines(keepends=True)

        end_after = opts.get("end-after")
        if end_after:
            joined = "".join(lines)
            idx = joined.find(end_after)
            if idx == -1:
                log.warning(
                    "include directive: :end-after: text %r not found; "
                    "including entire (sliced) content",
                    end_after,
                )
            else:
                lines = (joined[: idx + len(end_after)]).splitlines(keepends=True)

        final_text = "".join(lines)
        if not final_text.strip():
            return []

        try:
            sections = parse(final_text.encode(), qa="")
        except Exception as e:
            log.warning("include directive: failed to parse %s: %s", inc_path, e)
            return []

        return list(sections)

    return include_handler
