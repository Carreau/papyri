"""
Various directive handlers.
"""

import logging
from collections.abc import Callable
from pathlib import Path

from .nodes import (
    Admonition,
    AdmonitionTitle,
    Figure,
    Image,
    Math,
    RefInfo,
    Section,
    Text,
)
from .ts import parse

log = logging.getLogger("papyri")


def block_math_handler(argument, options, content):
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


def admonition_helper(name, argument, options, content):
    """
    This is a helper to return admonition.
    """
    assert not options
    if content:
        inner = parse(content.encode(), qa="")
        assert len(inner) == 1

        assert isinstance(inner[0], Section)

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


def warning_handler(argument, options, content):
    return admonition_helper("warning", argument, options, content)


def note_handler(argument, options, content):
    return admonition_helper("note", argument, options, content)


def versionadded_handler(argument, options, content):
    return admonition_helper("versionadded", argument, options, content)


def versionchanged_handler(argument, options, content):
    return admonition_helper("versionchanged", argument, options, content)


def deprecated_handler(argument, options, content):
    return admonition_helper("deprecated", argument, options, content)


def make_image_handler(
    doc_path: Path | None,
    asset_store: Callable[[str, bytes], None] | None,
    module: str,
    version: str,
) -> Callable:
    """Return an ``.. image::`` directive handler bound to the given asset context.

    The returned callable has the standard ``(argument, options, content)``
    handler signature and can be registered in ``DirectiveVisiter._handlers``
    like any other handler.

    Local paths are resolved relative to *doc_path*, read from disk, stored via
    *asset_store*, and represented as a ``Figure`` node so the viewer can serve
    them alongside matplotlib-generated figures.  External URLs (http/https) and
    any path that cannot be resolved produce an ``Image`` node instead.

    Parameters
    ----------
    doc_path
        Directory of the RST or Python source file being processed.  Used to
        resolve relative image paths.  ``None`` disables local-file embedding.
    asset_store
        Callable ``(name, data)`` that stores raw bytes under *name* in the
        bundle's ``assets/`` directory.  ``None`` disables local-file embedding.
    module
        Root module name for the bundle (used to build the ``RefInfo``).
    version
        Bundle version string (used to build the ``RefInfo``).
    """

    def image_handler(
        argument: str, options: dict, content: str
    ) -> list[Figure | Image]:
        uri = (argument or "").strip()
        alt = (options or {}).get("alt", "") if isinstance(options, dict) else ""

        if uri.startswith(("http://", "https://")):
            return [Image(url=uri, alt=alt)]

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
                "image directive: %s not found (resolved from %s)",
                img_path,
                doc_path,
            )
            return [Image(url=uri, alt=alt)]

        asset_name = img_path.name
        asset_store(asset_name, img_path.read_bytes())
        return [Figure(RefInfo.from_untrusted(module, version, "assets", asset_name))]

    return image_handler
