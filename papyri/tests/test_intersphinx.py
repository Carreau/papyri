import pytest

from ..intersphinx import is_registered, load_registry, maybe_intersphinx
from ..nodes import RefInfo


def test_registry_loads_with_known_keys():
    reg = load_registry()
    # The vendored registry ships with numpy / python at minimum. Skip the
    # suite cleanly if the dep isn't installed so the test isn't a hard
    # requirement in dev environments without it.
    if not reg:
        pytest.skip("intersphinx_registry not available")
    assert "numpy" in reg
    assert "python" in reg


def test_is_registered_handles_empty_and_unknown():
    assert not is_registered(None)
    assert not is_registered("")
    assert not is_registered("definitely-not-a-real-project-name-xyz")


def test_maybe_intersphinx_passes_non_missing_through():
    for kind in ("module", "local", "to-resolve", "api", "intersphinx"):
        r = RefInfo("numpy", "2.0.0", kind, "numpy.linspace")
        assert maybe_intersphinx(r) is r


def test_maybe_intersphinx_tags_known_project():
    if not load_registry():
        pytest.skip("intersphinx_registry not available")
    r = RefInfo(None, None, "missing", "numpy.linspace")
    tagged = maybe_intersphinx(r)
    assert tagged.kind == "intersphinx"
    assert tagged.module == "numpy"
    assert tagged.path == "numpy.linspace"
    assert tagged.version is None


def test_maybe_intersphinx_handles_colon_paths():
    if not load_registry():
        pytest.skip("intersphinx_registry not available")
    r = RefInfo(None, None, "missing", "numpy.fft:fft")
    tagged = maybe_intersphinx(r)
    assert tagged.kind == "intersphinx"
    assert tagged.module == "numpy"


def test_maybe_intersphinx_leaves_unknown_project_alone():
    r = RefInfo(None, None, "missing", "definitely_not_registered.foo")
    assert maybe_intersphinx(r) is r
