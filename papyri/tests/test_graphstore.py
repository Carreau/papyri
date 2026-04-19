"""
Tests for GraphStore: schema creation, put/get/glob, link tracking.
"""

import pytest

from papyri.graphstore import GraphStore, Key


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """GraphStore backed by a temp directory with a temp database file."""
    import papyri.graphstore as gs

    db_path = tmp_path / "papyri.db"
    monkeypatch.setattr(gs, "GLOBAL_PATH", db_path)
    return GraphStore(tmp_path)


def test_init_creates_schema(store):
    tables = {
        row[0]
        for row in store.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )
    }
    assert "nodes" in tables
    assert "links" in tables


def test_put_and_get_roundtrip(store):
    key = Key("pkg", "1.0", "module", "pkg.foo")
    data = b"hello world"
    store.put(key, data, [])
    assert store.get(key) == data


def test_put_with_refs_and_forwardrefs(store):
    k1 = Key("pkg", "1.0", "module", "pkg.foo")
    k2 = Key("pkg", "1.0", "module", "pkg.bar")
    store.put(k1, b"foo", [k2])
    store.put(k2, b"bar", [])

    fwd = store.get_forwardrefs(k1)
    assert k2 in fwd
    assert k1 not in fwd


def test_backrefs(store):
    k1 = Key("pkg", "1.0", "module", "pkg.foo")
    k2 = Key("pkg", "1.0", "module", "pkg.bar")
    store.put(k1, b"foo", [k2])
    store.put(k2, b"bar", [])

    back = store.get_backref(k2)
    assert k1 in back


def test_glob_all(store):
    keys = [
        Key("pkg", "1.0", "module", "pkg.foo"),
        Key("pkg", "1.0", "module", "pkg.bar"),
        Key("pkg", "1.0", "docs", "intro"),
    ]
    for k in keys:
        store.put(k, b"data", [])

    results = store.glob((None, None, None, None))
    assert set(results) == set(keys)


def test_glob_by_category(store):
    module_key = Key("pkg", "1.0", "module", "pkg.foo")
    docs_key = Key("pkg", "1.0", "docs", "intro")
    store.put(module_key, b"a", [])
    store.put(docs_key, b"b", [])

    module_results = store.glob((None, None, "module", None))
    assert module_key in module_results
    assert docs_key not in module_results


def test_glob_specific(store):
    key = Key("pkg", "1.0", "meta", "aliases.cbor")
    store.put(key, b"aliases", [])

    results = store.glob((None, None, "meta", "aliases.cbor"))
    assert key in results


def test_put_updates_links_on_second_call(store):
    k1 = Key("pkg", "1.0", "module", "pkg.foo")
    k2 = Key("pkg", "1.0", "module", "pkg.bar")
    k3 = Key("pkg", "1.0", "module", "pkg.baz")

    store.put(k1, b"v1", [k2])
    fwd = store.get_forwardrefs(k1)
    assert k2 in fwd

    # Re-put k1 with different refs: remove k2, add k3
    store.put(k1, b"v2", [k3])
    fwd = store.get_forwardrefs(k1)
    assert k3 in fwd
    assert k2 not in fwd


def test_get_all(store):
    k1 = Key("pkg", "1.0", "module", "pkg.foo")
    k2 = Key("pkg", "1.0", "module", "pkg.bar")
    store.put(k1, b"foo", [k2])
    store.put(k2, b"bar", [])

    data, back, fwd = store.get_all(k1)
    assert data == b"foo"
    assert k2 in fwd
    assert len(back) == 0


def test_put_meta(store):
    store.put_meta("pkg", "1.0", b"meta data")
    meta_path = store._meta_path("pkg", "1.0")
    assert meta_path.path.exists()
    assert meta_path.read_bytes() == b"meta data"


def test_second_connection_sees_data(tmp_path, monkeypatch):
    """Simulate two sequential papyri-ingest calls sharing the same db file."""
    import papyri.graphstore as gs

    db_path = tmp_path / "papyri.db"
    monkeypatch.setattr(gs, "GLOBAL_PATH", db_path)

    # First "ingest" puts a document
    store1 = GraphStore(tmp_path)
    k = Key("pkg", "1.0", "module", "pkg.foo")
    store1.put(k, b"data", [])
    del store1  # close first connection

    # Second "ingest" opens the existing db and can read the document
    store2 = GraphStore(tmp_path)
    assert store2.get(k) == b"data"
    results = store2.glob((None, None, "module", None))
    assert k in results


def test_stale_schema_detected(tmp_path, monkeypatch):
    """Opening a DB with an old (pre-redesign) schema should raise RuntimeError."""
    import sqlite3

    import papyri.graphstore as gs

    db_path = tmp_path / "papyri.db"
    # Create a database with the OLD schema (no 'nodes' table).
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        "CREATE TABLE documents(id INTEGER PRIMARY KEY, package TEXT, version TEXT, "
        "category TEXT, identifier TEXT)"
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(gs, "GLOBAL_PATH", db_path)
    with pytest.raises(RuntimeError, match="outdated schema"):
        GraphStore(tmp_path)
