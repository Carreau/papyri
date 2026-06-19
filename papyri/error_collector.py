"""Error bookkeeping for ``papyri gen``.

``ErrorCollector`` is a context manager that wraps each per-qualname
generation step. It distinguishes two buckets of failures:

- **expected** — listed under ``[global.expected_errors]`` in the
  package's gen TOML; these don't fail the build.
- **unexpected** — anything else; logged with a traceback and
  re-raised when ``early_error`` is set.

A third state, ``fail_unseen_error``, raises ``UnseenError`` when an
expected error never actually fired (so the allow-list stays trimmed).

Gen-time *diagnostics* live here too (``Severity``, the ``DIAGNOSTICS``
code registry, ``DiagnosticConfig`` resolver, and the ``Diagnostics``
collector). Unlike ``ErrorCollector`` — which deals with *exceptions* that
abort a per-object step — diagnostics are non-fatal observations (an
unresolved cross-reference, a malformed docstring section, a broken
doctest) emitted from deep inside gen/tree without unwinding. Every
diagnostic has a stable *code* and a *default severity*; the project's
``papyri.toml`` can override severities globally and per fully-qualified
target glob (mirroring ruff/mypy). ``papyri gen`` exits non-zero when any
diagnostic resolves to ``error``.
"""

from __future__ import annotations

import enum
import fnmatch
import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .errors import UnseenError

if TYPE_CHECKING:
    from .config_loader import Config


class Severity(enum.IntEnum):
    """Diagnostic severities, ordered from least to most severe.

    ``IGNORE`` suppresses the diagnostic entirely (no log line, not recorded
    into the manifest, never gates the build). The ordering lets callers
    compare severities (``sev >= Severity.WARNING``).
    """

    IGNORE = 0
    INFO = 1
    WARNING = 2
    ERROR = 3

    @classmethod
    def parse(cls, value: str) -> Severity:
        """Parse a case-insensitive severity name from config."""
        key = value.strip().upper()
        try:
            return cls[key]
        except KeyError:
            valid = ", ".join(s.name.lower() for s in cls)
            raise ValueError(
                f"unknown diagnostic severity {value!r}; expected one of {valid}"
            ) from None

    @property
    def log_level(self) -> int:
        return {
            Severity.INFO: logging.INFO,
            Severity.WARNING: logging.WARNING,
            Severity.ERROR: logging.ERROR,
        }.get(self, logging.DEBUG)


@dataclass(frozen=True)
class DiagnosticSpec:
    """A stable diagnostic code, its default severity, and a description.

    ``infer_only`` marks diagnostics that can only fire when type inference
    is enabled (``papyri gen`` without ``--no-infer``); documented so the
    default-severity table is honest about which codes are unreachable under
    ``--no-infer``.
    """

    code: str
    default_severity: Severity
    description: str
    infer_only: bool = False


DIAGNOSTICS: dict[str, DiagnosticSpec] = {}


def _register(
    code: str,
    default: Severity,
    description: str,
    *,
    infer_only: bool = False,
) -> str:
    assert code not in DIAGNOSTICS, code
    assert code.startswith("W-"), code
    DIAGNOSTICS[code] = DiagnosticSpec(code, default, description, infer_only)
    return code


# --- Diagnostic code registry ------------------------------------------------
# Defaults follow the ruff/mypy strictness model: a malformed docstring is a
# bug the maintainer wants surfaced (``error``), while diagnostics that gen can
# recover from cleanly (a module-docstring sentinel, a dropped substitution)
# stay at ``warning``. Promote/relax any of these from ``papyri.toml``.

W_UNRESOLVED_REF = _register(
    "W-unresolved-ref",
    Severity.WARNING,
    "A cross-reference could not be resolved to a local or cross-bundle "
    "target. Common across packages whose targets are not yet built, so it "
    "defaults to a warning; promote to error for a strictly clean bundle.",
)
W_UNSUPPORTED_SUBSTITUTION = _register(
    "W-unsupported-substitution",
    Severity.WARNING,
    "An RST substitution uses a directive papyri cannot represent in the IR; "
    "the substitution is dropped.",
)
W_DOCTEST_SYNTAX = _register(
    "W-doctest-syntax",
    Severity.ERROR,
    "An example/doctest block could not be parsed into tokens.",
)
W_DOCTEST_EXEC = _register(
    "W-doctest-exec",
    Severity.WARNING,
    "Executing an example block raised (only recorded when exec_failure is "
    "set to 'fallback'; otherwise gen aborts the object).",
)
W_NUMPYDOC_PARSE = _register(
    "W-numpydoc-parse",
    Severity.ERROR,
    "numpydoc could not parse an object's docstring; the object is dropped.",
)
W_MODULE_DOCSTRING = _register(
    "W-module-docstring",
    Severity.WARNING,
    "numpydoc could not parse a module docstring; gen injects a visible "
    "'could not be parsed' sentinel instead of dropping the page.",
)


def _validate_code(code: str) -> None:
    if code not in DIAGNOSTICS:
        valid = ", ".join(sorted(DIAGNOSTICS))
        raise ValueError(f"unknown diagnostic code {code!r}; known codes: {valid}")


class DiagnosticConfig:
    """Resolves the effective severity for a (code, target) pair.

    Resolution order, most general to most specific:

    1. the code's registered default severity;
    2. a global override (``[tool.papyri.diagnostics]`` / ``[global.diagnostics]``);
    3. the first matching per-target glob override, in config order.

    Per-target globs match against the fully-qualified name of the object
    whose doc produced the diagnostic (``numpy.ma.MaskedArray.*``); narrative
    pages match on their doc path.
    """

    def __init__(
        self,
        global_overrides: Mapping[str, Severity] | None = None,
        per_target: list[tuple[str, dict[str, Severity]]] | None = None,
    ) -> None:
        self.global_overrides: dict[str, Severity] = dict(global_overrides or {})
        self.per_target: list[tuple[str, dict[str, Severity]]] = list(per_target or [])

    @classmethod
    def default(cls) -> DiagnosticConfig:
        """An empty config — every code resolves to its registered default."""
        return cls()

    @classmethod
    def from_raw(cls, raw: Mapping[str, Any] | None) -> DiagnosticConfig:
        """Build from the ``[global.diagnostics]`` TOML table.

        Scalar entries are global code overrides; the ``per-target`` (or
        ``per_target``) sub-table maps a glob to a ``{code: severity}`` table.
        Unknown codes and bad severities raise ``ValueError`` so a typo in the
        config fails the run loudly rather than silently doing nothing.
        """
        data = dict(raw or {})
        per_raw = data.pop("per-target", None)
        if per_raw is None:
            per_raw = data.pop("per_target", {})
        else:
            data.pop("per_target", None)

        global_overrides: dict[str, Severity] = {}
        for code, sev in data.items():
            _validate_code(code)
            global_overrides[code] = _parse_severity(code, sev)

        if not isinstance(per_raw, Mapping):
            raise ValueError(
                "[global.diagnostics] 'per-target' must be a table of "
                "glob -> {code: severity}"
            )
        per_target: list[tuple[str, dict[str, Severity]]] = []
        for glob, mapping in per_raw.items():
            if not isinstance(mapping, Mapping):
                raise ValueError(
                    f"[global.diagnostics] per-target {glob!r} must be a table "
                    "of {code: severity}"
                )
            overrides: dict[str, Severity] = {}
            for code, sev in mapping.items():
                _validate_code(code)
                overrides[code] = _parse_severity(code, sev)
            per_target.append((str(glob), overrides))
        return cls(global_overrides, per_target)

    def resolve(self, code: str, target: str | None) -> Severity:
        spec = DIAGNOSTICS.get(code)
        assert spec is not None, code
        severity = spec.default_severity
        if code in self.global_overrides:
            severity = self.global_overrides[code]
        if target is not None:
            for glob, overrides in self.per_target:
                if code in overrides and fnmatch.fnmatch(target, glob):
                    severity = overrides[code]
                    break
        return severity


def _parse_severity(code: str, value: Any) -> Severity:
    if not isinstance(value, str):
        raise ValueError(
            f"severity for {code!r} must be a string, got {type(value).__name__}"
        )
    return Severity.parse(value)


class Diagnostics:
    """Collects coded gen-time diagnostics and resolves their severities.

    ``emit`` is the single entry point: it resolves the severity for the
    current target, logs at the matching level (unless ``IGNORE``), and
    records the diagnostic for the manifest. ``has_errors`` drives the
    non-zero exit of ``papyri gen``.
    """

    def __init__(self, config: DiagnosticConfig, log: logging.Logger) -> None:
        self.config = config
        self.log = log
        self.records: list[dict[str, str]] = []
        self.counts: dict[Severity, int] = {s: 0 for s in Severity}

    def emit(self, code: str, target: str | None, message: str) -> Severity:
        severity = self.config.resolve(code, target)
        self.counts[severity] += 1
        if severity is Severity.IGNORE:
            return severity
        self.log.log(
            severity.log_level,
            "%s [%s] %s",
            target if target else "<bundle>",
            code,
            message,
        )
        self.records.append(
            {
                "code": code,
                "severity": severity.name.lower(),
                "target": target or "",
                "message": message,
            }
        )
        return severity

    @property
    def error_count(self) -> int:
        return self.counts[Severity.ERROR]

    @property
    def has_errors(self) -> bool:
        return self.error_count > 0

    def summary(self) -> dict[str, int]:
        """Counts per severity name, omitting zeroes (for logging)."""
        return {s.name.lower(): self.counts[s] for s in Severity if self.counts[s]}


class ErrorCollector:
    _expected_unseen: dict[str, Any]
    errored: bool
    _unexpected_errors: dict[str, Any]
    _expected_errors: dict[str, Any]

    def __init__(self, config: Config, log: logging.Logger) -> None:
        self.config: Config = config
        self.log = log

        self._expected_unseen = {}
        for err, names in self.config.expected_errors.items():
            for name in names:
                self._expected_unseen.setdefault(name, []).append(err)
        self._unexpected_errors = {}
        self._expected_errors = {}

    def __call__(self, qa: str) -> ErrorCollector:
        self._qa = qa
        return self

    def __enter__(self) -> ErrorCollector:
        self.errored = False
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: object,
    ) -> bool | None:
        if exc_type in (BaseException, KeyboardInterrupt):
            return None
        if exc_type:
            self.errored = True
            ename = exc_type.__name__
            if ename in self._expected_unseen.get(self._qa, []):
                self._expected_unseen[self._qa].remove(ename)
                if not self._expected_unseen[self._qa]:
                    del self._expected_unseen[self._qa]
                self._expected_errors.setdefault(ename, []).append(self._qa)
            else:
                self._unexpected_errors.setdefault(ename, []).append(self._qa)
                self.log.exception(f"Unexpected error {self._qa}")
            if not self.config.early_error:
                return True
        expecting = self._expected_unseen.get(self._qa, [])
        if expecting and self.config.fail_unseen_error:
            raise UnseenError(f"Expecting one of {expecting}")
        return None
