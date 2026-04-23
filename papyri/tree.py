"""
This module contains utilities to manipulate the documentation units,
usually trees, and update nodes.

"""

import logging
from collections import Counter, defaultdict
from collections.abc import Callable
from functools import lru_cache
from textwrap import indent
from typing import Any

from .directives import (
    block_math_handler,
    deprecated_handler,
    note_handler,
    versionadded_handler,
    versionchanged_handler,
    warning_handler,
)
from .node_base import Node
from .nodes import (
    BulletList,
    CitationReference,
    Code,
    CrossRef,
    Directive,
    InlineCode,
    InlineMath,
    InlineRole,
    Link,
    ListItem,
    LocalRef,
    Paragraph,
    RefInfo,
    Section,
    SubstitutionDef,
    SubstitutionRef,
    Text,
    UnprocessedDirective,
)
from .utils import Cannonical, FullQual, full_qual, obj_from_qualname

log = logging.getLogger("papyri")


_cache: dict[int, tuple[dict[str, RefInfo], frozenset[str]]] = {}


# @lru_cache(maxsize=100000)
def _build_resolver_cache(
    known_refs: frozenset[RefInfo],
) -> tuple[dict[str, RefInfo], frozenset[str]]:
    """
    Build resolver cached.

    Here we build two caches:

    1) a mapping from fully qualified names to refinfo objects.
    2) a set of all the keys we know about.

    Parameters
    ----------
    known_refs : (frozen) set of RefInfo

    Returns
    -------
    mapping:
        Mapping from path to a RefInfo, this allows to quickly compute
        what is the actual refinfo for a give path/qualname
    keyset:
        Frozenset of the map keys.

    """

    _map: dict[str, list[RefInfo]] = defaultdict(lambda: [])
    assert isinstance(known_refs, frozenset)
    for k in known_refs:
        assert isinstance(k, RefInfo)
        _map[k.path].append(k)

    _m2: dict[str, RefInfo] = {}
    for kk, v in _map.items():
        cand = list(sorted(v, key=lambda x: "" if x.version is None else x.version))
        assert len({c.module for c in cand}) == 1, cand
        _m2[kk] = cand[-1]

    return _m2, frozenset(_m2.keys())


@lru_cache
def root_start(root, refs):
    """
    Compute a subset of references that start with given root.
    """
    return frozenset(r for r in refs if r.startswith(root))


@lru_cache(10000)
def endswith(end, refs):
    """
    Compute as subset of references that ends with given root.
    """
    return frozenset(r for r in refs if r.endswith(end))


class DelayedResolver:
    _targets: dict[str, RefInfo | LocalRef]
    _references: dict[str, list[CrossRef]]

    def __init__(self):
        self._targets = dict()
        self._references = dict()

    def add_target(self, target_ref: RefInfo | LocalRef, target: str):
        assert target is not None
        assert target not in self._targets, "two targets with the same name"
        self._targets[target] = target_ref
        self._resolve(target)

    def add_reference(self, link: CrossRef, target: str) -> None:
        self._references.setdefault(target, []).append(link)
        self._resolve(target)

    def _resolve(self, target: str) -> None:
        if (target in self._targets) and (target in self._references):
            for link in self._references[target]:
                link.reference = self._targets[target]
            self._references[target] = []


RESOLVER = DelayedResolver()


def resolve_(
    qa: str,
    known_refs: frozenset[RefInfo],
    local_refs: frozenset[str],
    ref: str,
    rev_aliases: dict[Cannonical, FullQual],
) -> RefInfo:
    """
    Given the current context (qa), and a str (ref), compute the RefInfo object.

    References are often relative based on the current context (which object you
    are currently in).

    Given this information and all the local (same document) and global
    (same library/all libraries) references, compute the Reference Info object.

    Parameters
    ----------
    qa : str
        fully qualified path of the current object (.value).
        TODO: this will be weird for non object, like example.
    known_refs : list of RefInfo
        All the known objects we can refer to in current universe.
    local_refs : list of str
        All the current objects in current scope (same docstring).
    ref : str
        ???
    rev_aliases
        Reverse alias map. As the import name of object may not be the
        fully qualified names, we may need a reverse alias map to resolve
        with respect to the import name.

    """

    # RefInfo(module, version, kind, path)
    hk = hash(known_refs)
    hash(local_refs)
    assert rev_aliases is not None
    ref = Cannonical(ref)
    if ref in rev_aliases:
        new_ref = rev_aliases[ref]
        assert new_ref not in rev_aliases, "would loop...."
        # TODO: likely can drop rev_aliases here
        res = resolve_(qa, known_refs, local_refs, new_ref, rev_aliases)
        return res

    assert isinstance(ref, str), ref

    # TODO: LRU Cache seem to have speed problem here; and get slow while this should be just fine.
    # this seem to be due to the fact that even if the hash is the same this still needs to compare the objects, as
    # those may have been muted.
    if hk not in _cache:
        _cache[hk] = _build_resolver_cache(known_refs)

    # this is a mapping from the key to the most relevant
    # Refinfo to a document
    k_path_map: dict[str, RefInfo]

    # hashable for caching /optimisation.
    keyset: frozenset[str]

    k_path_map, keyset = _cache[hk]

    if ref.startswith("builtins."):
        return RefInfo(None, None, "missing", ref)
    if ref.startswith("str."):
        return RefInfo(None, None, "missing", ref)
    if ref in {"None", "False", "True"}:
        return RefInfo(None, None, "missing", ref)
    # here is sphinx logic.
    # https://www.sphinx-doc.org/en/master/_modules/sphinx/domains/python.html?highlight=tilde
    # tilda ~ hide the module name/class name
    # dot . search more specific first.
    if ref.startswith("~"):
        ref = ref[1:]
    if ref in local_refs:
        return RefInfo(None, None, "local", ref)
    if ref in k_path_map:
        # get the more recent.
        # stuff = {k for k in known_refs if k.path == ref}
        # c2 = list(sorted(stuff, key=lambda x: x.version))[-1]
        # assert isinstance(c2, RefInfo), c2
        # assert k_path_map[ref] == c2
        return k_path_map[ref]
    else:
        if ref.startswith("."):
            if (found := qa + ref) in k_path_map:
                return k_path_map[found]
            else:
                root = qa.split(".")[0]
                sub1 = root_start(root, keyset)
                subset = endswith(ref, sub1)
                if len(subset) == 1:
                    return k_path_map[next(iter(subset))]
                    # return RefInfo(None, None, "exists", next(iter(subset)))
                else:
                    if len(subset) > 1:
                        # ambiguous ref
                        pass

                return RefInfo(None, None, "missing", ref)

        parts = qa.split(".")
        for i in range(len(parts)):
            attempt = ".".join(parts[:i]) + "." + ref
            if attempt in k_path_map:
                return k_path_map[attempt]

    q0 = qa.split(".")[0]
    rs = root_start(q0, keyset)
    attempts = [q for q in rs if (ref in q)]
    if len(attempts) == 1:
        # return RefInfo(None, None, "exists", attempts[0])
        return k_path_map[attempts[0]]
    else:
        trail = [q for q in attempts if q.split(".")[-1] == ref]
        if len(trail) == 1:
            return k_path_map[trail[0]]

    return RefInfo(None, None, "missing", ref)


class TreeVisitor:
    def __init__(self, find):
        self.skipped = set()
        self.find = find

    def generic_visit(self, node):
        from .nodes import Options, ThematicBreak

        name = node.__class__.__name__
        if method := getattr(self, "visit_" + name, None):
            return method(node)
        elif hasattr(node, "children"):
            acc: dict[Any, list[Any]] = {}
            for c in node.children:
                if c is None or isinstance(c, (str, bool)):
                    continue
                assert c is not None, f"{node=} has a None child"
                assert isinstance(c, Node), repr(c)
                if type(c) in self.find:
                    acc.setdefault(type(c), []).append(c)
                else:
                    for k, v in self.generic_visit(c).items():
                        acc.setdefault(k, []).extend(v)
            return acc
        elif hasattr(node, "reference"):
            acc = {}
            for c in [node.reference]:
                if c is None or isinstance(c, (str, bool)):
                    continue
                assert c is not None, f"{node=} has a None child"
                assert isinstance(c, Node), repr(c)
                if type(c) in self.find:
                    acc.setdefault(type(c), []).append(c)
                else:
                    for k, v in self.generic_visit(c).items():
                        acc.setdefault(k, []).extend(v)
            return acc

        elif hasattr(node, "value"):
            if type(node) not in self.skipped:
                self.skipped.add(type(node))
            return {}
        elif isinstance(
            node,
            (
                LocalRef,
                RefInfo,
                Options,
                ThematicBreak,
                SubstitutionDef,
                CitationReference,
            ),
        ):
            return {}
        else:
            raise ValueError(f"{node.__class__} has no children, no values {node}")


class TreeReplacer:
    """
    Tree visitor with methods to replace nodes.

    define replace_XXX(xxx) that return a list of new nodes, and call visit(and the root tree)
    """

    _replacements: Counter

    def __init__(self):
        self._replacements = Counter()

    def visit(self, node):
        self._replacements = Counter()
        self._cr = 0
        assert not isinstance(node, list), node
        assert node is not None
        res = self.generic_visit(node)
        assert len(res) == 1, res
        return res[0]

    def _call_method(self, method, node):
        return method(node)

    def generic_visit(self, node) -> list[Node]:
        assert node is not None
        assert not isinstance(node, str)
        assert isinstance(node, Node), node
        try:
            name = node.__class__.__name__
            if vmethod := getattr(self, "visit_" + name, None):
                res = vmethod(node)
                assert res is None, (
                    f"did you meant to implement replace_{name} instead of visit_{name} ?"
                )
            if method := getattr(self, "replace_" + name, None):
                self._replacements.update([name])
                new_nodes = self._call_method(method, node)
            elif name in [
                "Code",
                "Comment",
                "Example",
                "Figure",
                "GenCode",
                "Image",
                "InlineCode",
                "InlineMath",
                "InlineRole",
                "Math",
                "Options",
                "SeeAlsoItem",
                "SubstitutionRef",
                "Text",
                "ThematicBreak",
                "Unimplemented",
                "CrossRef",
                "CitationReference",
            ]:
                return [node]
            else:
                new_children = []
                if not hasattr(node, "children"):
                    raise ValueError(f"{node.__class__} has no children {node}")
                for c in node.children:
                    assert c is not None, f"{node=} has a None child"
                    assert isinstance(c, Node), c
                    replacement = self.generic_visit(c)
                    assert isinstance(replacement, list)

                    new_children.extend(replacement)
                if node.children != new_children:
                    self._cr += 1
                node.children = new_children
                new_nodes = [node]
            assert isinstance(new_nodes, list)
            return new_nodes
        except Exception as e:
            e.add_note(f"visiting {node=}")
            raise


# misc thoughts:
# we will have multiplet type of directive handlers
# from the simpler to more complex.
# handler that want to parse/handle everything by themsleves,
# other that don't care about domain/role.


Handler = Callable[[str], list[Node]]

DIRECTIVE_MAP: dict[str, dict[str, list[Handler]]] = {}
BLOCK_DIRECTIVE_MAP: dict[str, dict[str, list[Handler]]] = {}


def directive_handler(domain, role):
    def _inner(func):
        DIRECTIVE_MAP.setdefault(domain, {}).setdefault(role, []).append(func)
        return func

    return _inner


def block_directive_handler(domain, role):
    def _inner(func):
        DIRECTIVE_MAP.setdefault(domain, {}).setdefault(role, []).append(func)
        return func

    return _inner


def _x_any_unimplemented_to_verbatim(domain, role, value):
    return [InlineCode(value)]


# C-domain roles: we don't index C symbols, so resolve can never succeed —
# emit verbatim InlineCode directly.
for role in ("type", "expr", "member", "macro", "enumerator", "func", "data"):
    directive_handler("c", role)(
        lambda value, _role=role: _x_any_unimplemented_to_verbatim("c", _role, value)
    )

# Formatting-only roles: these are not cross-references, they just affect
# visual rendering (sub/superscript, keyboard keys, filenames, literals, ...).
# Emit verbatim InlineCode so they never enter the resolve path — it would
# always fail and pollute the "missing" diagnostics.
_PY_VERBATIM_ROLES = (
    "command",
    "enabled",
    "file",
    "kbd",
    "keyword",
    "program",
    "rc",  # matplotlib
    "samp",  # networkx, ipython
    "sub",
    "sup",
    "term",
)

# Cross-reference roles (any/attr/class/const/data/exc/func/meth/method/mod/obj
# and the C-domain equivalents) are handled by the resolve path in
# ``DirectiveVisiter.replace_InlineRole``; registering a verbatim handler here
# would short-circuit that path and prevent crosslinks from ever being
# generated.  ``ref`` (section-label refs) also falls through: if resolve can't
# find the target the original ``InlineRole`` is returned and rendered as
# styled code, matching the previous verbatim appearance.
for role in _PY_VERBATIM_ROLES:
    directive_handler("py", role)(
        lambda value, _role=role: _x_any_unimplemented_to_verbatim("py", _role, value)
    )


# TODO: make that a plugin/extension/generic to the project.
@directive_handler("py", "ghpull")
def py_ghpull_handler(value):
    return [
        Link(
            children=[Text(f"#{value}")],
            url=f"https://github.com/ipython/ipython/pull/{value}",
            title="",
        )
    ]


# TODO: make that a plugin/extension/generic to the project.
@directive_handler("py", "ghissue")
def py_ghissue_handler(value):
    return [
        Link(
            children=[Text(f"#{value}")],
            url=f"https://github.com/ipython/ipython/issue/{value}",
            title="",
        )
    ]


@directive_handler("py", "math")
def py_math_handler(value):
    m = InlineMath(value)
    return [m]


@directive_handler("py", "pep")
def py_pep_hander(value):
    number = int(value)
    target = f"https://peps.python.org/pep-{number:04d}/"
    return [
        Link(
            children=[Text(f"Pep {number}")],
            url=target,
            title="",
        )
    ]


@directive_handler("py", "doc")
def py_doc_handler(value):
    text = value
    path = value
    if " <" in value and value.endswith(">"):
        text, path = value.split(" <", 1)
        text = text.rstrip()
        path = path.rstrip(">")
    return [CrossRef(text, LocalRef("docs", path), "docs")]


_MISSING_DIRECTIVES: list[str] = []

_SPHINX_ONLY_DIRECTIVES: frozenset[str] = frozenset(
    {
        "autofunction",
        "autoclass",
        "automodule",
        "automethod",
        "autoattribute",
        "autodata",
        "autoexception",
        "ipython",
        "ipython3",
    }
)


class DirectiveVisiter(TreeReplacer):
    """
    A tree replacer to update directives.

    """

    def __init__(
        self,
        qa: str,
        known_refs: frozenset[RefInfo],
        local_refs,
        aliases,
        version,
        config=None,
        module: str | None = None,
    ):
        """
        qa: str
            current object fully qualified name
        known_refs: set of RefInfo
            list of all currently know objects
        locals_refs :
            pass
        aliases :
            pass
        version : str
            current version when linking
        module : str, optional
            root module name being documented; derived from qa when omitted

        """
        assert isinstance(qa, str), qa
        assert isinstance(known_refs, (set, frozenset)), known_refs
        assert isinstance(local_refs, (set, frozenset)), local_refs

        self._handlers = {
            "math": block_math_handler,
            "warning": warning_handler,
            "note": note_handler,
            "versionadded": versionadded_handler,
            "versionchanged": versionchanged_handler,
            "deprecated": deprecated_handler,
        }

        for k, v in (config or {}).items():
            self._handlers[k] = obj_from_qualname(v)

        self.known_refs = frozenset(known_refs)
        self.local_refs = frozenset(local_refs)
        self.qa = qa
        self.module: str = module if module is not None else qa.split(".")[0]
        self.local: list[str] = []
        self.total: list[tuple[Any, str]] = []
        # long -> short
        self.aliases: dict[str, str] = aliases
        # short -> long
        self.rev_aliases = {v: k for k, v in aliases.items()}
        self._targets: set[Any] = set()
        self.version = version
        self._tocs: Any = []
        # Keyed by RST name with pipes (e.g. '|foo|').  Populated by
        # collect_substitutions() before visiting; can be pre-seeded with
        # config-level global substitutions.
        self._substitutions: dict[str, list] = {}

    def collect_substitutions(self, *sections: Section) -> None:
        """Pre-scan sections for SubstitutionDef nodes to build the substitution map.

        Call this on all sections that will be visited *before* calling visit(),
        so that refs are resolved even when the def appears after the ref in
        document order.
        """
        for section in sections:
            for node in section.children:
                if not isinstance(node, SubstitutionDef):
                    continue
                child = node.children[0] if node.children else None
                if isinstance(child, UnprocessedDirective) and child.name == "replace":
                    replacement_text = child.args or ""
                    self._substitutions[node.value] = (
                        [Text(replacement_text)] if replacement_text else []
                    )
                else:
                    directive_name = (
                        child.name
                        if isinstance(child, UnprocessedDirective)
                        else type(child).__name__
                    )
                    log.warning(
                        "substitution %r uses unsupported directive %r in %s; dropping",
                        node.value,
                        directive_name,
                        self.qa,
                    )

    def replace_SubstitutionDef(self, node: SubstitutionDef) -> list:
        return []

    def replace_SubstitutionRef(self, node: SubstitutionRef) -> list:
        name = node.value  # e.g. '|foo|'
        if name in self._substitutions:
            return list(self._substitutions[name])
        log.warning("unresolved substitution reference %r in %s", name, self.qa)
        inner = name[1:-1] if name.startswith("|") and name.endswith("|") else name
        return [Text(inner)]

    def replace_GenCode(self, code):
        """Flatten a GenCode intermediate into a plain Code node."""
        code_ = "".join([entry.value for entry in code.entries])
        status = (
            code.ce_status.value if hasattr(code.ce_status, "value") else code.ce_status
        )
        return [Code(code_, status)]

    def _block_verbatim_helper(self, name: str, argument: str, options: dict, content):
        data = f".. {name}:: {argument}\n"
        for k, v in options.items():
            data = data + f"    :{k}:{v}\n"
        data = data + indent(content, "    ")
        return [Code(data)]

    def _autosummary_handler(self, argument, options: dict, content):
        # assert False
        return self._block_verbatim_helper("autosummary", argument, options, content)

    def _code_handler(
        self, argument: str, options: dict[str, str], content: str
    ) -> list[Code]:
        return [Code(content)]

    def _toctree_handler(self, argument, options, content):
        # argument is ignored (rare cases like ``.. toctree:: My Title``).
        toc = []
        lls = []

        glob = options.get("glob") if isinstance(options, dict) else False

        for line in content.splitlines():
            line = line.strip()
            # Skip blank lines, comments, and the special "self" entry.
            if not line or line.startswith("..") or line == "self":
                continue
            # Skip glob patterns — we don't expand them at gen time.
            if glob and ("*" in line or "?" in line):
                continue

            if "<" in line and line.endswith(">"):
                # "Title Text <path>" form — split on last " <".
                try:
                    title, url = line[:-1].rsplit(" <", 1)
                    title = title.strip()
                except ValueError:
                    continue
                toc.append([title, url])
                link = CrossRef(
                    title,
                    reference=RefInfo(module="", version="", kind="?", path=url),
                    kind="exists",
                    anchor=None,
                )
                RESOLVER.add_reference(link, url)
                lls.append(link)
            elif "<" not in line:
                toc.append([None, line])
                link = CrossRef(
                    line,
                    reference=RefInfo(module="", version="", kind="?", path=line),
                    kind="exists",
                    anchor=None,
                )
                RESOLVER.add_reference(link, line)
                lls.append(link)
            # Lines with "<" but not ending ">" are malformed — skip with a warning.
            else:
                log.warning("toctree: skipping malformed entry %r", line)

        self._tocs.append(toc)

        acc = [ListItem(False, [Paragraph([line])]) for line in lls]
        return [BulletList(ordered=False, start=1, spread=False, children=acc)]

    def replace_UnprocessedDirective(self, directive: UnprocessedDirective):
        meth = getattr(self, "_" + directive.name + "_handler", None)
        if meth is None:
            meth = self._handlers.get(directive.name, None)
        if meth:
            # TODO: we may want to recurse here on returned items.
            res = meth(
                directive.args,
                directive.options,
                directive.value,
            )
            assert isinstance(res, list)
            acc = []
            for a in res:
                # I believe here we may want to wrap things in Paragraph  and comact words ?
                tr = self.generic_visit(a)
                acc.extend(tr)
            return acc

        if directive.name in _SPHINX_ONLY_DIRECTIVES:
            log.warning(
                "skipping Sphinx-only directive %r in %s (not meaningful outside a Sphinx build)",
                directive.name,
                self.qa,
            )
            return []

        if directive.name not in _MISSING_DIRECTIVES:
            _MISSING_DIRECTIVES.append(directive.name)
            log.debug("TODO: %s", directive.name)

        return [Directive.from_unprocessed(directive)]

    def _resolve(self, loc, text):
        """
        Resolve `text` within local references `loc`

        """
        assert isinstance(text, str)
        return resolve_(
            self.qa, self.known_refs, loc, text, rev_aliases=self.rev_aliases
        )

    @classmethod
    def _import_solver(cls, maybe_qa: str):
        parts = maybe_qa.split(".")
        are_id = [x.isidentifier() for x in parts]

        if not all(are_id):
            return None
        else:
            target_qa = full_qual(_obj_from_path(parts))
            if target_qa is not None:
                return target_qa

    def replace_InlineRole(self, directive: InlineRole):
        domain, role = directive.domain, directive.role
        if domain is None:
            domain = "py"
        if role is None:
            role = "py"
        domain_handler: dict[str, list[Handler]] = DIRECTIVE_MAP.get(domain, {})
        handlers: list[Handler] = domain_handler.get(role, [])
        for h in handlers:
            res = h(directive.value)
            if res is not None:
                return res

        loc: frozenset[str]
        loc = frozenset() if directive.role not in ["any", None] else self.local_refs
        text = directive.value
        assert "`" not in text
        text = text.replace("\n", " ")
        to_resolve = text

        if (
            ("<" in text)
            and text.endswith(">")
            and " <" not in text
            and "\n<" not in text
        ):
            pass  # assert False, ("error space-< in", self.qa, directive)
        if ((" <" in text) and text.endswith(">")) or (
            ("\n <" in text) and text.endswith(">")
        ):
            try:
                text, to_resolve = text.split(" <")
                text = text.rstrip()
            except ValueError as e:
                raise AssertionError(directive.value) from e
            assert to_resolve.endswith(">"), (text, to_resolve)
            to_resolve = to_resolve.rstrip(">")

        if to_resolve.startswith("~"):
            stripped = to_resolve[1:]
            if text == to_resolve:
                text = stripped.split(".")[-1]
            to_resolve = stripped

        if to_resolve.startswith(("https://", "http://", "mailto://")):
            to_resolve = to_resolve.replace(" ", "")
            return [
                Link(
                    children=[Text(text)],
                    url=to_resolve,
                    title="",
                )
            ]

        r = self._resolve(loc, to_resolve)
        # this is now likely incorrect as Ref kind should not be exists,
        # but things like "local", "api", "gallery..."
        ref, exists = r.path, r.kind
        if exists != "missing":
            if exists == "local":
                self.local.append(text)
            else:
                self.total.append((text, ref))
            if r.kind != "local":
                assert None not in r, r
                self._targets.add(r)
            return [CrossRef(text, r, exists)]
        if (directive.domain, directive.role) in [
            (None, None),
            (None, "mod"),
            (None, "func"),
            (None, "any"),
            (None, "meth"),
            (None, "class"),
        ]:
            text = directive.value
            tqa = directive.value

            if text.startswith("@"):
                tqa = tqa[1:]
            if text.startswith("~"):
                tqa = tqa[1:]
                text = tqa.split(".")[-1]
            # TODO: this may not be correct, is it's start with `.` it should be relative to current object.
            if tqa.startswith("."):
                tqa = tqa[1:]
            if tqa.endswith("()"):
                tqa = tqa[:-2]

            target_qa = self._import_solver(tqa)
            if target_qa is not None:
                if target_qa.split(".")[0] == self.qa.split("."):
                    raise AssertionError(
                        "local reference should have explicit versions"
                    )
                module = target_qa.split(":")[0].split(".")[0]
                ri = RefInfo(
                    module=module,
                    version="*",
                    kind="api",
                    path=target_qa,
                )
                return [CrossRef(text, ri, "module")]
        else:
            pass
        return [directive]


def _import_max(parts):
    p = parts[0]
    try:
        __import__(p)
    except (ImportError, RuntimeError):
        return
    for k in parts[1:]:
        p = p + "." + k
        try:
            __import__(p)
        except (ImportError, RuntimeError):
            return
        except Exception as e:
            raise type(e)(parts) from e


def _obj_from_path(parts):
    _import_max(parts)
    try:
        target = __import__(parts[0])
        for p in parts[1:]:
            target = getattr(target, p)
    except Exception:
        return
    return target


class GenVisitor(DirectiveVisiter):
    def visit_Section(self, node):
        if node.target:
            RESOLVER.add_target(LocalRef("docs", node.target), node.target)

    def replace_Fig(self, fig):
        # todo: add version number here
        self._targets.add(fig.value)

        return [fig]


class IngestVisitor(DirectiveVisiter):
    def replace_GenCode(self, code):
        raise NotImplementedError

    def replace_RefInfo(self, refinfo):
        log.debug("RefInfo: %r", refinfo)
        return [refinfo]

    def replace_CrossRef(self, ref):
        if isinstance(ref.reference, LocalRef) and ref.reference.kind == "docs":
            ri = RefInfo(self.module, self.version, "docs", ref.reference.path)
            self._targets.add(ri)
            return [CrossRef(ref.value, ri, ref.kind)]
        if isinstance(ref.reference, RefInfo) and ref.reference.kind == "api":
            # "api"-kind stubs are produced by the import-solver at gen time
            # (version="*", kind="api"). Resolve them against known_refs so the
            # stored forward-ref edge points at the real versioned module doc.
            resolved = resolve_(
                self.qa,
                self.known_refs,
                frozenset(),
                ref.reference.path,
                rev_aliases=self.rev_aliases,
            )
            if resolved.kind not in ("missing", "local"):
                self._targets.add(resolved)
                return [CrossRef(ref.value, resolved, ref.kind)]
        return [ref]

    def replace_BlockDirective(self, block_directive: Directive):
        raise AssertionError("should be unreachable")
