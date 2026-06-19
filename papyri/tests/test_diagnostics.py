"""Tests for the gen-time diagnostics machinery in ``error_collector``."""

from __future__ import annotations

import logging

import pytest

from papyri.error_collector import (
    DIAGNOSTICS,
    W_MODULE_DOCSTRING,
    W_UNRESOLVED_REF,
    DiagnosticConfig,
    Diagnostics,
    Severity,
)


def test_severity_is_ordered() -> None:
    assert Severity.IGNORE < Severity.INFO < Severity.WARNING < Severity.ERROR


def test_severity_parse_is_case_insensitive() -> None:
    assert Severity.parse("error") is Severity.ERROR
    assert Severity.parse(" Warning ") is Severity.WARNING
    with pytest.raises(ValueError, match="unknown diagnostic severity"):
        Severity.parse("loud")


def test_every_code_starts_with_w_prefix() -> None:
    # _register asserts this, but pin it as an explicit contract.
    assert all(code.startswith("W-") for code in DIAGNOSTICS)


def test_default_config_uses_registered_defaults() -> None:
    cfg = DiagnosticConfig.default()
    for code, spec in DIAGNOSTICS.items():
        assert cfg.resolve(code, "anything") is spec.default_severity


def test_global_override_applies_everywhere() -> None:
    cfg = DiagnosticConfig.from_raw({W_UNRESOLVED_REF: "error"})
    assert cfg.resolve(W_UNRESOLVED_REF, "numpy.foo") is Severity.ERROR
    # Other codes are untouched.
    assert (
        cfg.resolve(W_MODULE_DOCSTRING, "numpy")
        is DIAGNOSTICS[W_MODULE_DOCSTRING].default_severity
    )


def test_per_target_override_beats_global() -> None:
    cfg = DiagnosticConfig.from_raw(
        {
            W_UNRESOLVED_REF: "error",
            "per-target": {
                "numpy.ma.*": {W_UNRESOLVED_REF: "warning"},
            },
        }
    )
    assert cfg.resolve(W_UNRESOLVED_REF, "numpy.ma.MaskedArray") is Severity.WARNING
    # A target the glob doesn't match keeps the global override.
    assert cfg.resolve(W_UNRESOLVED_REF, "numpy.core.foo") is Severity.ERROR


def test_per_target_first_match_wins() -> None:
    cfg = DiagnosticConfig.from_raw(
        {
            "per-target": {
                "numpy.*": {W_UNRESOLVED_REF: "ignore"},
                "numpy.ma.*": {W_UNRESOLVED_REF: "error"},
            },
        }
    )
    # Both globs match, but the first one in config order wins.
    assert cfg.resolve(W_UNRESOLVED_REF, "numpy.ma.MaskedArray") is Severity.IGNORE


def test_per_target_underscore_alias() -> None:
    cfg = DiagnosticConfig.from_raw(
        {"per_target": {"x.*": {W_UNRESOLVED_REF: "ignore"}}}
    )
    assert cfg.resolve(W_UNRESOLVED_REF, "x.y") is Severity.IGNORE


def test_from_raw_rejects_unknown_code() -> None:
    with pytest.raises(ValueError, match="unknown diagnostic code"):
        DiagnosticConfig.from_raw({"W-not-a-real-code": "error"})


def test_from_raw_rejects_bad_severity() -> None:
    with pytest.raises(ValueError, match="unknown diagnostic severity"):
        DiagnosticConfig.from_raw({W_UNRESOLVED_REF: "nope"})


def test_from_raw_rejects_non_string_severity() -> None:
    with pytest.raises(ValueError, match="must be a string"):
        DiagnosticConfig.from_raw({W_UNRESOLVED_REF: 3})


def test_from_raw_rejects_non_table_per_target() -> None:
    with pytest.raises(ValueError, match="per-target"):
        DiagnosticConfig.from_raw({"per-target": "oops"})


def _collector(raw: dict[str, object] | None = None) -> Diagnostics:
    log = logging.getLogger("papyri.tests.diagnostics")
    return Diagnostics(DiagnosticConfig.from_raw(raw or {}), log)


def test_emit_records_and_counts() -> None:
    diags = _collector({W_UNRESOLVED_REF: "error"})
    sev = diags.emit(W_UNRESOLVED_REF, "numpy.foo", "could not resolve `bar`")
    assert sev is Severity.ERROR
    assert diags.has_errors
    assert diags.error_count == 1
    assert diags.records == [
        {
            "code": W_UNRESOLVED_REF,
            "severity": "error",
            "target": "numpy.foo",
            "message": "could not resolve `bar`",
        }
    ]


def test_emit_ignore_is_not_recorded() -> None:
    diags = _collector({W_UNRESOLVED_REF: "ignore"})
    sev = diags.emit(W_UNRESOLVED_REF, "numpy.foo", "dropped")
    assert sev is Severity.IGNORE
    assert diags.records == []
    assert not diags.has_errors
    # Ignored diagnostics are still counted (for an honest summary), just
    # never recorded into the manifest or gating the build.
    assert diags.counts[Severity.IGNORE] == 1


def test_summary_omits_zero_buckets() -> None:
    diags = _collector()
    diags.emit(W_UNRESOLVED_REF, "a", "x")  # default warning
    assert diags.summary() == {"warning": 1}


def test_genvisitor_emits_unresolved_ref_with_target() -> None:
    """An unresolvable role-ref routes through the collector tagged by qa.

    This pins the wiring: the diagnostic carries the visitor's ``qa`` as its
    target so per-target overrides can downgrade a single stubborn symbol.
    """
    from papyri.tree import GenVisitor
    from papyri.ts import parse

    diags = _collector({W_UNRESOLVED_REF: "error"})
    dv = GenVisitor(
        "mypkg:thing",
        frozenset(),
        local_refs=set(),
        aliases={},
        version="TestSuite",
        config={},
        diagnostics=diags,
    )
    # A :func: role to a name that resolves to nothing local, cross-bundle, or
    # importable — gen leaves it as an unresolved directive and emits the code.
    (section,) = parse(b":func:`definitely.not.a.real.object`", "mypkg:thing")
    dv.visit(section)

    assert diags.has_errors
    assert [r["code"] for r in diags.records] == [W_UNRESOLVED_REF]
    assert diags.records[0]["target"] == "mypkg:thing"
