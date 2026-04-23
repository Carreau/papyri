"""
Direct tests for ``papyri.gen.normalise_ref``.

Currently the normalisation is only exercised indirectly via
``papyri ingest --check``; since the function is pure (it only depends on the
string and the Python import system) it is cheap to pin its behaviour.

``PLAN.md`` lists moving this check to gen as a future hardening step; these
tests make the move safer by documenting the current invariants.
"""

from papyri.gen import normalise_ref


def test_builtins_are_passthrough():
    # ``builtins.`` names must not be rewritten: the runtime module for
    # builtins is not a normal importable module from user code.
    assert normalise_ref("builtins.len") == "builtins.len"
    assert normalise_ref("builtins.dict") == "builtins.dict"


def test_main_is_passthrough():
    assert normalise_ref("__main__.foo") == "__main__.foo"


def test_unimportable_passthrough():
    # Non-existent modules are left as-is (no crash, no fabricated resolution).
    assert normalise_ref("no_such_pkg_xyz.foo.bar") == "no_such_pkg_xyz.foo.bar"


def test_ref_with_no_dot_passthrough():
    # rsplit('.', 1) fails on bare names; ensure we don't crash.
    assert normalise_ref("unqualified") == "unqualified"


def test_module_object_returns_original_ref():
    # ``json.decoder`` is a submodule of ``json``; for modules normalise_ref
    # must return the original ref (can't .__module__ + .__name__ meaningfully).
    assert normalise_ref("json.decoder") == "json.decoder"


def test_resolved_function_returns_canonical_path():
    # json.loads is a real callable whose __module__/__name__ resolve; the
    # returned string must be the canonical module-qualified form.
    out = normalise_ref("json.loads")
    assert out.endswith(".loads")
    assert "json" in out
