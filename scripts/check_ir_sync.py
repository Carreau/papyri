#!/usr/bin/env python3.13
"""Verify the hand-maintained TypeScript IR mirrors against papyri's nodes.

Two TS files mirror the Python IR by hand and can drift silently — nothing
regenerates them, so they need an explicit check:

  ingest/src/encoder.ts   ``FIELD_ORDER`` — the *positional* CBOR decoder.
                          papyri encodes each node as ``CBORTag(tag, [field
                          values in serde field order])`` (see ``Node.cbor`` in
                          ``papyri/node_base.py``), so a field missing or
                          mis-ordered here misreads the packed ``.papyri``
                          artifact. A trailing miss silently drops a field; a
                          middle miss shifts every field after it.
  viewer/src/lib/ir-types.ts  ``IR_TYPE_NAMES`` — every IR node name in
                          CBOR-tag order (drives slug<->type and the node
                          browser).

``scripts/gen_ir_schema.py`` already keeps the *generated* ``ir-schema.ts`` in
sync; this covers the two files edited by hand. Exits non-zero, naming the
drift, when either diverges from ``papyri/nodes.py``.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# Import every module that registers IR Node tags so TAG_MAP is complete:
# IngestedDoc (4010) lives in crosslink, GeneratedDoc (4011) in doc, Bundle
# (4070) in bundle; the content nodes are in nodes. Held in a tuple so the
# side-effect imports read as used.
import papyri.bundle
import papyri.crosslink
import papyri.doc
import papyri.nodes
from papyri.node_base import TAG_MAP, Node

# Authoritative field order: matches what Node.cbor encodes (strips ClassVar,
# unlike typing.get_type_hints), the same helper gen_ir_schema.py uses.
from papyri.serde import get_type_hints

_REGISTERED = (papyri.nodes, papyri.crosslink, papyri.doc, papyri.bundle)

ROOT = Path(__file__).resolve().parent.parent
ENCODER_TS = ROOT / "ingest" / "src" / "encoder.ts"
IR_TYPES_TS = ROOT / "viewer" / "src" / "lib" / "ir-types.ts"

# ir-types.ts deliberately lists only browseable IR node types; the Bundle
# artifact wrapper (tag 4070) is the container, not a content node, so it is
# excluded there (but it IS in encoder.ts, which must decode it).
IR_TYPES_EXCLUDE = {"Bundle"}


def py_nodes() -> dict[int, tuple[str, list[str]]]:
    """Map ``tag -> (name, [field names in serde/CBOR order])`` for every Node."""
    out: dict[int, tuple[str, list[str]]] = {}
    for cls, tag in TAG_MAP.items():
        if isinstance(cls, type) and issubclass(cls, Node):
            out[tag] = (cls.__name__, list(get_type_hints(cls).keys()))  # type: ignore[arg-type]
    return out


def parse_field_order(text: str) -> dict[int, tuple[str, list[str]]]:
    """Extract ``FIELD_ORDER`` entries (``tag: { name, fields }``) from encoder.ts."""
    out: dict[int, tuple[str, list[str]]] = {}
    for m in re.finditer(
        r"(\d{4}):\s*\{\s*name:\s*\"([^\"]+)\",\s*fields:\s*\[([^\]]*)\]",
        text,
    ):
        out[int(m.group(1))] = (m.group(2), re.findall(r'"([^"]+)"', m.group(3)))
    return out


def parse_type_names(text: str) -> list[str]:
    """Extract the ``IR_TYPE_NAMES`` string array from ir-types.ts."""
    m = re.search(
        r"IR_TYPE_NAMES:\s*readonly string\[\]\s*=\s*\[(.*?)\]\s*as const",
        text,
        re.S,
    )
    if m is None:
        raise SystemExit("could not find IR_TYPE_NAMES in ir-types.ts")
    return re.findall(r'"([^"]+)"', m.group(1))


def check_encoder(py: dict[int, tuple[str, list[str]]]) -> list[str]:
    """encoder.ts FIELD_ORDER: positional decoder, must match name + field order."""
    enc = parse_field_order(ENCODER_TS.read_text())
    errors: list[str] = []
    missing = sorted(set(py) - set(enc))
    extra = sorted(set(enc) - set(py))
    if missing:
        listed = ", ".join(f"{t} ({py[t][0]})" for t in missing)
        errors.append(f"encoder.ts FIELD_ORDER is missing tags: {listed}")
    if extra:
        errors.append(f"encoder.ts FIELD_ORDER has tags unknown to papyri: {extra}")
    errors.extend(
        f"encoder.ts FIELD_ORDER tag {t} is out of sync:\n"
        f"      nodes.py: {py[t][0]} {py[t][1]}\n"
        f"      encoder : {enc[t][0]} {enc[t][1]}"
        for t in sorted(set(py) & set(enc))
        if py[t] != enc[t]
    )
    return errors


def check_type_names(py: dict[int, tuple[str, list[str]]]) -> list[str]:
    """ir-types.ts IR_TYPE_NAMES: every node name, in ascending CBOR-tag order."""
    expected = [
        name for _, (name, _) in sorted(py.items()) if name not in IR_TYPES_EXCLUDE
    ]
    actual = parse_type_names(IR_TYPES_TS.read_text())
    if actual == expected:
        return []
    missing_n = sorted(set(expected) - set(actual))
    extra_n = sorted(set(actual) - set(expected))
    detail = (
        f"\n      missing: {missing_n}  extra: {extra_n}"
        if (missing_n or extra_n)
        else "\n      same names, wrong order (must be ascending CBOR tag)"
    )
    return [
        "ir-types.ts IR_TYPE_NAMES is out of sync:\n"
        f"      expected: {expected}\n"
        f"      actual  : {actual}{detail}"
    ]


def main() -> None:
    py = py_nodes()
    errors = check_encoder(py) + check_type_names(py)

    if errors:
        print("IR sync check FAILED:\n", file=sys.stderr)
        for e in errors:
            print(f"  - {e}\n", file=sys.stderr)
        print(
            "Hand-edit the file(s) above to match papyri/nodes.py "
            "(these mirrors are not auto-generated).",
            file=sys.stderr,
        )
        sys.exit(1)

    print(
        f"IR sync OK: encoder.ts FIELD_ORDER and ir-types.ts IR_TYPE_NAMES "
        f"match papyri/nodes.py ({len(py)} tagged nodes)"
    )


if __name__ == "__main__":
    main()
