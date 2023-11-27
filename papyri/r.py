"""
Attempt to render using the rich protocol. 
"""

from dataclasses import dataclass
from rich.segment import Segment
from typing import Any
from rich.console import Console, ConsoleOptions, RenderResult
from rich.style import Style
from rich.panel import Panel
from rich.padding import Padding

from rich import print


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

    def __len__(self):
        return len(self.value)

    def __rich_console__(
        self, console: Console, options: ConsoleOptions
    ) -> RenderResult:
        if self.style:
            yield Segment(self.value, console.get_style(self.style))
        else:
            yield Segment(self.value)


@dataclass
class Unimp:
    value: str

    def __len__(self):
        return len(self.value)

    def __rich_console__(
        self, console: Console, options: ConsoleOptions
    ) -> RenderResult:
        yield Segment(self.value, console.get_style("unimp"))


@dataclass
class RTokenList:
    children: tuple[Any]

    def __init__(self, children):
        acc = []
        for c in children:
            assert isinstance(c, (RToken, Unimp))
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
            if acc >= options.max_width:
                acc = len(s)
                yield Segment.line()
            yield s


@dataclass
class RichBlocks:
    children: list[Any]

    def __rich_console__(
        self, console: Console, options: ConsoleOptions
    ) -> RenderResult:
        for item in self.children:
            yield item
            yield "\n"


class RichVisitor:
    def visit(self, node):
        res = self.generic_visit([node])
        assert len(res) in (1, 0)
        if res:
            return res
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
        return [RichBlocks(cs)]

    def visit_MParagraph(self, node):
        cs = self.generic_visit(node.children)
        return [RTokenList(cs)]

    def visit_MText(self, node):
        return [RToken(v) for v in part(node.value, " ")]

    def visit_MEmphasis(self, node):
        return self.generic_visit(node.children)

    # TODO...

    def visit_MInlineCode(self, node):
        return [RToken(node.value, "m.inline_code")]

    def visit_MList(self, node):
        return [Panel(RTokenList([
            RichBlocks(self.visit(c)) for c in node.children

            ]))]

    def visit_Directive(self, node):
        return [RToken(f":{node.domain}:{node.role}:`{node.value}`", "m.directive")]

    def visit_MLink(self, node):
        return [Unimp(str(node.to_dict()))]

    def visit_MAdmonition(self, node):
        return []

    def visit_Parameters(self, node):
        return []


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
