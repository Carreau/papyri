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

    def __len__(self):
        return len(self.value)

    def __rich_console__(
        self, console: Console, options: ConsoleOptions
    ) -> RenderResult:
        if self.value == " ":
            yield Segment(self.value, Style(color="blue"))
        else:
            yield Segment(self.value, Style(color="red"))


@dataclass
class RTokenList:
    children: tuple[Any]

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


class RichVisitor:


    def visit(self, node):
        name = node.__class__.__name__

        meth =  getattr(self, f'visit_{name}')
        return meth(node)

    def generic_visit(self, nodes):
        print('siviting', nodes)
        return [self.visit(node) for node in nodes]







if __name__ == "__main__":
    print(
        Padding(
        Panel(
            RTokenList.from_str("Here is a long sentence to see if we can wrap " * 10)
        ), (0,0,0,2))
    )
