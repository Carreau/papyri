from __future__ import annotations

import json
import logging
import shutil
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cbor2
from rich.logging import RichHandler

from .config import ingest_dir
from .gen import GeneratedDoc, _OrderedDictProxy, normalise_ref
from .graphstore import GraphStore, Key
from .node_base import Node, register
from .nodes import (
    Figure,
    RefInfo,
    Section,
    SeeAlsoItem,
    encoder,
)
from .signature import SignatureNode
from .tree import IngestVisitor, TreeVisitor, resolve_
from .utils import Cannonical, FullQual, dummy_progress, progress

warnings.simplefilter("ignore", UserWarning)


FORMAT = "%(message)s"
logging.basicConfig(
    level="INFO", format=FORMAT, datefmt="[%X]", handlers=[RichHandler()]
)

log = logging.getLogger("papyri")


def find_all_refs(
    graph_store: GraphStore,
) -> frozenset[RefInfo]:
    """
    Given a graph store, return a (frozenset of all RefInfo)

    """
    assert isinstance(graph_store, GraphStore)
    o_family = sorted(list(graph_store.glob((None, None, "module", None))))

    known_refs: set[RefInfo] = set()
    for item in o_family:
        known_refs = known_refs | {
            RefInfo(item.module, item.version, "module", item.path)
        }
    return frozenset(known_refs)


@register(4010)
@dataclass
class IngestedDoc(Node):
    __slots__ = (
        "_content",
        "_ordered_sections",
        "item_file",
        "item_line",
        "item_type",
        "aliases",
        "example_section_data",
        "see_also",
        "signature",
        "references",
        "qa",
        "arbitrary",
    )

    _content: dict[str, Section]
    _ordered_sections: list[str]
    item_file: str | None
    item_line: int | None
    item_type: str | None
    aliases: list[str]
    example_section_data: Section
    see_also: list[SeeAlsoItem]  # see also data
    signature: SignatureNode | None
    references: list[str] | None
    qa: str
    arbitrary: list[Section]

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._dp = _OrderedDictProxy(self._ordered_sections, self._content)

    @property
    def ordered_sections(self):
        return tuple(self._ordered_sections)

    @property
    def content(self):
        """
        A property to the dict proxy
        """
        return self._dp

    @classmethod
    def new(cls):
        return cls({}, [], None, None, None, [], None, None, None, None, None, None)

    def all_forward_refs(self) -> list[Key]:
        visitor = TreeVisitor({RefInfo, Figure})
        res: dict[Any, list[Any]] = {}
        for sec in (
            list(self.content.values())
            + [self.example_section_data]
            + self.arbitrary
            + self.see_also
        ):
            for k, v in visitor.generic_visit(sec).items():
                res.setdefault(k, []).extend(v)

        assets_II = {Key(*f.value) for f in res.get(Figure, [])}
        ssr = set([Key(*r) for r in res.get(RefInfo, []) if r.kind != "local"]).union(
            assets_II
        )
        return list(sorted(ssr))

    def process(
        self, known_refs, aliases: dict[str, str] | None, verbose=True, *, version
    ) -> None:
        """
        Process a doc blob, to find all local and nonlocal references.
        """
        assert isinstance(known_refs, frozenset)
        assert self.content is not None
        assert aliases is not None
        sections_ = [
            "Parameters",
            "Returns",
            "Raises",
            "Yields",
            "Attributes",
            "Other Parameters",
            "Warns",
            ##
            "Warnings",
            "Methods",
            # "Summary",
            "Receives",
            # "Notes",
            # "Signature",
            #'Extended Summary',
            #'References'
            #'See Also'
            #'Examples'
        ]

        # local_refs (parameter names extracted from the sections above) are
        # pre-computed by GenVisitor at gen time; IngestVisitor.replace_InlineRole
        # currently does not resolve inline roles, so we pass an empty set here.
        # When that is eventually fixed, precompute local_refs in gen and store
        # them in GeneratedDoc rather than re-extracting here.
        visitor = IngestVisitor(
            self.qa, known_refs, frozenset(), aliases, version=version, config={}
        )
        for section in ["Extended Summary", "Summary", "Notes"] + sections_:
            if section not in self.content:
                continue
            assert section in self.content
            self.content[section] = visitor.visit(self.content[section])
        if (len(visitor.local) or len(visitor.total)) and verbose:
            # TODO: visitor.local should ideally be empty here (local
            # refs were meant to be resolved earlier), but many bundles
            # still carry them. Re-enabling that invariant requires a
            # pass through the gen-time local-ref resolution first.
            log.info("Newly found %s links in %s", len(visitor.total), repr(self.qa))
            for a, b in visitor.total:
                log.info("     %s refers to %s", repr(a), repr(b))

        self.example_section_data = visitor.visit(self.example_section_data)

        self.arbitrary = [visitor.visit(s) for s in self.arbitrary]

        for d in self.see_also:
            new_desc = []
            for dsc in d.descriptions:
                new_desc.append(visitor.visit(dsc))
            d.descriptions = new_desc
        for r in visitor._targets:
            assert None not in r, r


def load_one_uningested(
    bytes_: bytes,
    qa: str,
    known_refs,
    aliases: dict[str, str],
    *,
    version: str | None,
) -> IngestedDoc:
    """
    Decode a CBOR-encoded GeneratedDoc from the gen bundle and make it an ingested
    blob.
    """
    assert isinstance(bytes_, bytes)

    old_data = encoder.decode(bytes_)
    assert isinstance(old_data, GeneratedDoc), type(old_data)
    assert hasattr(old_data, "arbitrary")

    blob = IngestedDoc.new()
    blob.qa = qa

    for k in old_data.slots():
        setattr(blob, k, getattr(old_data, k))

    blob.process(known_refs=known_refs, aliases=aliases, verbose=False, version=version)

    return blob  # type: ignore[no-any-return]


class Ingester:
    def __init__(self, dp):
        self.ingest_dir = ingest_dir
        self.gstore = GraphStore(self.ingest_dir)
        self.progress = dummy_progress if dp else progress

    def _ingest_logo(
        self, path: Path, root: str, version: str, logo_name: str, gstore: GraphStore
    ) -> str | None:
        """Copy a gen bundle's logo asset into the ingest store's meta dir.

        Returns the basename the viewer should fetch under
        ``<pkg>/<ver>/meta/``, or ``None`` if the source asset is missing.
        """
        src = path / "assets" / logo_name
        if not src.exists():
            return None
        ext = Path(logo_name).suffix
        dest_name = f"logo{ext}" if ext else "logo"
        gstore.put(Key(root, version, "meta", dest_name), src.read_bytes(), [])
        return dest_name

    def _ingest_narrative(self, path, gstore: GraphStore) -> None:
        meta = json.loads((path / "papyri.json").read_text())
        version = meta["version"]
        module = meta.get("module") or path.name.split("_")[0]
        for _console, document in self.progress(
            (path / "docs").glob("*"),
            description=f"{path.name} Reading narrative docs ",
        ):
            try:
                doc = load_one_uningested(
                    document.read_bytes(),
                    qa=document.name,
                    known_refs=frozenset(),
                    aliases={},
                    version=version,
                )
            except Exception as e:
                e.add_note(f"at path: {document}")
                raise
            ref = document.name

            key = Key(module, version, "docs", ref)
            doc.validate()

            # Resolve LocalRef("docs", path) CrossRef nodes → RefInfo so
            # the graph store can track doc-to-doc forward references.
            visitor = IngestVisitor(
                ref, frozenset(), frozenset(), {}, version=version, module=module
            )
            doc.arbitrary = [visitor.visit(s) for s in doc.arbitrary]
            forward_refs = [Key(*t) for t in visitor._targets]

            gstore.put(
                key,
                encoder.encode(doc),
                forward_refs,
            )
        tocfile = path / "toc.cbor"
        if tocfile.exists():
            gstore.put(
                Key(module, version, "meta", "toc.cbor"),
                tocfile.read_bytes(),
                [],
            )

    def _ingest_examples(
        self, path: Path, gstore: GraphStore, known_refs, aliases, version, root
    ):
        for _, fe in self.progress(
            (path / "examples/").glob("*"),
            description=f"{path.name} Reading Examples ...   ",
        ):
            s = encoder.decode(fe.read_bytes())
            assert isinstance(s, Section), type(s)
            visitor = IngestVisitor(
                f"TBD (examples, {path}), supposed to be QA",
                known_refs,
                set(),
                aliases,
                version=version,
                config={},
            )
            s_code = visitor.visit(s)
            refs = list(map(lambda s: Key(*s), visitor._targets))
            try:
                gstore.put(
                    Key(root, version, "examples", fe.name),
                    encoder.encode(s_code),
                    refs,
                )
            except Exception:
                raise

    def _ingest_assets(self, path, root, version, aliases, gstore):
        for _, f2 in self.progress(
            (path / "assets").glob("*"),
            description=f"{path.name} Reading image files ...",
        ):
            gstore.put(Key(root, version, "assets", f2.name), f2.read_bytes(), [])

        gstore.put(
            Key(root, version, "meta", "aliases.cbor"),
            cbor2.dumps(aliases),
            # json.dumps(aliases, indent=2).encode(),
            [],
        )

    def ingest(self, path: Path, check: bool) -> None:
        gstore = self.gstore

        known_refs = find_all_refs(gstore)

        nvisited_items = {}

        ###

        meta_path = path / "papyri.json"
        data = json.loads(meta_path.read_text())
        version = data["version"]
        root = data["module"]
        # long : short
        aliases: dict[str, str] = data.get("aliases", {})
        # rev_aliases = {Cannonical(v): FullQual(k) for k, v in aliases.items()}
        meta = {k: v for k, v in data.items() if k != "aliases"}

        self._ingest_examples(path, gstore, known_refs, aliases, version, root)
        self._ingest_assets(path, root, version, aliases, gstore)
        # Copy the logo (if any) into <pkg>/<ver>/meta/logo.<ext> so the viewer
        # can fetch it without sniffing the asset dir. ``meta["logo"]`` is
        # rewritten to the stable basename under meta/ (viewers read from the
        # ingest store, not the gen bundle).
        gen_logo = meta.get("logo")
        if isinstance(gen_logo, str) and gen_logo:
            meta["logo"] = self._ingest_logo(path, root, version, gen_logo, gstore)
        try:
            self._ingest_narrative(path, gstore)
        except Exception as e:
            e.add_note(f"at {path}")
            raise

        for _, f1 in self.progress(
            (path / "module").glob("*"),
            description=f"{path.name} Reading api files ...  ",
        ):
            assert f1.name.endswith(".cbor")
            qa = f1.name[:-5]
            if check:
                rqa = normalise_ref(qa)
                if rqa != qa:
                    # numpy weird thing
                    log.debug("skip qa=%r, rqa=%r", qa, rqa)
                    continue
                assert rqa == qa, f"{rqa} !+ {qa}"
            try:
                # TODO: version issue
                nvisited_items[qa] = load_one_uningested(
                    f1.read_bytes(),
                    qa=qa,
                    known_refs=known_refs,
                    aliases=aliases,
                    version=version,
                )
                assert hasattr(nvisited_items[qa], "arbitrary")
            except Exception as e:
                e.add_note(f"error Reading to {f1}")
                raise

        # TODO: crosslink still needs per-reference version information to
        # support cross-package linking correctly. See TODO-review.md.

        for _, (qa, doc_blob) in self.progress(
            nvisited_items.items(), description=f"{path.name} Validating..."
        ):
            for k, v in doc_blob.content.items():
                assert isinstance(v, Section), f"section {k} is not a Section: {v!r}"
            try:
                doc_blob.validate()
            except Exception as e:
                raise type(e)(f"from {qa}") from e
            if ":" in qa:
                qa, _ = qa.split(":")
            mod_root = qa.split(".")[0]
            assert mod_root == root, f"{mod_root}, {root}"
        for _, (qa, doc_blob) in self.progress(
            nvisited_items.items(), description=f"{path.name} Writing..."
        ):
            # we might update other modules with backrefs
            assert hasattr(doc_blob, "arbitrary")

            # TODO: Figure references carry a RefInfo whose version may be
            # unknown at walk time; a proper fix populates the version
            # during serialisation so cross-package figure links resolve.
            forward_refs = doc_blob.all_forward_refs()

            try:
                key = Key(mod_root, version, "module", qa)
                assert mod_root is not None
                assert version is not None
                assert None not in key
                gstore.put(
                    key,
                    encoder.encode(doc_blob),
                    forward_refs,
                )

            except Exception as e:
                raise RuntimeError(f"error writing to {path}") from e

        gstore.put_meta(root, version, encoder.encode(meta))

    def relink(self) -> None:
        gstore = self.gstore
        known_refs = find_all_refs(gstore)
        aliases: dict[str, str] = {}
        for key in gstore.glob((None, None, "meta", "aliases.cbor")):
            aliases.update(cbor2.loads(gstore.get(key)))

        rev_aliases = {Cannonical(v): FullQual(k) for k, v in aliases.items()}

        print("Relinking is safe to cancel, but some back references may be broken....")
        print("Press Ctrl-C to abort...")

        for _, key in self.progress(
            gstore.glob((None, None, "module", None)), description="Relinking..."
        ):
            try:
                data, back, forward = gstore.get_all(key)
            except Exception as e:
                raise ValueError(str(key)) from e
            try:
                doc_blob = encoder.decode(data)
                assert isinstance(doc_blob, IngestedDoc)
            except Exception as e:
                raise type(e)(key) from e
            assert doc_blob.content is not None, data

            for sa in doc_blob.see_also:
                if sa.name.exists:
                    continue
                r = resolve_(
                    key.path,
                    known_refs,
                    frozenset(),
                    sa.name.value,
                    rev_aliases=rev_aliases,
                )
                if r.kind == "module":
                    log.debug("unresolved ok... %r %r", r, key)
                    # `exists` is derived from `reference.kind`; updating the
                    # reference to a resolved RefInfo is enough.
                    sa.name.reference = r

            # end todo

            data = encoder.encode(doc_blob)
            for s in forward:
                assert isinstance(s, Key)
            forward_refs = set(forward)
            ss2 = doc_blob.all_forward_refs()
            if ss2 != forward_refs:
                gstore.put(key, data, forward_refs)

        for _, key in progress(
            gstore.glob((None, None, "examples", None)),
            description="Relinking Examples...",
        ):
            s = encoder.decode(gstore.get(key))
            assert isinstance(s, Section), (s, key)
            dvr = IngestVisitor(
                f"TBD, supposed to be QA relink {key}",
                known_refs,
                set(),
                aliases,
                version="?",
            )
            s_code = dvr.visit(s)
            refs = [Key(*x) for x in dvr._targets]
            gstore.put(
                key,
                encoder.encode(s_code),
                refs,
            )


def drop():
    """remove all ingested files and db"""
    print("removing all files...")
    shutil.rmtree(ingest_dir)


def main(path, check, *, dummy_progress):
    """
    Parameters
    ----------
    dummy_progress : bool
        whether to use a dummy progress bar instead of the rich one.
        Usefull when dropping into PDB.
        To be implemented. See gen step.
    check : <Insert Type here>
        <Multiline Description Here>
    path : <Insert Type here>
        <Multiline Description Here>
    """
    print("Ingesting", path.name, "...")
    from time import perf_counter

    now = perf_counter()

    assert path.exists(), f"{path} does not exists"
    assert path.is_dir(), f"{path} is not a directory"
    Ingester(dp=dummy_progress).ingest(path, check)
    delta = perf_counter() - now

    print(f"{path.name} Ingesting done in {delta:0.2f}s")


def relink(dummy_progress):
    Ingester(dp=dummy_progress).relink()
