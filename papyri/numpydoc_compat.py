"""
vestigial things from velin.
"""

from collections.abc import Iterator
from typing import Any, ClassVar

import numpydoc.docscrape as nds


class NumpyDocString(nds.NumpyDocString):
    """
    subclass a littel bit more lenient on parsing
    """

    __slots__ = ("ordered_sections",)

    aliases: ClassVar[dict[str, tuple[str, ...]]] = {
        "Parameters": (
            "options",
            "parameter",
            "parameters",
            "paramters",
            "parmeters",
            "paramerters",
            "arguments",
        ),
        "Yields": ("signals",),
    }

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.ordered_sections: list[str] = []
        super().__init__(*args, **kwargs)

    def __setitem__(self, key: str, value: Any) -> None:
        if key in ["Extended Summary", "Summary"]:
            value = [d.rstrip() for d in value]

        super().__setitem__(key, value)
        assert key not in self.ordered_sections, (
            f"assert {key!r} not in {self.ordered_sections}, {super().__getitem__(key)}, {value}"
        )
        self.ordered_sections.append(key)

    def _guess_header(self, header: str) -> str:
        if header in self.sections:
            return header
        # handle missing trailing `s`, and trailing `:`
        for s in self.sections:
            if s.lower().startswith(header.rstrip(":").lower()):
                return str(s)
        for k, v in self.aliases.items():
            if header.lower() in v:
                return k
        raise ValueError("Could not find match for section:", header)

    def _read_sections(self) -> Iterator[tuple[str, Any]]:
        for name, data in super()._read_sections():
            name = self._guess_header(name)
            yield name, data

    def _parse_param_list(self, *args: Any, **kwargs: Any) -> list[Any]:
        """
        Normalize parameters
        """
        parms = super()._parse_param_list(*args, **kwargs)
        out = []
        for name, type_, desc in parms:
            out.append(
                nds.Parameter(name.strip(), type_.strip(), [d.rstrip() for d in desc])
            )
        return out
