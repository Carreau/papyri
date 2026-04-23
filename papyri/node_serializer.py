"""
Internally-tagged Node -> dict serializer.

Unlike ``serde`` (which tags unions externally, i.e. wraps each value
in ``{"type": ..., "data": ...}``), this serializer folds the tag into the
value itself: every serialized Node dict carries a ``"type"`` key alongside
its regular fields. The tag is either the class's ``type`` class-attribute
(if set, e.g. ``"inlineCode"``) or the class name.

Used by ``Node.to_dict`` / ``Node.to_json``.
"""

import types
from typing import Union
from typing import get_type_hints as gth

base_types = {int, str, bool, type(None)}


def _is_union(annotation) -> bool:
    """Return True for both typing.Union[...] and X | Y (types.UnionType)."""
    return (
        isinstance(annotation, types.UnionType)
        or getattr(annotation, "__origin__", None) is Union
    )


def _union_args(annotation) -> tuple:
    return annotation.__args__  # type: ignore[no-any-return]


def serialize(instance, annotation):
    try:
        if annotation in base_types:
            # print("BASE", instance)
            assert isinstance(instance, annotation), f"{instance} {annotation}"
            return instance

        origin = getattr(annotation, "__origin__", None)
        if origin is list:
            assert isinstance(instance, origin), f"{instance} {origin}"
            inner_annotation = annotation.__args__
            # assert len(inner_annotation) == 1, inner_annotation
            return [serialize(x, inner_annotation[0]) for x in instance]
        if origin is dict:
            assert isinstance(instance, origin)
            _key_annotation, value_annotation = annotation.__args__
            # assert key_annotation == str, key_annotation
            return {k: serialize(v, value_annotation) for k, v in instance.items()}
        if _is_union(annotation):
            inner_annotation = _union_args(annotation)
            if len(inner_annotation) == 2 and inner_annotation[1] == type(None):
                # assert inner_annotation[0] is not None
                # here we are optional; we _likely_ can avoid doing the union trick and store just the type, or null
                if instance is None:
                    return None
                else:
                    return serialize(instance, inner_annotation[0])
            assert type(instance) in inner_annotation, (
                f"{type(instance)} not in {inner_annotation}, {instance} or type {type(instance)}"
            )
            ma = [x for x in inner_annotation if type(instance) is x]
            # assert len(ma) == 1
            ann_ = ma[0]
            serialized_data = serialize(instance, ann_)
            type_ = ann_.__name__
            if hasattr(ann_, "type"):
                type_ = ann_.type
            if isinstance(serialized_data, dict):
                return {**serialized_data, "type": type_}
            return {"data": serialized_data, "type": type_}
        if (
            (type(annotation) is type)
            and type.__module__ not in ("builtins", "typing")
            and (instance.__class__.__name__ == getattr(annotation, "__name__", None))
        ) or type(instance) == annotation:
            data = {}
            type_ = type(instance).__name__
            if hasattr(instance, "type"):
                type_ = instance.type
            data["type"] = type_
            for k, ann in gth(type(instance)).items():
                data[k] = serialize(getattr(instance, k), ann)
            return data
    except Exception as e:
        e.add_note(f"serializing {instance.__class__}")
        raise
