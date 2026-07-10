#!/usr/bin/env python
"""Inject IPython's script-generated documentation into a DocBundle.

IPython's Sphinx build runs three ``docs/autogen_*.py`` scripts before
``sphinx-build`` to generate the traitlets config-options reference, the
magics listing, and the keyboard-shortcuts table.  This script produces
the same content by introspecting IPython directly and patches it into
the bundle as IR nodes — a custom step between ``gen`` and ``pack``, with
no intermediate RST files and no re-parsing::

    papyri gen examples/IPython.toml
    python examples/ipython_inject.py ~/.papyri/data/IPython_<version>
    papyri pack ~/.papyri/data/IPython_<version>

Idempotent: each injected block replaces any previous block with the same
leading section title (``papyri.bundle_edit.replace_block``), so
re-running updates content in place.  Run against a bundle generated from
a clean IPython docs tree — stale ``autogen_*`` output from a previous
Sphinx build would be collected by ``gen`` as well and duplicate this
content.
"""

from __future__ import annotations

import re
import sys
from inspect import getsource
from pathlib import Path

from papyri.bundle_edit import read_doc, replace_block, write_doc
from papyri.nodes import (
    Admonition,
    AdmonitionTitle,
    Code,
    DefList,
    DefListItem,
    InlineCode,
    Paragraph,
    Section,
    Table,
    TableCell,
    TableRow,
    Text,
)


def _p(*inline) -> Paragraph:
    return Paragraph(tuple(inline))


def _cell(*inline) -> TableCell:
    return TableCell(children=(_p(*inline),))


def _section(title: str, children, level: int) -> Section:
    return Section(tuple(children), (Text(title),), level=level)


# ---------------------------------------------------------------------------
# Config options (port of docs/autogen_config.py)
# ---------------------------------------------------------------------------

CONFIG_TITLE = "Terminal IPython options"


def _interesting_default(value) -> bool:
    from traitlets import Undefined

    if value is None or value is Undefined:
        return False
    if isinstance(value, (str, list, tuple, dict, set)):
        return bool(value)
    return True


def _format_aliases(aliases: list[str]) -> str:
    return ", ".join(f"{'-' if len(a) == 1 else '--'}{a}" for a in aliases)


def _reverse_aliases(app) -> dict[str, list[str]]:
    """Produce a mapping of trait names to lists of command line aliases."""
    res: dict[str, list[str]] = {}
    for alias, trait in app.aliases.items():
        exp = trait[0] if isinstance(trait, tuple) else trait
        res.setdefault(exp, []).append(alias)
    # Treat flags which set one trait to True as aliases.
    for flag, (cfg, _) in app.flags.items():
        if len(cfg) == 1:
            classname = next(iter(cfg))
            cls_cfg = cfg[classname]
            if len(cls_cfg) == 1:
                traitname = next(iter(cls_cfg))
                if cls_cfg[traitname] is True:
                    res.setdefault(f"{classname}.{traitname}", []).append(flag)
    return res


def _trait_admonition(cls, trait, trait_aliases) -> Admonition:
    import inspect as _inspect

    fullname = f"{cls.__name__}.{trait.name}"
    children: list = [AdmonitionTitle((Text(fullname),))]

    help_text = _inspect.cleandoc(trait.help.rstrip() or "No description")
    children.extend(
        _p(Text(" ".join(para.split()))) for para in re.split(r"\n\s*\n", help_text)
    )

    ttype = trait.__class__.__name__
    if "Enum" in ttype:
        children.append(
            _p(Text("Options: " + ", ".join(repr(x) for x in trait.values)))
        )
    else:
        children.append(_p(Text("Trait type: "), InlineCode(ttype)))
    if _interesting_default(trait.default_value):
        try:
            # single-line: InlineCode rejects embedded newlines
            dv = " ".join(trait.default_value_repr().split())
            children.append(_p(Text("Default: "), InlineCode(dv)))
        except Exception:
            pass
    if fullname in trait_aliases:
        children.append(
            _p(
                Text("CLI option: "),
                InlineCode(_format_aliases(trait_aliases[fullname])),
            )
        )
    return Admonition(kind="admonition", children=tuple(children))


def config_options_block() -> list[Section]:
    from IPython.terminal.ipapp import TerminalIPythonApp

    app = TerminalIPythonApp()
    trait_aliases = _reverse_aliases(app)
    body: list = [
        _p(
            Text(
                "Any of the options listed here can be set in config files, "
                "at the command line, or from inside IPython."
            )
        )
    ]
    for cls in app._classes_inc_parents():
        for _, trait in sorted(cls.class_traits(config=True).items()):
            body.append(_trait_admonition(cls, trait, trait_aliases))
    return [_section(CONFIG_TITLE, body, level=2)]


# ---------------------------------------------------------------------------
# Magics (port of docs/autogen_magics.py)
# ---------------------------------------------------------------------------

LINE_MAGICS_TITLE = "Line magics"
CELL_MAGICS_TITLE = "Cell magics"


def _magic_items(kind: str, prefix: str) -> DefList:
    from IPython.core.alias import Alias
    from IPython.core.interactiveshell import InteractiveShell
    from IPython.core.magic import MagicAlias

    magics = InteractiveShell.instance().magics_manager.magics
    items = []
    for name, func in sorted(magics[kind].items(), key=lambda kv: kv[0].lower()):
        if isinstance(func, (Alias, MagicAlias)):
            continue
        if kind == "cell" and (
            name == "!" or func == magics["line"].get(name, object())
        ):
            continue
        docstring = (func.__doc__ or "Undocumented").rstrip()
        items.append(
            DefListItem(
                dt=_p(InlineCode(f"{prefix}{name}")),
                dd=(Code(docstring),),
            )
        )
    return DefList(children=tuple(items))


def magics_blocks() -> tuple[list[Section], list[Section]]:
    line = [_section(LINE_MAGICS_TITLE, [_magic_items("line", "%")], level=2)]
    cell = [_section(CELL_MAGICS_TITLE, [_magic_items("cell", "%%")], level=2)]
    return line, cell


# ---------------------------------------------------------------------------
# Keyboard shortcuts (port of docs/autogen_shortcuts.py)
# ---------------------------------------------------------------------------

SHORTCUTS_TITLE = "Shortcuts reference"

_CONJUNCTIONS = {"_AndList": "&", "_OrList": "|"}
_ATOMIC = {"Never", "Always", "Condition"}


def _format_filter(filter_, human_names, is_top_level=True) -> str:
    """Human-readable description of a prompt_toolkit filter expression."""
    s = filter_.__class__.__name__
    if s == "Condition":
        if filter_ in human_names:
            return human_names[filter_]
        name = filter_.func.__name__
        if name == "<lambda>":
            return getsource(filter_.func).split("=")[0].strip()
        return name
    elif s == "_Invert":
        operand = filter_.filter
        inner = _format_filter(operand, human_names, is_top_level=False)
        if operand.__class__.__name__ in _ATOMIC:
            return f"~{inner}"
        return f"~({inner})"
    elif s in _CONJUNCTIONS:
        if filter_ in human_names:
            return human_names[filter_]
        glue = f" {_CONJUNCTIONS[s]} "
        result = glue.join(
            _format_filter(x, human_names, is_top_level=False) for x in filter_.filters
        )
        if len(filter_.filters) > 1 and not is_top_level:
            result = f"({result})"
        return result
    elif s in ("Never", "Always"):
        return s.lower()
    elif s == "PassThrough":
        return "pass_through"
    raise ValueError(f"Unknown filter type: {filter_}")


def _sentencize(s: str) -> str:
    parts = re.split(r"\.\W", s.replace("\n", " ").strip())
    first = parts[0] if parts else ""
    if not first.endswith("."):
        first += "."
    return " ".join(first.split())


class _DummyTerminal:
    """Used as a buffer to get prompt_toolkit bindings."""

    handle_return = None
    input_transformer_manager = None
    display_completions = None
    editing_mode = "emacs"
    auto_suggest = None


def _keys_cells(keys_sequence, key_aliases) -> list:
    """Inline nodes for a key sequence: InlineCode keys joined by ' + '."""
    inline: list = []
    for i, keys in enumerate(keys_sequence):
        if i:
            inline.append(Text(", "))
        prefix_mods = {
            "c-s-": ["ctrl", "shift"],
            "s-c-": ["ctrl", "shift"],
            "c-": ["ctrl"],
            "s-": ["shift"],
        }
        for prefix, mods in prefix_mods.items():
            if keys.startswith(prefix):
                to_press = [*mods, keys[len(prefix) :]]
                break
        else:
            to_press = [keys]
        for j, k in enumerate(to_press):
            if j:
                inline.append(Text(" + "))
            inline.append(InlineCode(k))
        if keys in key_aliases:
            inline.extend((Text(" (or "), InlineCode(key_aliases[keys]), Text(")")))
    return inline


def shortcuts_block() -> list[Section]:
    from IPython.terminal.shortcuts import (
        create_identifier,
        create_ipython_shortcuts,
    )
    from IPython.terminal.shortcuts.filters import KEYBINDING_FILTERS
    from prompt_toolkit.keys import KEY_ALIASES
    from prompt_toolkit.shortcuts import PromptSession

    human_names = {f: name for name, f in KEYBINDING_FILTERS.items()}
    key_aliases = {**KEY_ALIASES, **{v: k for k, v in KEY_ALIASES.items()}}

    ipy_bindings = create_ipython_shortcuts(_DummyTerminal())
    session = PromptSession(key_bindings=ipy_bindings)
    prompt_bindings = session.app.key_bindings
    assert prompt_bindings
    # Ensure that we collected the prompt_toolkit defaults too.
    assert len(prompt_bindings.bindings) > len(ipy_bindings.bindings)

    rows = [
        TableRow(
            header=True,
            children=(
                _cell(Text("Shortcut")),
                _cell(Text("Description and identifier")),
                _cell(Text("When (filter)")),
            ),
        )
    ]
    collected = []
    for kb in prompt_bindings.bindings:
        identifier = create_identifier(kb.handler)
        keys = [str(k.value) if hasattr(k, "value") else k for k in kb.keys]
        filter_ = _format_filter(kb.filter, human_names)
        description = _sentencize(kb.handler.__doc__ or "")
        collected.append((identifier, filter_, keys, description))
    for identifier, filter_, keys, description in sorted(collected):
        rows.append(
            TableRow(
                header=False,
                children=(
                    _cell(*_keys_cells(keys, key_aliases)),
                    _cell(Text(description + " "), InlineCode(identifier)),
                    _cell(Text("-" if filter_ == "always" else filter_)),
                ),
            )
        )
    return [_section(SHORTCUTS_TITLE, [Table(children=tuple(rows))], level=2)]


# ---------------------------------------------------------------------------


def main(bundle_dir: Path) -> None:
    line_block, cell_block = magics_blocks()
    patches = [
        ("config:options:index", [(CONFIG_TITLE, config_options_block())]),
        (
            "interactive:magics",
            [(LINE_MAGICS_TITLE, line_block), (CELL_MAGICS_TITLE, cell_block)],
        ),
        ("config:shortcuts:index", [(SHORTCUTS_TITLE, shortcuts_block())]),
    ]
    for key, blocks in patches:
        doc = read_doc(bundle_dir, key)
        for title, sections in blocks:
            replace_block(doc, title, sections)
        write_doc(bundle_dir, key, doc)
        print(f"patched docs/{key} ({', '.join(t for t, _ in blocks)})")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(f"usage: {sys.argv[0]} ~/.papyri/data/IPython_<version>")
    main(Path(sys.argv[1]))
