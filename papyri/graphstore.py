# import json
import logging
import sqlite3
from hashlib import blake2b
from pathlib import Path as _Path

import cbor2

# 16-byte BLAKE2b is enough collision space for our use (page-content
# fingerprint, not a security primitive) and noticeably faster than SHA-256.
_DIGEST_SIZE = 16

log = logging.getLogger("papyri")

# we try to expanduser as early as possible to prevent
# jupyter_pytest monkeypatch  of setenv_HOME
GLOBAL_PATH = _Path("~/.papyri/ingest/papyri.db").expanduser()

_SCHEMA = """
CREATE TABLE nodes(
    id         INTEGER PRIMARY KEY,
    package    TEXT NOT NULL,
    version    TEXT NOT NULL,
    category   TEXT NOT NULL,
    identifier TEXT NOT NULL,
    has_blob   INTEGER NOT NULL DEFAULT 0,
    digest     BLOB,
    UNIQUE(package, version, category, identifier)
);
CREATE TABLE links(
    source INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    dest   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    PRIMARY KEY (source, dest)
);
CREATE INDEX idx_links_dest ON links(dest);
CREATE INDEX idx_nodes_pkg_cat_ident
    ON nodes(package, category, identifier);
"""

# Applied to every connection, old or new.
_PRAGMAS = [
    "PRAGMA foreign_keys = 1",
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA cache_size = -65536",
    "PRAGMA mmap_size = 268435456",
]


class Path:
    """path wrapper with .read_json / .write_json backed by CBOR"""

    def __init__(self, path):
        assert isinstance(path, _Path), path
        self.path = path

    def read_json(self):
        with open(self.path, "rb") as f:
            return cbor2.load(f)

    def write_json(self, data):
        with open(self.path, "wb") as f:
            return cbor2.dump(data, f, canonical=True)

    def __truediv__(self, other):
        return type(self)(self.path / other)

    def write_bytes(self, *args, **kwargs):
        self.path.write_bytes(*args, **kwargs)

    @property
    def parent(self):
        return self.path.parent

    def exists(self, *args, **kwargs):
        return self.path.exists(*args, **kwargs)

    def mkdir(self, *args, **kwargs):
        self.path.mkdir(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self.path, name)

    def __str__(self):
        return f"<{type(self)} {self.path}>"


# a Key name tuple with a custom __init__
class Key:
    def __init__(self, module, version, kind, path):
        assert ":" not in module
        self.module = module
        self.version = version
        self.kind = kind
        self.path = path

    def __contains__(self, other):
        return other in self._t()

    def _t(self):
        return (self.module, self.version, self.kind, self.path)

    def __getitem__(self, n):
        return self._t()[n]

    def __iter__(self):
        return iter(self._t())

    def __gt__(self, other):
        return self._t() > other._t()

    def __eq__(self, other):
        return self._t() == other._t()

    def __hash__(self):
        return hash(self._t())

    def __repr__(self):
        return f"<Key {self._t()}>"


class GraphStore:
    """
    Abstraction over a filesystem blob store plus a SQLite graph index.

    Each document is stored as a CBOR blob on disk, keyed by a 4-tuple
    (package, version, category, identifier).  The SQLite database tracks
    which documents exist and which forward/back references connect them.
    The filesystem is the source of truth for blob content; SQLite is the
    source of truth for graph structure.

    We do not want to use the server or alike as most of our users will use REPL
    or IDE and performance is not our goal as we are likely going to access
    nodes infrequently.

    Plus we are not that much interested in the graph structure (yet), than the
    local neighborhood.

    We also have some specificities around document versions, which I'm not
    clear yet as to how to deal with, as well as dangling edges.

    Each document is stored with an ~4 item keys:

     - package it belongs to
     - version
     - kind of document
     - name of document

    Each document will also have references to others, with types; those are our
    edges.

    When we get a document, we do want to get as well all most recent the
    documents that reference it and why that is to say the coming edges.

    When we put a document, we ask for all the documents this references; and
    should update the edges accordingly.

    One more question is about the dangling documents? Like document we have references to,
    but do not exist yet, and a bunch of other stuff.

    """

    def __init__(self, root: _Path, link_finder=None):
        from .config import ensure_dirs

        ensure_dirs()
        p = GLOBAL_PATH
        log.debug("connecting to database %s", p)
        is_new = not p.exists()
        self.conn = sqlite3.connect(str(p))
        self.conn.row_factory = sqlite3.Row
        for pragma in _PRAGMAS:
            self.conn.execute(pragma)

        if is_new:
            log.info("creating new database: %s", p)
            # executescript() issues an implicit COMMIT in Python ≥3.12 which
            # can interact with the pragma executions above.  Use explicit DDL
            # statements inside a normal transaction instead.
            with self.conn:
                for stmt in _SCHEMA.strip().split(";"):
                    stmt = stmt.strip()
                    if stmt:
                        self.conn.execute(stmt)

        assert isinstance(root, _Path)
        self._root = Path(root)
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
        return path / key[-1]  # type: ignore[no-any-return]

    def remove(self, key: Key) -> None:
        path = self._key_to_path(key)
        path.path.unlink()
        with self.conn:
            row = self.conn.execute(
                "SELECT id FROM nodes WHERE package=? AND version=? AND category=? AND identifier=?",
                list(key),
            ).fetchone()
            if row:
                # Only delete outgoing links; keep the node so other documents
                # that reference it don't get dangling dest entries.
                self.conn.execute("DELETE FROM links WHERE source=?", (row["id"],))

    def _get(self, key: Key) -> bytes:
        assert isinstance(key, Key)
        return self._key_to_path(key).read_bytes()  # type: ignore[no-any-return]

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

    def get_all(self, key: Key):
        a = self._get(key)
        b = self._get_backrefs(key)
        c = self.get_forwardrefs(key)
        return (a, b, c)

    def get_backref(self, key: Key) -> set[Key]:
        return self._get_backrefs(key)

    def get(self, key: Key) -> bytes:
        return self._get(key)

    def _maybe_insert_node(
        self,
        key,
        *,
        has_blob: bool = False,
        digest: bytes | None = None,
    ) -> int:
        """Insert node if not present, return its id. Must be called within a transaction.

        Pass has_blob=True when the caller is also writing a blob file for this key.
        Placeholder nodes (link destinations not yet ingested) are inserted with
        has_blob=False so that glob() skips them.

        ``digest`` is a content fingerprint of the canonical (re-encoded)
        blob bytes (BLAKE2b-128); it is only set when the caller is writing
        a blob (has_blob=True).
        """
        # RETURNING only fires when a row is actually inserted (not on IGNORE).
        row = self.conn.execute(
            "INSERT OR IGNORE INTO nodes(package, version, category, identifier)"
            " VALUES (?, ?, ?, ?) RETURNING id",
            list(key),
        ).fetchone()
        if row is None:
            # Row already existed; look up its id.
            row = self.conn.execute(
                "SELECT id FROM nodes WHERE package=? AND version=? AND category=? AND identifier=?",
                list(key),
            ).fetchone()
        node_id: int = row["id"]
        if has_blob:
            self.conn.execute(
                "UPDATE nodes SET has_blob=1, digest=? WHERE id=?",
                (digest, node_id),
            )
        return node_id

    def _meta_path(self, module: str, version: str):
        assert isinstance(module, str)
        assert isinstance(version, str)
        return self._root / module / version / "meta.cbor"

    def put_meta(self, module: str, version: str, data: bytes) -> None:
        assert isinstance(data, bytes)
        mp = self._meta_path(module, version)
        mp.path.parent.mkdir(parents=True, exist_ok=True)
        mp.write_bytes(data)

    def get_meta(self, key: Key) -> bytes:
        return self._meta_path(key.module, key.version).read_bytes()  # type: ignore[no-any-return]

    def put(self, key: Key, bytes_: bytes, refs) -> None:
        """
        Store object ``bytes_``, as path ``key`` with the corresponding
        links to other objects.

        A 16-byte BLAKE2b digest of ``bytes_`` is recorded as the node's
        content fingerprint. Callers are expected to pass the canonical
        (re-encoded) form of the blob; this is what gives us a meaningful
        "did this page change between two versions" comparison without
        re-reading every blob.

        refs : List[Key]
        """
        assert isinstance(key, Key)
        for r in refs:
            assert isinstance(r, Key), r
        path = self._key_to_path(key)
        path.path.parent.mkdir(parents=True, exist_ok=True)

        if "assets" not in key and path.exists():
            old_refs = self.get_forwardrefs(key)
        else:
            old_refs = set()

        path.write_bytes(bytes_)
        digest = blake2b(bytes_, digest_size=_DIGEST_SIZE).digest()

        new_refs = set(refs)
        removed_refs = old_refs - new_refs
        added_refs = new_refs - old_refs

        with self.conn:
            source_id = self._maybe_insert_node(key, has_blob=True, digest=digest)

            add_params = [
                (source_id, self._maybe_insert_node(ref)) for ref in added_refs
            ]

            if removed_refs:
                placeholders = ",".join("(?,?,?,?)" for _ in removed_refs)
                params = [v for ref in removed_refs for v in ref]
                rows = self.conn.execute(
                    f"SELECT id FROM nodes WHERE (package, version, category, identifier)"
                    f" IN (VALUES {placeholders})",
                    params,
                ).fetchall()
                del_params = [(source_id, row["id"]) for row in rows]
            else:
                del_params = []

            c = self.conn.cursor()
            c.executemany(
                "INSERT OR IGNORE INTO links(source, dest) VALUES (?,?)", add_params
            )
            c.executemany("DELETE FROM links WHERE source=? AND dest=?", del_params)

    def glob(self, pattern) -> list[Key]:
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

        The digest is a 16-byte BLAKE2b fingerprint computed at ``put``
        time. Returns None if the row exists with no recorded digest, and
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
