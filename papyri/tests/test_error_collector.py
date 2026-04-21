import logging

import pytest

from papyri.errors import UnseenError
from papyri.gen import Config, ErrorCollector

log = logging.getLogger(__name__)


def JustPasses():
    pass


def DoesValueError():
    raise ValueError("A")


def ShouldValueErrorTypeError():
    raise TypeError("B")


def test_capture_correct():
    c = Config(
        expected_errors={"ValueError": ["TestIterm"]},
        early_error=False,
        fail_unseen_error=True,
    )
    ec = ErrorCollector(c, log)

    with ec("TestItem"):
        DoesValueError()

    assert ec._unexpected_errors == {"ValueError": ["TestItem"]}


def test_pass_no_collect():
    c = Config(
        expected_errors={},
        early_error=True,
        fail_unseen_error=True,
    )
    ec = ErrorCollector(c, log)

    with ec("TestItem"):
        JustPasses()


def test_2():
    c = Config(
        expected_errors={"ValueError": ["TestItem"]},
        early_error=True,
        fail_unseen_error=True,
    )
    ec = ErrorCollector(c, log)
    with pytest.raises(UnseenError):
        with ec("TestItem"):
            JustPasses()


def test_4():
    c = Config(
        expected_errors={"ValueError": ["TestItem"]},
        early_error=False,
        fail_unseen_error=True,
    )
    ec = ErrorCollector(c, log)

    with ec("TestItem"):
        ShouldValueErrorTypeError()
