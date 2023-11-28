"""
Attempt to render using the rich protocol. 
"""

from dataclasses import dataclass
from rich.segment import Segment
from typing import Any
from rich.console import Console, ConsoleOptions, RenderResult, Group
from rich.style import Style
from rich.panel import Panel
from rich.padding import Padding
from rich import print
import json


def part(value, needle):
    a, b, c = value.partition(needle)
    yield a
    yield b
    if needle in c:
        yield from part(c, needle)
    else:
        yield c


@dataclass
class RToken:
    value: str
    style: str = None

    def __init__(self, value, style=None):
        if value.strip():
            value = value.replace("\n", " ").replace("  ", " ")
        self.value = value
        self.style = style

    def __len__(self):
        return len(self.value)

    def __rich_console__(
        self, console: Console, options: ConsoleOptions
    ) -> RenderResult:
        if self.style:
            yield Segment(self.value, console.get_style(self.style))
        else:
            yield Segment(self.value)

    def partition(self, needle=" "):
        return [RToken(c, self.style) for c in part(self.value, needle)]


@dataclass
class Unimp(RToken):
    style: str = "unimp"


@dataclass
class RTokenList:
    children: tuple[Any]

    def __add__(self, other):
        assert type(self) == type(other)

        return RTokenList(self.children + other.children)

    def __init__(self, children):
        acc = []
        for c in children:
            assert isinstance(c, (RToken, Unimp)), c
        self.children = children

    @classmethod
    def from_str(cls, value):
        return RTokenList([RToken(x) for x in part(value, " ")])

    def __rich_console__(
        self, console: Console, options: ConsoleOptions
    ) -> RenderResult:
        acc = 0
        options.max_width
        # TODO:, on newline eat whitespace
        for s in self.children:
            acc += len(s)
            assert isinstance(s, RToken)
            if acc >= options.max_width:
                if not s.value == " ":
                    acc = len(s)
                    yield Segment.line()
                    yield s
                    # yield str(acc)
                else:
                    acc = 0
                    yield Segment.line()
            else:
                yield s
                # yield Segment(str(acc) + "|")


DEBUG = False
@dataclass
class RichBlocks:
    children: list[Any]
    name: str

    def __rich_console__(
        self, console: Console, options: ConsoleOptions
    ) -> RenderResult:
        for item in self.children:
            if DEBUG:
                yield Panel(item, title=self.name)
            else:
                yield item
            # yield RToken("\n")


class RichVisitor:
    def visit(self, node):
        res = self.generic_visit([node])
        assert len(res) in (1, 0)
        if res:
            return res[0]
        else:
            return []

    def generic_visit(self, nodes):
        acc = []

        for node in nodes:
            name = node.__class__.__name__
            meth = getattr(self, f"visit_{name}")
            acc.extend(meth(node))

        return acc

    def visit_MRoot(self, node):
        cs = self.generic_visit(node.children)
        return [RichBlocks(cs, "root")]

    def visit_MParagraph(self, node):
        cs = self.generic_visit(node.children)
        return [RTokenList(cs) + RTokenList.from_str("\n\n")]

    def visit_MText(self, node):
        res = [RToken(v) for v in part(node.value, " ")]
        assert res[-1].value != "\n"
        return res

    def visit_MEmphasis(self, node):
        return self.generic_visit(node.children)

    def visit_MInlineCode(self, node):
        return RToken(node.value, "m.inline_code").partition()

    def visit_MList(self, node):
        return [
            Padding(
                RichBlocks(self.generic_visit(node.children), "mlist"), (0, 0, 0, 2)
            )
        ]

    def visit_DefList(self, node):
        return [
            Padding(
                RichBlocks(self.generic_visit(node.children), "deflist"), (0, 0, 0, 2)
            )
        ]

    def visit_MListItem(self, node):
        res = self.generic_visit(node.children)
        assert len(res) == 1
        return [RTokenList([RToken("- ")] + res[0].children)]

    def visit_Directive(self, node):
        if node.domain:
            assert node.role
        content = ""
        if node.domain:
            content += f":{node.domain}"
        if node.role:
            content += f":{node.role}:"
        content += f"`{node.value}`"

        return RToken(content, "m.directive").partition()

    def visit_MLink(self, node):
        return self.generic_visit(node.children)

    def visit_MAdmonitionTitle(self, node):
        return [Panel(Unimp(str(node.to_dict())))]
        return self.generic_visit(node.children)

    def visit_MAdmonition(self, node):
        title, *other = node.children
        assert title.type == "admonitionTitle"
        acc = self.generic_visit([title])
        if other:
            rd = self.generic_visit(other)
            assert len(rd) == 1

            acc.append(Panel(rd[0]))
        return acc

    def visit_MHeading(self, node):
        cs = self.generic_visit(node.children)
        return [RTokenList(cs) + RTokenList.from_str("\n\n")]

    def visit_Param(self, node):
        cs = [
            RToken(node.param, "param"),
            RToken(" : "),
            RToken(node.type_, "param_type"),
            RToken("\n"),
        ]
        sub = self.generic_visit(node.desc)
        return [RTokenList(cs), Padding(Group(*sub), (0, 0, 0, 2))]

    def visit_MMath(self, node):
        return self.visit_unknown(node)

    def visit_FieldList(self, node):
        return self.visit_unknown(node)

    def visit_DefListItem(self, node):
        return self.generic_visit([node.dt]) + [
            Padding(Group(*self.generic_visit(node.dd)), (0, 0, 0, 2))
        ]

    def visit_MCode(self, node):
        return self.visit_unknown(node)

    def visit_MBlockquote(self, node):
        sub = self.generic_visit(node.children)
        return [Padding(Group(*sub), (0, 0, 0, 2))]

    def visit_unknown(self, node):
        return [Unimp(json.dumps(node.to_dict(), indent=2))]

    def visit_Parameters(self, node):
        return self.generic_visit(node.children)


if __name__ == "__main__":
    print(
        Padding(
            Panel(
                RTokenList.from_str(
                    "Here is a long sentence to see if we can wrap " * 10
                )
            ),
            (0, 0, 0, 2),
        )
    )
