"""
Various directive handlers.
"""

import logging
from collections.abc import Callable
from itertools import count
from pathlib import Path
from typing import Any

from .nodes import (
    Admonition,
    AdmonitionTitle,
    BulletList,
    Code,
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
    UnprocessedDirective,
)
from .ts import parse

log = logging.getLogger("papyri")

# A ``warn`` callback lets a handler report a malformed/unprocessable directive
# through the gen-time ``Diagnostics`` collector (as ``W-malformed-directive``)
# when one is available. Handlers built outside ``papyri gen`` (tests, the
# standalone helpers in ``papyri.tests.utils``) fall back to ``_log_warn`` so
# they still surface the message without a collector wired in.
DirectiveWarn = Callable[[str], None]


def _log_warn(msg: str) -> None:
    log.warning(msg)


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


def code_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
    """Directive handler that wraps the directive body in a ``Code`` node.

    Registered by default for ``code``, ``code-block``, and ``sourcecode``.
    Also useful for domain-specific code directives — for example, the
    IPython Sphinx extension's ``.. ipython::``::

        [global.directives]
        ipython = 'papyri.directives:code_handler'

    The directive argument (the lexer name, e.g. ``python`` or ``ipython``)
    is currently ignored — ``Code`` does not yet carry a language hint.
    """
    return [Code(content)]


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


def _parse_int_option(
    options: dict[str, str],
    key: str,
    default: int = 0,
    warn: DirectiveWarn = _log_warn,
) -> int:
    raw = (options or {}).get(key)
    if raw is None:
        return default
    try:
        return int(str(raw).strip())
    except ValueError:
        warn(f"list-table: option {key!r} is not an integer: {raw!r}")
        return default


def list_table_handler(
    argument: str,
    options: dict[str, str],
    content: str,
    *,
    warn: DirectiveWarn = _log_warn,
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
        warn("list-table: empty body; dropping directive")
        return []

    parsed = parse(content.encode(), qa="")
    bullet_list: BulletList | None = None
    if parsed and isinstance(parsed[0], Section):
        for node in parsed[0].children:
            if isinstance(node, BulletList):
                bullet_list = node
                break

    if bullet_list is None:
        warn("list-table: body did not parse as a bullet list; dropping directive")
        return []

    header_count = _parse_int_option(options or {}, "header-rows", 0, warn=warn)

    rows: list[TableRow] = []
    for row_idx, outer_item in enumerate(bullet_list.children):
        if not isinstance(outer_item, ListItem):
            warn(f"list-table: outer row {row_idx} is not a list item; skipping")
            continue
        inner_list: BulletList | None = None
        for c in outer_item.children:
            if isinstance(c, BulletList):
                inner_list = c
                break
        if inner_list is None:
            warn(
                f"list-table: row {row_idx} has no inner bullet list of cells; skipping"
            )
            continue

        cells: list[TableCell] = []
        for cell_item in inner_list.children:
            if not isinstance(cell_item, ListItem):
                continue
            cells.append(TableCell(children=tuple(cell_item.children)))

        rows.append(TableRow(header=row_idx < header_count, children=tuple(cells)))

    if not rows:
        warn("list-table: no rows parsed; dropping directive")
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


def attention_handler(
    argument: str, options: dict[str, str], content: str
) -> list[Any]:
    return admonition_helper("attention", argument, options, content)


def caution_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
    return admonition_helper("caution", argument, options, content)


def danger_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
    return admonition_helper("danger", argument, options, content)


def error_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
    return admonition_helper("error", argument, options, content)


def hint_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
    return admonition_helper("hint", argument, options, content)


def important_handler(
    argument: str, options: dict[str, str], content: str
) -> list[Any]:
    return admonition_helper("important", argument, options, content)


def tip_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
    return admonition_helper("tip", argument, options, content)


def admonition_handler(
    argument: str, options: dict[str, str], content: str
) -> list[Any]:
    """Handler for the generic ``.. admonition:: Title`` directive.

    Unlike the named admonitions (``.. note::``, ``.. warning::``, etc.) the
    generic ``admonition`` carries an explicit user-supplied title as its
    argument.  The body is an optional RST block.
    """
    title_text = (argument or "").strip()
    children: list[Any] = [AdmonitionTitle([Text(title_text)])] if title_text else []
    if content and content.strip():
        parsed = parse(content.encode(), qa="")
        if parsed and isinstance(parsed[0], Section):
            children.extend(parsed[0].children)
        else:
            log.warning(
                "admonition directive: body did not parse as a single Section; "
                "rendering as plain title only"
            )
    return [Admonition(kind="admonition", children=tuple(children))]


def topic_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
    """Handler for ``.. topic:: Title`` — a self-contained mini-section.

    Produces an ``Admonition(kind="topic")`` with the argument as its title
    and the parsed body as children.
    """
    title_text = (argument or "").strip()
    children: list[Any] = [AdmonitionTitle([Text(title_text)])] if title_text else []
    if content and content.strip():
        parsed = parse(content.encode(), qa="")
        if parsed and isinstance(parsed[0], Section):
            children.extend(parsed[0].children)
    return [Admonition(kind="topic", children=tuple(children))]


def raw_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
    """Handler for ``.. raw::`` — always drop with a warning.

    Raw HTML/LaTeX/etc. content must never reach the IR — it is a security
    risk (XSS via raw HTML) and is meaningless outside the target output format.
    """
    fmt = (argument or "").strip()
    log.info(
        "raw directive: dropping block (format=%r); "
        "raw output-format content is not safe to include in the IR",
        fmt,
    )
    return []


def container_handler(
    argument: str, options: dict[str, str], content: str
) -> list[Any]:
    """Handler for ``.. container::`` — unfold wrapped content.

    The ``container`` directive is a structural wrapper with an optional CSS
    class name.  Since the papyri IR has no class-name concept for block
    nodes, we drop the wrapper and return the parsed children directly.
    """
    if not content or not content.strip():
        return []
    parsed = parse(content.encode(), qa="")
    nodes: list[Any] = []
    for section in parsed:
        if hasattr(section, "children"):
            nodes.extend(section.children)
    return nodes


_plot_counter = count(0)


def make_plot_handler(
    asset_store: Callable[[str, bytes], None] | None,
    module: str,
    version: str,
    execute: bool = False,
    qa: str = "plot",
    doc_path: Path | None = None,
    doc_root: Path | None = None,
    warn: DirectiveWarn = _log_warn,
) -> Callable[[str, dict[str, str], str], list[Any]]:
    """Return a ``.. plot::`` directive handler bound to the given execution context.

    When *execute* is ``True`` and *asset_store* is available the code body is
    run via ``BlockExecutor`` (same mechanism as doctest examples in gen.py).
    Every matplotlib figure open after the run is saved as a bundle asset and
    appended as a ``Figure`` node after the ``Code`` node.

    When *execute* is ``False`` (or matplotlib / *asset_store* are absent) the
    code body is returned as a bare ``Code`` node so the example is not lost.

    Matching Sphinx's plot directive semantics:

    - An argument naming an external ``.py`` script embeds that file as the
      code body (``/``-prefixed paths resolve against *doc_root*, others
      against *doc_path*; the inline body, if any, is the caption — dropped).
    - A doctest-format body (``>>>`` prompts) is displayed verbatim but has
      its prompts stripped for execution.
    - Execution namespace is pre-seeded like matplotlib's default
      ``plot_pre_code`` (``import numpy as np``,
      ``from matplotlib import pyplot as plt``).
    """

    def plot_handler(argument: str, options: dict[str, str], content: str) -> list[Any]:
        script_file = (argument or "").strip()
        if script_file:
            if script_file.startswith("/"):
                base, rel = doc_root, script_file.lstrip("/")
            else:
                base, rel = doc_path, script_file
            if base is None:
                warn(
                    f"plot directive: cannot embed external script {script_file!r} "
                    "at gen time; dropping"
                )
                return []
            script_path = (base / rel).resolve()
            if not script_path.is_file():
                warn(f"plot directive: script {script_file!r} not found in {base}")
                return []
            # With a script argument, the directive body is the caption —
            # the code comes from the file.
            content = script_path.read_text()
        if not content or not content.strip():
            return []

        nodes: list[Any] = [Code(content)]

        if execute and asset_store is not None:
            # Sphinx's plot directive also accepts doctest-format bodies;
            # strip the prompts for execution (display keeps them).
            exec_source = content
            if any(ln.lstrip().startswith(">>>") for ln in content.splitlines()):
                import doctest as _doctest

                exec_source = "".join(
                    ex.source for ex in _doctest.DocTestParser().get_examples(content)
                )
            try:
                from .executors import BlockExecutor

                # Mirror matplotlib's default ``plot_pre_code``: plot bodies
                # assume np/plt are in scope.
                ns: dict[str, Any] = {}
                exec("import numpy as np\nfrom matplotlib import pyplot as plt\n", ns)
                executor = BlockExecutor(ns)
                with executor:
                    executor.exec(exec_source, name=qa)
                    fig_bytes_list = executor.get_figs()
                for fig_bytes in fig_bytes_list:
                    n = next(_plot_counter)
                    figname = f"fig-plot-{n}.png"
                    asset_store(figname, fig_bytes)
                    nodes.append(
                        Figure(
                            RefInfo.from_untrusted(module, version, "assets", figname)
                        )
                    )
            except Exception as exc:
                warn(f"plot directive: figure generation failed in {qa}: {exc}")

        return nodes

    return plot_handler


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
    log.info(
        "literalinclude directive: file %r not embedded (not implemented yet); dropping",
        (argument or "").strip(),
    )
    return []


def _parse_csv_row(line: str) -> list[str]:
    """Parse a single CSV row, respecting quoted fields."""
    import csv

    rows = list(csv.reader([line]))
    return rows[0] if rows else []


def csv_table_handler(
    argument: str,
    options: dict[str, str],
    content: str,
    *,
    warn: DirectiveWarn = _log_warn,
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

    header_count = _parse_int_option(opts, "header-rows", 0, warn=warn)

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
        warn("csv-table: no rows parsed; dropping directive")
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
    warn: DirectiveWarn = _log_warn,
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
                warn(
                    f"image directive: cannot embed root-relative path {uri!r} - "
                    "no doc_root/asset_store available"
                )
                return [Image(url=uri, alt=alt)]
            img_path = (doc_root / uri.lstrip("/")).resolve()
        else:
            if doc_path is None or asset_store is None:
                warn(
                    f"image directive: cannot embed local path {uri!r} - "
                    "no doc_path/asset_store available (external URLs only)"
                )
                return [Image(url=uri, alt=alt)]
            img_path = (doc_path / uri).resolve()

        if not img_path.is_file():
            warn(f"image directive: {img_path} not found")
            return [Image(url=uri, alt=alt)]

        asset_name = img_path.name
        asset_store(asset_name, img_path.read_bytes())
        return [Figure(RefInfo.from_untrusted(module, version, "assets", asset_name))]

    return image_handler


def make_figure_handler(
    doc_path: Path | None,
    asset_store: Callable[[str, bytes], None] | None,
    module: str,
    version: str,
    doc_root: Path | None = None,
    warn: DirectiveWarn = _log_warn,
) -> Callable[[str, dict[str, str], str], list[Any]]:
    """Return a ``.. figure::`` directive handler bound to the given asset context.

    The ``figure`` directive is like ``image`` but may carry an optional
    caption in its body.  Path resolution is identical to ``make_image_handler``;
    the caption (if present) is appended as a ``Paragraph`` after the image node.
    """
    image_handler = make_image_handler(
        doc_path, asset_store, module, version, doc_root, warn=warn
    )

    def figure_handler(
        argument: str, options: dict[str, str], content: str
    ) -> list[Any]:
        nodes = image_handler(argument, options, "")
        if content and content.strip():
            caption_sections = parse(content.strip().encode(), qa="")
            for section in caption_sections:
                if hasattr(section, "children"):
                    nodes.extend(section.children)
        return nodes

    return figure_handler


def make_include_handler(
    doc_path: Path | None,
    doc_root: Path | None,
    warn: DirectiveWarn = _log_warn,
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
            warn("include directive: no file argument given; dropping")
            return []

        if content and content.strip():
            warn(
                f"include directive: unexpected body content for {uri!r}; "
                "the include directive takes only a filename argument — dropping"
            )
            return []

        if uri.startswith("/"):
            if doc_root is None:
                warn(
                    f"include directive: cannot resolve root-relative path {uri!r} "
                    "— no doc_root available"
                )
                return []
            inc_path = (doc_root / uri.lstrip("/")).resolve()
        else:
            if doc_path is None:
                warn(
                    f"include directive: cannot resolve relative path {uri!r} "
                    "— no doc_path available"
                )
                return []
            inc_path = (doc_path / uri).resolve()

        if not inc_path.is_file():
            warn(f"include directive: {inc_path} not found; dropping")
            return []

        text = inc_path.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines(keepends=True)

        # Line-range options (Python slice semantics handle negatives naturally).
        opts = options or {}
        start_line: int = _parse_int_option(opts, "start-line", 0, warn=warn)
        end_line: int | None = None
        raw_end = opts.get("end-line")
        if raw_end is not None:
            try:
                end_line = int(str(raw_end).strip())
            except ValueError:
                warn(
                    f"include directive: :end-line: is not an integer: {raw_end!r}; "
                    "ignoring"
                )

        lines = lines[start_line:end_line]

        # Text-search options applied to the (possibly sliced) lines.
        start_after = opts.get("start-after")
        if start_after:
            joined = "".join(lines)
            idx = joined.find(start_after)
            if idx == -1:
                warn(
                    f"include directive: :start-after: text {start_after!r} not "
                    "found; including entire (sliced) content"
                )
            else:
                lines = (joined[idx + len(start_after) :]).splitlines(keepends=True)

        end_after = opts.get("end-after")
        if end_after:
            joined = "".join(lines)
            idx = joined.find(end_after)
            if idx == -1:
                warn(
                    f"include directive: :end-after: text {end_after!r} not found; "
                    "including entire (sliced) content"
                )
            else:
                lines = (joined[: idx + len(end_after)]).splitlines(keepends=True)

        final_text = "".join(lines)
        if not final_text.strip():
            return []

        try:
            sections = parse(final_text.encode(), qa="")
        except Exception as e:
            warn(f"include directive: failed to parse {inc_path}: {e}")
            return []

        # Nested ``.. include::`` directives inside the parsed content must
        # resolve against the included file's directory, not the outer file's.
        # Otherwise the outer visitor's ``generic_visit`` would walk them with
        # the handler bound at the outer scope (this closure's ``doc_path``)
        # and follow paths relative to the wrong file. Build an inner handler
        # bound to the included file's parent and pre-resolve them in place.
        inner_handler = make_include_handler(inc_path.parent, doc_root, warn=warn)
        for s in sections:
            _resolve_nested_includes(s, inner_handler)

        # ts.parse wraps top-level RST in synthetic ``Section`` nodes, but the
        # include directive is invoked from inside *another* Section's children
        # — and Section is not in that field's type union. Returning the raw
        # sections would put Section in Section.children and trip validate().
        # The include is a content-fragment splice, so flatten one level: drop
        # the wrapper Sections and inline their children. Any actually-titled
        # sub-section is preserved (it sits one level deeper, in those
        # children).
        out: list[Any] = []
        for s in sections:
            out.extend(s.children)
        return out

    return include_handler


def _resolve_nested_includes(
    node: Any,
    inner_handler: "Callable[[str, dict[str, str], str], list[Any]]",
) -> None:
    """Walk *node*'s subtree, splicing the result of *inner_handler* in place
    of any nested ``UnprocessedDirective(name="include")`` child."""
    if not hasattr(node, "children"):
        return
    new_children: list[Any] = []
    for child in node.children:
        if isinstance(child, UnprocessedDirective) and child.name == "include":
            new_children.extend(
                inner_handler(child.args or "", child.options, child.value or "")
            )
        else:
            _resolve_nested_includes(child, inner_handler)
            new_children.append(child)
    node.children = tuple(new_children)
