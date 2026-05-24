"""
Bug report: bullet list items whose body starts with '>' produce an ERROR node.

Affected:  py-tree-sitter-rst 0.2.2 / tree-sitter 0.25.2
Reproduce: pip install py-tree-sitter-rst tree-sitter
           python tree_sitter_rst_bug.py

In RST, '>' has no special meaning in inline text.  A bullet list item
such as

    - >0 : convergence not achieved

is valid RST and should parse as [bullet, body].  Instead, tree-sitter-rst
emits an ERROR node that consumes the leading '>' and leaves the remainder
as the body, so the actual parse is [bullet, ERROR, body].

'<' in the same position is parsed correctly (no ERROR).
"""

import tree_sitter
import tree_sitter_rst as tsr

parser = tree_sitter.Parser(tree_sitter.Language(tsr.language()))

import importlib.metadata
print(f"tree-sitter-rst: {importlib.metadata.version('py-tree-sitter-rst')}")


def child_types(src: bytes) -> list[str]:
    tree = parser.parse(src)
    # document -> bullet_list -> list_item
    list_item = tree.root_node.children[0].children[0]
    return [
        (c.type, src[c.start_byte : c.end_byte].decode())
        for c in list_item.children
    ]


cases = [
    # (input, expect_error)
    (b"- >0 : convergence not achieved", True),   # BUG: ERROR consumes '>'
    (b"- >=0 : non-negative",           True),   # BUG: ERROR consumes '>'
    (b"- > text",                        True),   # BUG: ERROR consumes '> '
    (b"- >> text",                       True),   # BUG: ERROR consumes '>> '
    (b"- <0 : illegal input",           False),  # OK:  '<' parses fine
    (b"- <=0 : non-positive",           False),  # OK
    (b"- 0 : successful exit",          False),  # OK
]

bugs = 0
for src, expect_error in cases:
    children = child_types(src)
    types = [t for t, _ in children]
    has_error = "ERROR" in types
    status = "BUG " if has_error else "OK  "
    if has_error:
        bugs += 1
    print(f"[{status}] {src.decode()!r}")
    for typ, text in children:
        print(f"       {typ:8s}  {text!r}")
    print()

if bugs:
    print(f"{bugs} case(s) produce unexpected ERROR nodes.")
    raise SystemExit(1)
else:
    print("All cases parsed correctly.")
