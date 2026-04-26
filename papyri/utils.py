from __future__ import annotations

import importlib
from textwrap import dedent
from types import ModuleType
from typing import NewType


class FullQual(str):
    def __init__(self, qa):
        self._qa = qa

    def __str__(self):
        return self._qa


Cannonical = NewType("Cannonical", str)


def full_qual(obj) -> FullQual | None:
    """
    Compute the fully qualified name of an object.

    Unlike what we typically think of the fully qualified name
    of an object only comporting identifiers and dots(.) this uses
    a colon as the separator between the module part and the object's name
    and sub attributes.

    This is to lift an ambiguity when trying to get an object back from its
    fully qualified name.

    Assuming the following files, top level init imports a function from a
    submodule that has the same name as the submodule::

       # project/__init__.py
       from .sub import sub

    A submodule that define a class (here we use lowercase for the example::

       # project/sub.py

       class sub:
           attribute:str

       attribute = 'hello'

    and a second submodule::

       # project/attribute.py

       None

    Using qualified names only with dots (``.``) Can make it difficult to find out
    which object we are referring, or at least implements the logic to get those
    object back.

    For example, to get the object ``project.sub.attribute``, one would ``import
    project`` and ``x = getattr(project, 'sub')``, ``getattr(x, 'attribute')``.

    Though because of the ``from .sub import sub``, we end up getting the class
    attribute instead of the module.

    This ambiguity is lifted with a ``:`` as we now explicitly know the module
    part. ``package.sub.attribute``, ``package.sub:attribute``. Note that
    ``package:sub.attribute`` is also non-ambiguous, even if not the right fully
    qualified name for an object.

    Moreover, using ``:`` as a separator make the implementation much easier, as
    in the case of ``package.sub:attribute``, it is possible to directly execute
    ``importlib.import_module('package.sub')`` to obtain a reference to the
    ``sub`` submodule, without try/except or recursive ``getattr`` checking the
    the type of an object.
    """

    if isinstance(obj, ModuleType):
        return FullQual(obj.__name__)
    else:
        try:
            if hasattr(obj, "__qualname__") and (
                getattr(obj, "__module__", None) is not None
            ):
                return FullQual(obj.__module__ + ":" + obj.__qualname__)
            elif hasattr(obj, "__name__") and (
                getattr(obj, "__module__", None) is not None
            ):
                return FullQual(obj.__module__ + ":" + obj.__name__)
        except Exception:
            pass
        return None
    return None


def dedent_but_first(text):
    """
    simple version of `inspect.cleandoc` that does not trim empty lines
    """
    assert isinstance(text, str), (text, type(text))
    a, *b = text.split("\n")
    return dedent(a) + "\n" + dedent("\n".join(b))


def pos_to_nl(script: str, pos: int) -> tuple[int, int]:
    """
    Convert pigments position to Jedi col/line
    """
    rest = pos
    ln = 0
    for line in script.splitlines():
        if len(line) < rest:
            rest -= len(line) + 1
            ln += 1
        else:
            return ln, rest
    raise RuntimeError


def obj_from_qualname(name):
    mod_name, sep, objs = name.partition(":")
    module = importlib.import_module(mod_name)
    if not sep:
        return module
    else:
        obj = module
        parts = objs.split(".")
        for p in parts:
            obj = getattr(obj, p)
        return obj
