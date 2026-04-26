"""``Config`` dataclass and TOML loader for ``papyri gen``.

The configuration shape matches the ``[global]`` and ``[meta]``
sections of the per-package TOML files in ``examples/``.
``load_configuration`` returns the parsed package name, ``[global]``
section (sans ``module``), and ``[meta]`` section.
"""

from __future__ import annotations

import dataclasses
import sys
import tomllib
from collections.abc import MutableMapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class Config:
    # we might want to suppress progress/ rich as it infers with ipdb.
    dummy_progress: bool = False
    # Do not actually touch disk
    dry_run: bool = False
    exec_failure: str | None = None  # should move to enum
    jedi_failure_mode: str | None = None  # move to enum ?
    logo: str | None = None  # should change to path likely
    execute_exclude_patterns: Sequence[str] = ()
    infer: bool = True
    exclude: Sequence[str] = ()  # list of dotted object name to exclude from collection
    examples_folder: str | None = None  # < to path ?
    submodules: Sequence[str] = ()
    source: str | None = None
    homepage: str | None = None
    docs: str | None = None
    docs_path: str | None = None
    wait_for_plt_show: bool | None = True
    examples_exclude: Sequence[str] = ()
    narrative_exclude: Sequence[str] = ()
    exclude_jedi: Sequence[str] = ()
    implied_imports: dict[str, str] = dataclasses.field(default_factory=dict)
    # mapping from expected name of error instances, to which fully-qualified names are raising those errors.
    # the build will fail if the given item does not raise this error.
    expected_errors: dict[str, list[str]] = dataclasses.field(default_factory=dict)
    early_error: bool = True
    fail_unseen_error: bool = False
    execute_doctests: bool = True
    directives: dict[str, str] = dataclasses.field(default_factory=lambda: {})

    def replace(self, **kwargs):
        return dataclasses.replace(self, **kwargs)


def load_configuration(
    path: str,
) -> tuple[str, MutableMapping[str, Any], dict[str, Any]]:
    """
    Given a path, load a configuration from a File.

    Each configuration file should have two sections: ['global', 'meta'] where
    the name of the module should be defined under the 'global' section.
    Additionally, a section for expected errors can be defined.
    """
    conffile = Path(path).expanduser()
    if conffile.exists():
        conf: MutableMapping[str, Any] = tomllib.loads(conffile.read_text())
        ks = set(conf.keys()) - {"meta"}
        assert len(ks) >= 1, conf.keys()
        info = conf["global"]
        root = info.pop("module")
        return root, info, conf.get("meta", {})
    else:
        sys.exit(f"{conffile!r} does not exist.")
