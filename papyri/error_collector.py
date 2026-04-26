"""Error bookkeeping for ``papyri gen``.

``ErrorCollector`` is a context manager that wraps each per-qualname
generation step. It distinguishes two buckets of failures:

- **expected** — listed under ``[global.expected_errors]`` in the
  package's gen TOML; these don't fail the build.
- **unexpected** — anything else; logged with a traceback and
  re-raised when ``early_error`` is set.

A third state, ``fail_unseen_error``, raises ``UnseenError`` when an
expected error never actually fired (so the allow-list stays trimmed).
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from .errors import UnseenError

if TYPE_CHECKING:
    from .config_loader import Config


class ErrorCollector:
    _expected_unseen: dict[str, Any]
    errored: bool
    _unexpected_errors: dict[str, Any]
    _expected_errors: dict[str, Any]

    def __init__(self, config: Config, log):
        self.config: Config = config
        self.log = log

        self._expected_unseen = {}
        for err, names in self.config.expected_errors.items():
            for name in names:
                self._expected_unseen.setdefault(name, []).append(err)
        self._unexpected_errors = {}
        self._expected_errors = {}

    def __call__(self, qa):
        self._qa = qa
        return self

    def __enter__(self):
        self.errored = False
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type in (BaseException, KeyboardInterrupt):
            return
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
