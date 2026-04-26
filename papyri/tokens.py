"""Tokenisation helpers for ``papyri gen``.

Two unrelated tokenisers live here, both used to turn user-authored
Python snippets into structured form:

- **Jedi-based identifier inference** for example blocks
  (``parse_script``). Each identifier in the snippet is enriched with
  its fully-qualified name when Jedi can infer one.
- **Pygments token-class extraction** for syntax-highlighting hints
  (``get_classes`` / ``_add_classes``).

A small on-disk cache under ``~/.cache/papyri/jedi/`` keyed by content
hash + day stops Jedi inference from re-running on every gen build.
"""

from __future__ import annotations

import datetime
import json
import logging
import warnings
from hashlib import sha256
from pathlib import Path

import jedi
from pygments import lex
from pygments.formatters import HtmlFormatter
from pygments.lexers import PythonLexer

from .utils import pos_to_nl

log = logging.getLogger("papyri")

_PYGMENTS_LEXER = PythonLexer()
_PYGMENTS_FMT = HtmlFormatter()

_JEDI_CACHE = Path("~/.cache/papyri/jedi/").expanduser()


def _hashf(text):
    ##  for cache expiring every day.
    ## for every hours, change to 0:13.

    return sha256(text.encode()).hexdigest() + datetime.datetime.now().isoformat()[0:10]


def _jedi_get_cache(text):
    _JEDI_CACHE.mkdir(exist_ok=True, parents=True)

    _cache = _JEDI_CACHE / _hashf(text)
    if _cache.exists():
        return tuple(tuple(x) for x in json.loads(_cache.read_text()))

    return None


def _jedi_set_cache(text, value):
    _JEDI_CACHE.mkdir(exist_ok=True, parents=True)

    _cache = _JEDI_CACHE / _hashf(text)
    _cache.write_text(json.dumps(value))


def parse_script(
    script: str, ns: dict, prev, config, *, where=None
) -> list[tuple[str, str | None]] | None:
    """
    Parse a script into tokens and use Jedi to infer the fully qualified names
    of each token.

    Parameters
    ----------
    script : str
        the script to tokenize and infer types on
    ns : dict
        Extra namespace to use with jedi's Interpreter. This will be used for
        implicit imports, for example that `np` is interpreted as numpy.
    prev : str
        previous lines that lead to this.
    where : <Insert Type here>
        <Multiline Description Here>
    config : <Insert Type here>
        <Multiline Description Here>

    Returns
    -------
    List of tuples with:
    text:
        text of the token
    reference : str
        fully qualified name of the type of current token

    """
    assert isinstance(ns, dict)
    jeds = []
    warnings.simplefilter("ignore", UserWarning)

    l_delta = prev.count("\n") + 1
    contextscript = prev + "\n" + script
    if ns:
        jeds.append(jedi.Interpreter(contextscript, namespaces=[ns]))
    full_text = prev + "\n" + script
    k = _jedi_get_cache(full_text)
    if k is not None:
        return k  # type: ignore[no-any-return]
    jeds.append(jedi.Script(full_text))
    P = PythonLexer()

    acc: list[tuple[str, str | None]] = []

    for index, _type, text in P.get_tokens_unprocessed(script):
        line_n, col_n = pos_to_nl(script, index)
        line_n += l_delta
        ref = None
        if not config.infer or (text in (" .=()[],")) or not text.isidentifier():
            acc.append((text, ""))
            continue

        for jed in jeds:
            try:
                inf = jed.infer(line_n + 1, col_n)
                if inf:
                    # TODO: we might want the qualname to
                    # be module_name:name for disambiguation.
                    ref = inf[0].full_name
            except (AttributeError, TypeError) as e:
                raise type(e)(
                    f"{contextscript}, {line_n=}, {col_n=}, {prev=}, {jed=}"
                ) from e
            except jedi.inference.utils.UncaughtAttributeError:
                if config.jedi_failure_mode in (None, "error"):
                    raise
                elif config.jedi_failure_mode == "log":
                    log.warning(
                        "failed inference example will be empty %r %r %r",
                        where,
                        line_n,
                        col_n,
                    )
                    return None
            break
        acc.append((text, ref))
    _jedi_set_cache(full_text, acc)
    warnings.simplefilter("default", UserWarning)
    for a in acc:
        assert len(a) == 2
    return acc


def get_classes(code):
    """
    Extract Pygments token classes names for given code block
    """
    tokens = list(lex(code, _PYGMENTS_LEXER))
    classes = [_PYGMENTS_FMT.ttype2class.get(x, "") for x, _ in tokens]
    return classes


def _add_classes(entries):
    assert set(len(x) for x in entries) == {2}
    text = "".join([x for x, y in entries])
    classes = get_classes(text)
    return [(*ii, cc) for ii, cc in zip(entries, classes, strict=True)]
