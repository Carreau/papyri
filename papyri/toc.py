import logging
from typing import Any

log = logging.getLogger("papyri")


def flatten(dct: dict[str, Any]) -> dict[str, list[Any]]:
    return {k: [s for sub in toc for s in sub] for k, toc in dct.items()}


def dotdotcount(path: list[str]) -> tuple[int, list[str]]:
    n = 0
    acc: list[str] = []
    leading = True
    for it in path:
        if it == "..":
            assert leading is True, path
            n += 1
        else:
            leading = False
            acc.append(it)
    return n, acc


def _tree(
    current_path: str,
    unnest: dict[str, list[str]],
    counter: dict[str, int],
    depth: int = 0,
) -> dict[str, Any]:
    """Recursively build a nested toctree dict rooted at ``current_path``.

    Walks the flat toctree adjacency map ``unnest`` (``node -> list of child
    references as written in the source``) and returns a nested
    ``{child_path: {grandchild_path: {...}}}`` dict describing the tree
    reachable from ``current_path``.

    Path model:
        Nodes are addressed with ``:``-separated keys (e.g.
        ``pkg:sub:page``); the last segment is the page name and the prefix
        is its "directory". Child references in ``unnest`` are written in
        source form using ``/`` and may be relative (``../sibling``,
        ``sub/page``). For each child reference this function:

        - drops empty entries,
        - skips absolute (``/...``) and external (``https://``) refs,
        - rewrites a trailing ``/`` to ``/index`` (Sphinx directory-index
          convention),
        - resolves ``..`` segments against ``current_path``'s directory
          via :func:`dotdotcount`,
        - strips a trailing ``.rst``,
        - then recurses.

    Side effects / bookkeeping:
        - ``counter`` maps every known node to a visit count. It is
          incremented for ``current_path`` on entry, so callers can detect
          nodes referenced 0 times (orphans) or >1 times (multi-parent).
          A reference whose resolved path is not in ``counter`` is treated
          as dangling and skipped with a printed warning.
        - Asserts that the resolved child path is neither ``current_path``
          itself nor already present among siblings — i.e. the input must
          describe a tree, not a DAG with duplicate edges.

    ``depth`` is informational only (used by the commented-out debug
    prints); it does not affect the result.
    """
    if current_path not in counter:
        print("Warning, ", current_path, "not in Counter")
        counter[current_path] = 0
    counter[current_path] += 1
    children = {}
    children_path = unnest.get(current_path, [])
    directory = current_path.split(":")[:-1]
    # print(' '*depth*4, 'dir', directory, f'({current_path})')
    for cp in children_path:
        if not cp:
            continue

        # assert not cp.startswith("/"), breakpoint()
        if cp.startswith("/"):
            print("skip absolute path", cp, "in", current_path)
            continue
        if cp.endswith("/"):
            cp = cp + "index"

        if cp.startswith("https://"):
            continue

        n, sub = dotdotcount(cp.split("/"))
        directory = current_path.split(":")[: -1 - n]
        p = ":".join(directory + sub)

        if p.endswith(".rst"):
            p = p[:-4]
        assert p != current_path, (
            f"toctree self-reference: {current_path!r} lists {cp!r} "
            f"which resolves back to itself"
        )
        # print(' '*depth*4,cp, '->', p)
        if p in children:
            # Sphinx allows the same page to appear in multiple `.. toctree::`
            # directives on a single parent — typically one visible toctree
            # plus a separate `:hidden:` toctree used only to define
            # prev/next ordering. We only model tree shape here, so the
            # second occurrence is redundant: keep the first and skip.
            log.warning(
                "toc: %r is listed more than once under %r "
                "(reference %r); keeping the first occurrence and "
                "ignoring the duplicate. This is usually a hidden "
                "toctree used for prev/next ordering in Sphinx.",
                p,
                current_path,
                cp,
            )
            continue
        if p not in counter:
            print("skip Path", p, "in", current_path, repr(cp))
            continue
        children[p] = _tree(p, unnest, depth=depth + 1, counter=counter)

    return children


def make_tree(data: dict[str, Any]) -> tuple[str | None, dict[str, Any]]:
    data = {k: v for k, v in data.items()}
    data = flatten(data)
    data = {k: [i[1] for i in v] for k, v in data.items()}
    c = {k: 0 for k in data}
    if not c:
        return None, {}
    # Prefer "index" as the root (standard Sphinx layout), but fall back to
    # the first key that is not referenced by any other node (i.e. a true
    # root in the toctree graph). This handles packages whose entry point is
    # not named "index".
    root = "index"
    if root not in c:
        referenced = {
            child for children in data.values() for child in children if child
        }
        candidates = [k for k in c if k not in referenced]
        root = candidates[0] if candidates else next(iter(c))
        log.warning("toc: no 'index' root found; using %r as tree root instead", root)
    return root, _tree(root, data, c)
