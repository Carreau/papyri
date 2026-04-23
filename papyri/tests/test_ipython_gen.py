"""
Integration tests: clone IPython main branch and run papyri gen with narrative docs.

Marked ``network`` + ``slow``; skip in regular CI with ``pytest -m "not network"``.

These tests verify that the full gen pipeline (API + narrative) works end-to-end
against a real upstream package rather than a vendored fixture.
"""

import importlib
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

HERE = Path(__file__).parent
EXAMPLES = HERE.parent.parent / "examples"
IPYTHON_TOML = EXAMPLES / "IPython.toml"
IPYTHON_REPO = "https://github.com/ipython/ipython.git"

# A small set of well-known API objects used to keep the API-gen step fast.
_API_SAMPLE = [
    "IPython:embed_kernel",
    "IPython.core.interactiveshell:InteractiveShell.run_cell",
    "IPython.core.magic:register_line_magic",
]


@pytest.fixture(scope="module")
def cloned_ipython(tmp_path_factory):
    """Shallow-clone IPython main into a temp directory (once per module)."""
    repo_dir = tmp_path_factory.mktemp("ipython_src") / "ipython"
    result = subprocess.run(
        ["git", "clone", "--depth=1", IPYTHON_REPO, str(repo_dir)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert result.returncode == 0, f"git clone failed:\n{result.stderr}"
    return repo_dir


@pytest.fixture(scope="module")
def ipython_env(cloned_ipython):
    """Install the cloned IPython into the running Python environment."""
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet", "-e", str(cloned_ipython)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert result.returncode == 0, f"pip install failed:\n{result.stderr}"
    # Ensure the newly installed package is visible in the running interpreter.
    importlib.invalidate_caches()
    return cloned_ipython


def _load_config(ipython_repo: Path):
    """Return (conf_dict, meta_dict) from IPython.toml with docs_path overridden."""
    raw = tomllib.loads(IPYTHON_TOML.read_text())
    conf = raw.get("global", {}).copy()
    meta = raw.get("meta", {}).copy()
    conf.pop("module")  # passed explicitly to Gen methods
    conf["docs_path"] = str(ipython_repo / "docs" / "source")
    conf["execute_doctests"] = False
    conf["infer"] = False
    return conf, meta


@pytest.mark.network
@pytest.mark.slow
def test_ipython_narrative_docs_collected(tmp_path, ipython_env):
    """
    Narrative docs from IPython main branch produce docs/ files and toc.cbor.

    This mirrors ``papyri gen examples/IPython.toml --narrative --no-api``.
    """
    from papyri.gen import Config, Gen

    conf, meta = _load_config(ipython_env)
    config = Config(**conf, dummy_progress=True)
    g = Gen(dummy_progress=True, config=config)
    g.collect_package_metadata("IPython", relative_dir=EXAMPLES, meta=meta)
    g.collect_narrative_docs()

    out_dir = tmp_path / "bundle"
    out_dir.mkdir()
    g.write_narrative(out_dir)

    docs_dir = out_dir / "docs"
    assert docs_dir.exists(), "docs/ directory should be created by write_narrative"

    doc_files = list(docs_dir.iterdir())
    assert len(doc_files) > 5, (
        f"Expected >5 narrative pages, got {len(doc_files)}: "
        f"{[f.name for f in doc_files]}"
    )

    assert (out_dir / "toc.cbor").exists(), "toc.cbor should be written"


@pytest.mark.network
@pytest.mark.slow
def test_ipython_api_and_narrative_gen(tmp_path, ipython_env):
    """
    Full gen (API subset + narrative) on IPython main branch writes a valid bundle.

    Mirrors ``papyri gen examples/IPython.toml --narrative`` but limits the
    API objects to keep runtime manageable.
    """
    from papyri.gen import Config, Gen

    conf, meta = _load_config(ipython_env)
    config = Config(**conf, dummy_progress=True)
    g = Gen(dummy_progress=True, config=config)
    g.collect_package_metadata("IPython", relative_dir=EXAMPLES, meta=meta)
    g.collect_api_docs("IPython", limit_to=_API_SAMPLE)
    g.collect_narrative_docs()

    out_dir = tmp_path / "bundle"
    out_dir.mkdir()
    g.write_api(out_dir)
    g.write_narrative(out_dir)

    # API objects — one .cbor per qualified name.
    module_dir = out_dir / "module"
    assert module_dir.exists(), "module/ directory should be written by write_api"
    for qa in _API_SAMPLE:
        assert (module_dir / f"{qa}.cbor").exists(), f"Missing API file for {qa}"

    # Narrative docs.
    docs_dir = out_dir / "docs"
    assert docs_dir.exists(), "docs/ directory should be written by write_narrative"
    assert len(list(docs_dir.iterdir())) > 5, "Expected multiple narrative pages"
    assert (out_dir / "toc.cbor").exists(), "toc.cbor should be written"
