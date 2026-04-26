"""Filesystem locations for papyri's local data + ingest stores.

Paths are constants; directory creation is opt-in via ``ensure_dirs()``
so importing this module from a test, type-check, or read-only CLI
command doesn't fork directories under ``~/.papyri/``. Writers
(``GraphStore``, ``papyri gen``) call ``ensure_dirs()`` themselves.
"""

from os.path import expanduser
from pathlib import Path

base_dir = Path(expanduser("~/.papyri/"))

ingest_dir = base_dir / "ingest"
data_dir = base_dir / "data"


def ensure_dirs() -> None:
    """Create the per-user papyri directories if they don't already exist."""
    base_dir.mkdir(parents=True, exist_ok=True)
    ingest_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)
