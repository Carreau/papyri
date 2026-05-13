"""
Build a tiny synthetic .papyri bundle for the Rust prototype.

Layout follows ingest/src/encoder.ts FIELD_ORDER. Each tagged node is a CBOR
tag (uint) wrapping a positional array of fields in declaration order.

Run: python make_fixture.py demo.papyri
"""

from __future__ import annotations

import gzip
import sys
from pathlib import Path

import cbor2
from cbor2 import CBORTag


# Tag helpers -----------------------------------------------------------------

def text(value: str) -> CBORTag:
    return CBORTag(4046, [value])


def paragraph(*children) -> CBORTag:
    return CBORTag(4045, [list(children)])


def heading(depth: int, *children) -> CBORTag:
    return CBORTag(4020, [depth, list(children)])


def section(title: str | None, level: int, *children, target: str | None = None) -> CBORTag:
    return CBORTag(4015, [list(children), title, level, target])


def inline_code(value: str) -> CBORTag:
    return CBORTag(4051, [value])


def code(value: str, status: str = "ok") -> CBORTag:
    return CBORTag(4050, [value, status])


def emphasis(*c) -> CBORTag:
    return CBORTag(4047, [list(c)])


def strong(*c) -> CBORTag:
    return CBORTag(4048, [list(c)])


def link(url: str, title: str | None, *c) -> CBORTag:
    return CBORTag(4049, [list(c), url, title])


def bullet_list(spread: bool, *items, ordered: bool = False, start: int = 1) -> CBORTag:
    return CBORTag(4053, [ordered, start, spread, list(items)])


def list_item(spread: bool, *c) -> CBORTag:
    return CBORTag(4054, [spread, list(c)])


def signature(kind: str, parameters, return_annotation: str | None, target_name: str) -> CBORTag:
    return CBORTag(4029, [kind, parameters, return_annotation, target_name])


def sig_param(name: str, annotation: str | None, kind: str, default: str | None) -> CBORTag:
    return CBORTag(4030, [name, annotation, kind, default])


def toc_tree(children, title: str, ref: str | None, *, open: bool = True, current: bool = False) -> CBORTag:
    return CBORTag(4021, [children, title, ref, open, current])


def generated_doc(
    content: dict,
    *,
    ordered_sections: list[str] | None = None,
    item_file: str | None = None,
    item_line: int | None = None,
    item_type: str | None = None,
    signature_node=None,
) -> CBORTag:
    # GeneratedDoc (4011) positional fields:
    # _content, example_section_data, _ordered_sections, item_file, item_line,
    # item_type, aliases, see_also, signature, references, arbitrary, local_refs
    return CBORTag(4011, [
        content,
        [],
        ordered_sections or list(content.keys()),
        item_file,
        item_line,
        item_type,
        [],
        [],
        signature_node,
        {},
        [],
        {},
    ])


# Bundle ----------------------------------------------------------------------

def build_bundle() -> CBORTag:
    foo_doc = generated_doc(
        {
            "Summary": section(
                None, 0,
                paragraph(text("Compute the foo of "), inline_code("x"), text(".")),
            ),
            "Extended Summary": section(
                None, 0,
                paragraph(
                    text("This is a "), strong(text("synthetic")), text(" symbol used to demonstrate the "),
                    emphasis(text("Rust prototype")), text(" rendering pipeline. "),
                    text("See also "), link("https://example.org/foo", None, text("the foo paper")), text("."),
                ),
                paragraph(
                    text("Bullet points work too:"),
                ),
                bullet_list(
                    False,
                    list_item(False, paragraph(text("one"))),
                    list_item(False, paragraph(text("two"))),
                    list_item(False, paragraph(text("three"))),
                ),
            ),
            "Examples": section(
                None, 0,
                code(">>> foo(3)\n9", "ok"),
            ),
        },
        item_file="demo/__init__.py",
        item_line=12,
        item_type="function",
        signature_node=signature(
            "function",
            [
                sig_param("x", "int", "POSITIONAL_OR_KEYWORD", None),
                sig_param("scale", "float", "KEYWORD_ONLY", "1.0"),
            ],
            "int",
            "foo",
        ),
    )

    bar_doc = generated_doc(
        {
            "Summary": section(
                None, 0,
                paragraph(text("A second symbol so the index has more than one row.")),
            ),
        },
        item_type="function",
        signature_node=signature("function", [], None, "bar"),
    )

    narrative_index = generated_doc(
        {
            "Body": section(
                "Welcome", 1,
                paragraph(text("This is a narrative page rendered by the Rust prototype.")),
                heading(2, text("Why")),
                paragraph(
                    text("Server-rendered HTML, no SPA, no hydration. "),
                    text("The IR is decoded directly from CBOR and walked into "),
                    inline_code("maud"), text(" templates."),
                ),
            ),
        },
        item_type="narrative",
    )

    toc = [
        toc_tree([], "demo.foo", "demo:foo"),
        toc_tree([], "demo.bar", "demo:bar"),
    ]

    # Bundle (4070): pack_format_version, ir_schema_version, module, version,
    # summary, github_slug, tag, logo, aliases, extra, api, narrative,
    # examples, assets, toc
    return CBORTag(4070, [
        1,
        1,
        "demo",
        "0.0.1",
        "A synthetic bundle for the Rust prototype.",
        "example/demo",
        "v0.0.1",
        "",
        {},
        {},
        {"demo:foo": foo_doc, "demo:bar": bar_doc},
        {"index": narrative_index},
        {},
        {},
        toc,
    ])


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "demo.papyri")
    payload = cbor2.dumps(build_bundle(), canonical=True)
    out.write_bytes(gzip.compress(payload))
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
