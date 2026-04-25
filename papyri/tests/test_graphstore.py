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


def test_glob_excludes_placeholder_nodes(store):
    k1 = Key("pkg", "1.0", "module", "pkg.foo")
    k2 = Key("other", "2.0", "module", "other.bar")
    # k1 references k2, but k2 is never put() — it becomes a placeholder node
    store.put(k1, b"foo", [k2])

    results = store.glob((None, None, None, None))
    assert k1 in results
    assert k2 not in results


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


def test_remove_drops_blob_and_outgoing_links(store):
    """``remove`` must delete the blob file and outgoing links, but keep the
    node row so documents that still reference it don't end up with dangling
    dest rows."""
    k1 = Key("pkg", "1.0", "module", "pkg.foo")
    k2 = Key("pkg", "1.0", "module", "pkg.bar")
    store.put(k1, b"foo", [k2])
    store.put(k2, b"bar", [k1])
    # Both sides see each other before removal.
    assert store.get_backref(k1) == {k2}
    assert store.get_forwardrefs(k1) == {k2}

    store.remove(k1)

    # k1's blob file is gone.
    with pytest.raises(FileNotFoundError):
        store.get(k1)
    # k1's outgoing links are cleared.
    assert store.get_forwardrefs(k1) == set()
    # But k2 still points at k1 — we kept k1's node row on purpose.
    assert k1 in store.get_forwardrefs(k2)


def test_meta_roundtrip(store):
    store.put_meta("pkg", "1.0", b"meta bytes")
    key = Key("pkg", "1.0", "meta", "meta.cbor")
    assert store.get_meta(key) == b"meta bytes"


def test_glob_ignores_links_without_blobs(store):
    """Referenced but never-put keys are placeholder rows: glob must skip them,
    but they remain discoverable through ``get_forwardrefs``."""
    src = Key("pkg", "1.0", "module", "pkg.foo")
    dest = Key("other", "2.0", "module", "other.thing")
    store.put(src, b"data", [dest])

    all_keys = store.glob((None, None, None, None))
    assert src in all_keys
    assert dest not in all_keys
    # But the graph edge is preserved so post-ingest link resolution can see it.
    assert dest in store.get_forwardrefs(src)


def test_put_assets_key_does_not_check_old_refs(store):
    """Assets bypass the old_refs lookup (``"assets" not in key``).

    Pinning this: the fast path writes the file even on re-put without
    querying links, which matters for re-ingesting image blobs.
    """
    akey = Key("pkg", "1.0", "assets", "logo.png")
    store.put(akey, b"v1", [])
    assert store.get(akey) == b"v1"
    store.put(akey, b"v2", [])
    assert store.get(akey) == b"v2"


def test_put_records_blake2b_digest(store):
    from hashlib import blake2b

    key = Key("pkg", "1.0", "module", "pkg.foo")
    data = b"hello digest"
    store.put(key, data, [])
    assert store.get_digest(key) == blake2b(data, digest_size=16).digest()


def test_put_overwrites_digest(store):
    from hashlib import blake2b

    key = Key("pkg", "1.0", "module", "pkg.foo")
    store.put(key, b"v1", [])
    assert store.get_digest(key) == blake2b(b"v1", digest_size=16).digest()
    store.put(key, b"v2", [])
    assert store.get_digest(key) == blake2b(b"v2", digest_size=16).digest()


def test_get_digest_missing_key_raises(store):
    with pytest.raises(KeyError):
        store.get_digest(Key("pkg", "1.0", "module", "absent"))


def test_get_digest_skips_placeholder_node(store):
    """Placeholder nodes (link destination, never put) have has_blob=0 and
    must not be returned by ``get_digest`` — they would otherwise look like
    'page exists with NULL digest'."""
    src = Key("pkg", "1.0", "module", "pkg.foo")
    dest = Key("other", "2.0", "module", "other.bar")
    store.put(src, b"data", [dest])
    with pytest.raises(KeyError):
        store.get_digest(dest)


def test_diff_versions_added_removed_modified(store):
    common_same = Key("pkg", "1.0", "module", "pkg.same")
    common_changed_a = Key("pkg", "1.0", "module", "pkg.changed")
    common_changed_b = Key("pkg", "2.0", "module", "pkg.changed")
    only_in_a = Key("pkg", "1.0", "module", "pkg.removed")
    only_in_b = Key("pkg", "2.0", "module", "pkg.added")

    same_in_b = Key("pkg", "2.0", "module", "pkg.same")
    store.put(common_same, b"identical", [])
    store.put(same_in_b, b"identical", [])
    store.put(common_changed_a, b"old body", [])
    store.put(common_changed_b, b"new body", [])
    store.put(only_in_a, b"gone", [])
    store.put(only_in_b, b"new page", [])

    rows = store.diff_versions("pkg", "1.0", "2.0")
    bucketed = {(c, ident): (da, db) for c, ident, da, db in rows}

    # pkg.same is omitted (digests match).
    assert ("module", "pkg.same") not in bucketed

    # pkg.changed shows up with both sides populated and different.
    da, db = bucketed[("module", "pkg.changed")]
    assert da is not None and db is not None and da != db

    # Removed: present in a, absent in b.
    da, db = bucketed[("module", "pkg.removed")]
    assert da is not None and db is None

    # Added: absent in a, present in b.
    da, db = bucketed[("module", "pkg.added")]
    assert da is None and db is not None


def test_diff_versions_empty_when_identical(store):
    """Two versions whose pages are byte-identical produce an empty diff."""
    a = Key("pkg", "1.0", "module", "pkg.foo")
    b = Key("pkg", "2.0", "module", "pkg.foo")
    store.put(a, b"same bytes", [])
    store.put(b, b"same bytes", [])
    assert store.diff_versions("pkg", "1.0", "2.0") == []


def test_diff_versions_includes_all_categories(store):
    """diff_versions returns every changed page across every category;
    callers that only care about one category filter the returned list."""
    store.put(Key("pkg", "1.0", "module", "pkg.foo"), b"old mod", [])
    store.put(Key("pkg", "2.0", "module", "pkg.foo"), b"new mod", [])
    store.put(Key("pkg", "1.0", "docs", "intro"), b"old doc", [])
    store.put(Key("pkg", "2.0", "docs", "intro"), b"new doc", [])

    rows = store.diff_versions("pkg", "1.0", "2.0")
    cats = {c for c, _ident, _, _ in rows}
    assert cats == {"module", "docs"}
