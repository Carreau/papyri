import logging

import pytest

from papyri.config_loader import Config
from papyri.error_collector import ErrorCollector
from papyri.errors import UnseenError

log = logging.getLogger(__name__)


def JustPasses() -> None:
    pass


def DoesValueError() -> None:
    raise ValueError("A")


def ShouldValueErrorTypeError() -> None:
    raise TypeError("B")


def test_capture_correct() -> None:
    c = Config()
    c.expected_errors = {"ValueError": ["TestIterm"]}
    c.early_error = False
    c.fail_unseen_error = True
    ec = ErrorCollector(c, log)

    with ec("TestItem"):
        DoesValueError()

    assert ec._unexpected_errors == {"ValueError": ["TestItem"]}


def test_pass_no_collect() -> None:
    c = Config()
    c.expected_errors = {}
    c.early_error = True
    c.fail_unseen_error = True
    ec = ErrorCollector(c, log)

    with ec("TestItem"):
        JustPasses()


def test_2() -> None:
    c = Config()
    c.expected_errors = {"ValueError": ["TestItem"]}
    c.early_error = True
    c.fail_unseen_error = True
    ec = ErrorCollector(c, log)
    with pytest.raises(UnseenError), ec("TestItem"):
        JustPasses()


def test_4() -> None:
    c = Config()
    c.expected_errors = {"ValueError": ["TestItem"]}
    c.early_error = False
    c.fail_unseen_error = True
    ec = ErrorCollector(c, log)

    with ec("TestItem"):
        ShouldValueErrorTypeError()
