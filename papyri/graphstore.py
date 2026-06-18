# import json
import logging
import sqlite3
from pathlib import Path
from typing import Any, NamedTuple

log = logging.getLogger("papyri")

# Expanduser is evaluated at module-import time so tests can monkeypatch HOME
# afterwards without invalidating this path.
GLOBAL_PATH = Path("~/.papyri/ingest/papyri.db").expanduser()

# Applied to every connection, old or new.
_PRAGMAS = [
    "PRAGMA foreign_keys = 1",
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA cache_size = -65536",
    "PRAGMA mmap_size = 268435456",
]


class Key(NamedTuple):
    module: str
    version: str
    kind: str
    path: str


class GraphStore:
    """
    Read-only interface to the ingested graphstore.

    The graphstore is a derived cache: a filesystem blob store plus a SQLite
    graph index that the TypeScript ingest pipeline owns exclusively. The
    Python side reads metadata (which documents exist, their forward/back
    references, content digests) but never writes. Schema creation and all
    writes are the responsibility of the TypeScript ingest engine
    (ingest/src/ingest.ts).

    Each document is stored as a CBOR blob on disk, keyed by a 4-tuple
    (package, version, category, identifier). The SQLite database tracks
    which documents exist and which forward/back references connect them.
    """

    def __init__(self, root: Path, link_finder: Any = None) -> None:
        from .config import ensure_dirs

        ensure_dirs()
        p = GLOBAL_PATH
        log.debug("connecting to database %s", p)
        self.conn = sqlite3.connect(str(p))
        self.conn.row_factory = sqlite3.Row
        for pragma in _PRAGMAS:
            self.conn.execute(pragma)

        assert isinstance(root, Path)
        self._root = root
        self._link_finder = link_finder

    def _key_to_path(self, key: Key) -> Path:
        """
        Given a key, return path to the current file.

        Parameters
        ----------
        key : Key

        Returns
        -------
        data_path : Path
        """
        path = self._root
        assert None not in key, key
        for k in key[:-1]:
            path = path / k
        return path / key[-1]

    def _get(self, key: Key) -> bytes:
        assert isinstance(key, Key)
        return self._key_to_path(key).read_bytes()

    def _get_backrefs(self, key: Key) -> set[Key]:
        rows = self.conn.execute(
            """
            SELECT n_src.package, n_src.version, n_src.category, n_src.identifier
            FROM links
            JOIN nodes AS n_src  ON links.source = n_src.id
            JOIN nodes AS n_dest ON links.dest   = n_dest.id
            WHERE n_dest.package=?
              AND n_dest.version=?
              AND n_dest.category=?
              AND n_dest.identifier=?
            """,
            list(key),
        ).fetchall()
        return {Key(r[0], r[1], r[2], r[3]) for r in rows}

    def get_forwardrefs(self, key: Key) -> set[Key]:
        rows = self.conn.execute(
            """
            SELECT n_dest.package, n_dest.version, n_dest.category, n_dest.identifier
            FROM links
            JOIN nodes AS n_src  ON links.source = n_src.id
            JOIN nodes AS n_dest ON links.dest   = n_dest.id
            WHERE n_src.package=?
              AND n_src.version=?
              AND n_src.category=?
              AND n_src.identifier=?
            """,
            list(key),
        ).fetchall()
        return {Key(r[0], r[1], r[2], r[3]) for r in rows}

    def get_all(self, key: Key) -> tuple[bytes, set[Key], set[Key]]:
        a = self._get(key)
        b = self._get_backrefs(key)
        c = self.get_forwardrefs(key)
        return (a, b, c)

    def get_backref(self, key: Key) -> set[Key]:
        return self._get_backrefs(key)

    def get(self, key: Key) -> bytes:
        return self._get(key)

    def get_meta(self, key: Key) -> bytes:
        meta_path = self._root / key.module / key.version / "meta.cbor"
        return meta_path.read_bytes()

    def glob(
        self, pattern: tuple[str | None, str | None, str | None, str | None]
    ) -> list[Key]:
        package, version, category, identifier = pattern
        clauses = []
        params = []
        for col, val in [
            ("package", package),
            ("version", version),
            ("category", category),
            ("identifier", identifier),
        ]:
            if val is not None:
                clauses.append(f"{col}=?")
                params.append(val)
        clauses.append("has_blob=1")
        where = "WHERE " + " AND ".join(clauses)
        rows = self.conn.execute(
            f"SELECT package, version, category, identifier FROM nodes {where}",
            params,
        ).fetchall()
        return [Key(r[0], r[1], r[2], r[3]) for r in rows]

    def get_digest(self, key: Key) -> bytes | None:
        """Return the content digest of the canonical blob bytes for ``key``.

        The digest is a 16-byte BLAKE2b fingerprint recorded at ingest time.
        Returns None if the row exists with no recorded digest, and
        raises ``KeyError`` if the row does not exist at all.
        """
        row = self.conn.execute(
            "SELECT digest FROM nodes"
            " WHERE package=? AND version=? AND category=? AND identifier=?"
            "   AND has_blob=1",
            list(key),
        ).fetchone()
        if row is None:
            raise KeyError(key)
        digest: bytes | None = row["digest"]
        return digest

    def diff_versions(
        self,
        package: str,
        version_a: str,
        version_b: str,
    ) -> list[tuple[str, str, bytes | None, bytes | None]]:
        """Compare two versions of one package by content digest.

        Returns rows ``(category, identifier, digest_a, digest_b)`` for
        every page that exists in at least one of the versions and whose
        digest differs between them. Pages with identical digests are
        omitted.

        - ``digest_a is None``: the page does not exist in ``version_a``
          (i.e. it was added in ``version_b``).
        - ``digest_b is None``: the page does not exist in ``version_b``
          (i.e. it was removed).
        - both not None and different: the page was modified.

        Callers that only care about one ``category`` (module / docs /
        examples / …) can filter the returned list directly.
        """
        # Emulate FULL OUTER JOIN with the union of two LEFT JOINs so we
        # don't depend on SQLite >= 3.39 (Python's bundled sqlite3 version
        # varies by platform/distribution).
        sql = """
            SELECT category, identifier, digest_a, digest_b
            FROM (
                SELECT a.category   AS category,
                       a.identifier AS identifier,
                       a.digest     AS digest_a,
                       b.digest     AS digest_b
                FROM (
                    SELECT category, identifier, digest
                    FROM nodes
                    WHERE package=? AND version=? AND has_blob=1
                ) a
                LEFT JOIN (
                    SELECT category, identifier, digest
                    FROM nodes
                    WHERE package=? AND version=? AND has_blob=1
                ) b USING (category, identifier)
                UNION
                SELECT b.category, b.identifier, a.digest, b.digest
                FROM (
                    SELECT category, identifier, digest
                    FROM nodes
                    WHERE package=? AND version=? AND has_blob=1
                ) b
                LEFT JOIN (
                    SELECT category, identifier, digest
                    FROM nodes
                    WHERE package=? AND version=? AND has_blob=1
                ) a USING (category, identifier)
                WHERE a.identifier IS NULL
            )
            WHERE digest_a IS NOT digest_b
            ORDER BY category, identifier
        """
        params = [
            package,
            version_a,
            package,
            version_b,
            package,
            version_b,
            package,
            version_a,
        ]
        rows = self.conn.execute(sql, params).fetchall()
        return [
            (r["category"], r["identifier"], r["digest_a"], r["digest_b"]) for r in rows
        ]
