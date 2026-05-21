from __future__ import annotations

import json
import types
import typing
from collections.abc import Callable
from typing import Any, Self

import cbor2

from .node_serializer import serialize as _serialize
from .serde import deserialize, get_type_hints


class Base:
    def validate(self) -> Self:
        validate(self)
        return self

    @classmethod
    def _instance(cls) -> Self:
        return cls()


def _coerce_field(ann: Any, val: Any) -> Any:
    """Coerce val to the mutable→immutable type the annotation requires.

    Node fields annotated as tuple[T, ...] must be tuples at runtime so that
    cbor2 ≥ 6 (which decodes CBOR arrays inside tagged values as tuples) and
    code that passes plain Python lists both produce the same stored type.

    Also handles Optional[tuple[T, ...]] (i.e. ``tuple[T, ...] | None``).
    """
    origin = getattr(ann, "__origin__", None)
    if origin is tuple and isinstance(val, list):
        return tuple(val)
    # Handle X | Y unions (types.UnionType, Python 3.10+) and typing.Union
    if isinstance(ann, types.UnionType) or origin is typing.Union:
        for arg in ann.__args__:
            if getattr(arg, "__origin__", None) is tuple and isinstance(val, list):
                return tuple(val)
    return val


class Node(Base):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        tt = get_type_hints(type(self))  # type: ignore[arg-type]
        if type(self).__name__ == "Directive":
            tt = {k: v for k, v in tt.items() if k != "type"}
        for attr, val in zip(tt, args, strict=False):
            setattr(self, attr, _coerce_field(tt[attr], val))
        for k, v in kwargs.items():
            if k not in tt:
                raise TypeError(
                    f"unexpected keyword argument {k!r} (valid: {list(tt)})"
                )
            setattr(self, k, _coerce_field(tt[k], v))
        if hasattr(self, "_post_deserialise"):
            self._post_deserialise()

    def cbor(self, encoder: Any) -> None:
        tag = TAG_MAP[type(self)]
        attrs = get_type_hints(type(self))  # type: ignore[arg-type]
        values = []
        for k in attrs:
            v = getattr(self, k)
            # Comment nodes are kept in the Python IR / JSON so downstream
            # tools can post-process them, but they have no semantic content
            # and must not appear in the packed CBOR bundle.
            if isinstance(v, (list, tuple)):
                v = [x for x in v if not getattr(type(x), "_drop_in_cbor", False)]
            values.append(v)
        encoder.encode(cbor2.CBORTag(tag, values))

    def __eq__(self, other: object) -> bool:
        if not (type(self) == type(other)):
            return False
        tt = get_type_hints(type(self))  # type: ignore[arg-type]
        for attr in tt:
            a, b = getattr(self, attr), getattr(other, attr)
            if a != b:
                return False

        return True

    def __repr__(self) -> str:
        tt = get_type_hints(type(self))  # type: ignore[arg-type]
        acc = ""
        for t in tt:
            acc += f"{t}: {getattr(self, t)!r}\n"

        return f"<{self.__class__.__name__}: \n{indent(acc)}>"

    def to_json(self) -> bytes:
        return json.dumps(self.to_dict(), indent=2, sort_keys=True).encode()

    @classmethod
    def from_json(cls, data: bytes) -> Self:
        return cls.from_dict(json.loads(data))

    def to_dict(self) -> dict[str, Any]:
        return _serialize(self, type(self))  # type: ignore[no-any-return]

    @classmethod
    def from_dict(cls, data: Any) -> Self:
        return deserialize(cls, cls, data)  # type: ignore[no-any-return]

    def __hash__(self) -> int:
        return hash(
            tuple(
                tuple(getattr(self, x))
                for x in dir(self)
                if not x.startswith("_") and not callable(getattr(self, x))
            )
        )


class UnserializableNode(Node):
    """
    Base for Node subclasses that are purely in-memory intermediates and must
    never cross the gen->disk boundary. Encoding one is a bug: the gen-time
    visitor was supposed to replace it before serialization.
    """

    _dont_serialise = True

    def cbor(self, encoder):
        raise NotImplementedError(
            f"{type(self).__name__} must be rewritten before serialization"
        )

    def to_json(self) -> bytes:
        raise NotImplementedError(
            f"{type(self).__name__} must be rewritten before serialization"
        )


TAG_MAP: dict[Any, int] = {}
REV_TAG_MAP: dict[int, Any] = {}

# Types registered with @debug instead of @register. These nodes appear in
# the IR while their schema is still in flux and must not be treated as stable
# output. They carry a CBOR tag so they round-trip correctly, but callers
# should not rely on them remaining in published bundles.
DEBUG_TYPES: set[Any] = set()
DEBUG_TAG_SET: set[int] = set()


def indent(text: str, marker: str = "   |") -> str:
    """
    Return the given text indented with 3 space plus a pipe for display.
    """
    lines = text.split("\n")
    return "\n".join(marker + l for l in lines)


def _invalidate(obj: Any, depth: int = 0) -> str | None:
    """
    Recursively validate type anotated classes.
    """

    annotations = get_type_hints(type(obj))  # type: ignore[arg-type]
    for k, v in annotations.items():
        # FIX: AttributeError: 'Text' object has no attribute 'position'
        item = getattr(obj, k)
        res = not_type_check(item, v)
        if res:
            return f"{k} field of  {type(obj)} : {res}"

        if isinstance(item, (list, tuple)):
            for ii, i in enumerate(item):
                sub = _invalidate(i, depth + 1)
                if sub is not None:
                    return f"{k}.{ii}." + sub
        if isinstance(item, dict):
            for ii, i in item.items():
                sub = _invalidate(i, depth + 1)
                if sub is not None:
                    return f"{k}.{ii}." + sub
        else:
            sub = _invalidate(item, depth + 1)
            if sub is not None:
                return f"{k}.{sub}." + sub

    return None


class WrongTypeAtField(ValueError):
    pass


def validate(obj: Any) -> None:
    res = _invalidate(obj)
    if res:
        raise WrongTypeAtField(f"Wrong type at field :: {res}")


def not_type_check(item: Any, annotation: Any) -> str | None:
    if isinstance(annotation, types.UnionType):
        if any(not_type_check(item, arg) is None for arg in annotation.__args__):
            return None
        return f"expecting one of {annotation!r}, got {item!r}"
    if not hasattr(annotation, "__origin__"):
        if isinstance(item, annotation):
            return None
        else:
            return f"expecting {annotation} got {type(item)} : {item!r}"
    elif annotation.__origin__ is dict:
        if not isinstance(item, dict):
            return f"got  {type(item)}, Yexpecting list"
        inner_type = annotation.__args__[0]
        a = [not_type_check(i, inner_type) for i in item]
        ax = [x for x in a if x is not None]
        inner_type = annotation.__args__[1]
        b = [not_type_check(i, inner_type) for i in item.values()]
        bx = [x for x in b if x is not None]
        if ax:
            return ":invalid key type {ax[0]}"
        if bx:
            return bx[0]
        return None
    elif annotation.__origin__ in (list, tuple):
        # technically incorrect
        if not isinstance(item, (list, tuple)):
            return f"got  {type(item)}, Yexpecting list"
        # tuple[T, ...] has __args__ == (T, Ellipsis); treat it like list[T].
        inner_type = annotation.__args__[0]

        b = [not_type_check(i, inner_type) for i in item]

        bp = [x for x in b if x is not None]
        if bp:
            return bp[0]
        else:
            return None
    elif annotation.__origin__ is typing.Union:
        if any([not_type_check(item, arg) is None for arg in annotation.__args__]):
            return None
        return f"expecting one of {annotation!r}, got {item!r}"
    raise ValueError(item, annotation)


def register(value: int) -> Callable[[type], type]:
    assert value not in REV_TAG_MAP, REV_TAG_MAP[value]

    def _inner(type_: type) -> type:
        assert type_ not in TAG_MAP
        TAG_MAP[type_] = value
        REV_TAG_MAP[value] = type_

        return type_

    return _inner


def debug(value: int) -> Callable[[type], type]:
    """Like @register but marks the node type as debug/in-flux.

    Debug nodes appear in the IR while their schema is still being worked out.
    They carry a CBOR tag so they round-trip correctly, but they are not
    considered stable output and should be visually distinguished from
    production nodes in tooling and the viewer.
    """
    assert value not in REV_TAG_MAP, REV_TAG_MAP[value]

    def _inner(type_: type) -> type:
        assert type_ not in TAG_MAP
        TAG_MAP[type_] = value
        REV_TAG_MAP[value] = type_
        DEBUG_TYPES.add(type_)
        DEBUG_TAG_SET.add(value)
        return type_

    return _inner
