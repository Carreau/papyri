import json
import os
from collections import defaultdict
from pathlib import Path
from there import print

from jinja2 import Environment, FileSystemLoader, select_autoescape
from quart_trio import QuartTrio

from .config import html_dir, ingest_dir
from .crosslink import load_one, resolve_, IngestedBlobs
from .stores import BaseStore, GHStore, Store
from .take2 import Lines, Paragraph, make_block_3
from .utils import progress


class CleanLoader(FileSystemLoader):
    """
    A loader for ascii/ansi that remove all leading spaces and pipes  until the last pipe.
    """

    def get_source(self, *args, **kwargs):
        (source, filename, uptodate) = super().get_source(*args, **kwargs)
        return until_ruler(source), filename, uptodate


def until_ruler(doc):
    """
    Utilities to clean jinja template;

    Remove all ``|`` and `` `` until the last leading ``|``

    """
    lines = doc.split("\n")
    new = []
    for l in lines:

        while len(l.lstrip()) >= 1 and l.lstrip()[0] == "|":
            l = l.lstrip()[1:]
        new.append(l)
    return "\n".join(new)


from pygments import lex
from pygments.lexers import PythonLexer
from pygments.formatters import HtmlFormatter


def get_classes(code):
    list(lex(code, PythonLexer()))
    FMT = HtmlFormatter()
    classes = [FMT.ttype2class.get(x) for x, y in lex(code, PythonLexer())]
    classes = [c if c is not None else "" for c in classes]
    return classes


def root():
    # nvisited_items = {}
    store = Store(ingest_dir)
    files = store.glob("*.json")

    env = Environment(
        loader=FileSystemLoader(os.path.dirname(__file__)),
        autoescape=select_autoescape(["html", "tpl.j2"]),
    )
    env.globals["isstr"] = lambda x: isinstance(x, str)
    env.globals["len"] = len
    template = env.get_template("root.tpl.j2")
    filenames = [_.name[:-5] for _ in files if _.name.endswith(".json")]
    tree = {}
    for f in filenames:
        sub = tree
        parts = f.split(".")
        for i, part in enumerate(parts):
            if part not in sub:
                sub[part] = {}
            sub = sub[part]

        sub["__link__"] = f

    return template.render(tree=tree)


async def _route(ref, store):
    assert isinstance(store, BaseStore)
    if ref == "favicon.ico":
        here = Path(os.path.dirname(__file__))
        return (here / ref).read_bytes()

    if ref.endswith(".html"):
        ref = ref[:-5]
    if ref == "favicon.ico":
        return ""

    env = Environment(
        loader=FileSystemLoader(os.path.dirname(__file__)),
        autoescape=select_autoescape(["html", "tpl.j2"]),
    )
    env.globals["len"] = len
    env.globals["paragraph"] = paragraph
    env.globals["paragraphs"] = paragraphs
    env.globals["len"] = len

    template = env.get_template("core.tpl.j2")

    error = env.get_template("404.tpl.j2")
    known_refs = [str(x.name)[:-5] for x in store.glob("*.json")]

    file_ = store / f"{ref}.json"

    papp_files = store.glob("*__papyri__.json")
    for p in papp_files:
        aliases = json.loads(await p.read_text())
    print(aliases)

    family = sorted(list(store.glob("*.json")))
    family = [str(f.name)[:-5] for f in family]
    parts = ref.split(".") + ["+"]
    siblings = {}
    cpath = ""
    # TODO: move this at ingestion time for all the non-top-level.
    for i, part in enumerate(parts):
        sib = list(
            sorted(
                set(
                    [
                        ".".join(s.split(".")[: i + 1])
                        for s in family
                        if s.startswith(cpath)
                    ]
                )
            )
        )
        cpath += part + "."

        siblings[part] = [(s, s.split(".")[-1]) for s in sib]

    if await file_.exists():
        bytes_ = await ((store / f"{ref}.json").read_text())
        brpath = store / f"{ref}.br"
        if await brpath.exists():
            br = await brpath.read_text()
        else:
            br = None
        doc_blob = load_one(bytes_, br)
        local_refs = [x[0] for x in doc_blob.content["Parameters"] if x[0]] + [
            x[0] for x in doc_blob.content["Returns"] if x[0]
        ]
        env.globals["resolve"] = resolve_(ref, known_refs, local_refs)

        ### dive into the example data, reconstruct the initial code, parse it with pygments,
        # and append the highlighting class as the third element
        # I'm thinking the linking strides should be stored separately as the code
        # it might be simpler, and more compact.
        for i, (type_, (in_out)) in enumerate(doc_blob.example_section_data):
            if type_ == "code":
                in_, out = in_out
                classes = get_classes("".join([x for x, y in in_]))
                for ii, cc in zip(in_, classes):
                    # TODO: Warning here we mutate objects.
                    ii.append(cc)
            if type_ == "text":
                doc_blob.example_section_data[i][1] = paragraphs([in_out])

        return render_one(
            template=template,
            doc=doc_blob,
            qa=ref,
            ext="",
            parts=siblings,
            backrefs=doc_blob.backrefs,
            pygment_css=HtmlFormatter(style="pastie").get_style_defs(".highlight"),
        )
    else:
        known_refs = [str(s.name)[:-5] for s in store.glob(f"{ref}*.json")]
        brpath = store / "__phantom__" / f"{ref}.json"
        if await brpath.exists():
            br = json.loads(await brpath.read_text())
        else:
            br = []

        tree = {}
        for f in known_refs:
            sub = tree
            parts = f.split(".")[len(ref.split(".")) :]
            for i, part in enumerate(parts):
                if part not in sub:
                    sub[part] = {}
                sub = sub[part]

            sub["__link__"] = f

        return error.render(backrefs=list(set(br)), tree=tree, ref=ref)


def img(subpath):
    assert subpath.endswith("png")
    with open(ingest_dir / subpath, "rb") as f:
        return f.read()


def logo():
    import os

    path = os.path.abspath(__file__)
    dir_path = Path(os.path.dirname(path))
    with open((dir_path / "papyri-logo.png"), "rb") as f:
        return f.read()


def serve():

    app = QuartTrio(__name__)

    async def r(ref):
        return await _route(ref, Store(str(ingest_dir)))

    # return await _route(ref, GHStore(Path('.')))

    app.route("/logo.png")(logo)
    app.route("/<ref>")(r)
    app.route("/img/<path:subpath>")(img)
    app.route("/")(root)
    port = os.environ.get("PORT", 5000)
    print("Seen config port ", port)
    prod = os.environ.get("PROD", None)
    if prod:
        app.run(port=port, host="0.0.0.0")
    else:
        app.run(port=port)


def paragraph(lines):
    """
    return container of (type, obj)
    """
    p = Paragraph.parse_lines(lines)
    acc = []
    for c in p.children:
        if type(c).__name__ == "Directive":
            if c.role == "math":
                acc.append(("Math", c))
            else:
                acc.append((type(c).__name__, c))
        else:
            acc.append((type(c).__name__, c))
    return acc


def paragraphs(lines):
    blocks = make_block_3(Lines(lines))
    acc = []
    for b0, b1, b2 in blocks:
        if b0:
            acc.append(paragraph([x._line for x in b0]))
        ## definitively wrong but will do for now, should likely be verbatim, or recurse ?
        if b2:
            acc.append(paragraph([x._line for x in b2]))
    return acc


def render_one(
    template, doc: IngestedBlobs, qa, ext, *, backrefs, pygment_css=None, parts={}
):
    """
    Return the rendering of one document

    Parameters
    ----------
    template
        a Jinja@ template object used to render.
    doc : DocBlob
        a Doc object with the informations for current obj
    qa : str
        fully qualified name for current object
    ext : str
        file extension for url  – should likely be removed and be set on the template
        I think that might be passed down to resolve maybe ?
    backrefs : list of str
        backreferences of document pointing to this.
    parts : Dict[str, list[(str, str)]
        used for navigation and for parts of the breakcrumbs to have navigation to siblings.
        This is not directly related to current object.

    """
    # TODO : move this to ingest likely.
    # Here if we have too many references we group them on where they come from.
    if len(backrefs) > 30:

        b2 = defaultdict(lambda: [])
        for ref in backrefs:
            mod, _ = ref.split(".", maxsplit=1)
            b2[mod].append(ref)
        backrefs = (None, b2)
    else:
        backrefs = (backrefs, None)

    # partial lift of paragraph parsing....
    # TODO: Move this higher in the ingest
    sections_ = [
        "Parameters",
        "Returns",
        "Raises",
        "Yields",
        "Attributes",
        "Other Parameters",
    ]
    for s in sections_:
        for i, p in enumerate(doc.content[s]):
            if p[2]:
                doc.content[s][i] = (p[0], p[1], paragraphs(p[2]))

    for s in ["Summary", "Extended Summary", "Notes"]:
        if s in doc.content:
            doc.content[s] = paragraphs(doc.content[s])

    for d in doc.see_also:
        d.descriptions = paragraphs(d.descriptions)

    return template.render(
        doc=doc,
        qa=qa,
        version=doc.version,
        module=qa.split(".")[0],
        backrefs=backrefs,
        ext=ext,
        parts=parts,
        pygment_css=pygment_css,
    )


async def _ascii_render(name, store=None):
    if store is None:
        store = Store(ingest_dir)
    ref = name

    env = Environment(
        loader=CleanLoader(os.path.dirname(__file__)),
        lstrip_blocks=True,
        trim_blocks=True,
    )
    env.globals["len"] = len
    env.globals["paragraph"] = paragraph
    env.globals["paragraphs"] = paragraphs
    template = env.get_template("ascii.tpl.j2")

    known_refs = [x.name[:-5] for x in store.glob("*")]
    bytes_ = await (store / f"{ref}.json").read_text()
    brpath = store / f"{ref}.br"
    if await brpath.exists():
        br = await brpath.read_text()
    else:
        br = None
    blob = load_one(bytes_, br)

    # TODO : move this to ingest.
    local_ref = [x[0] for x in blob.content["Parameters"] if x[0]] + [
        x[0] for x in blob.content["Returns"] if x[0]
    ]

    # TODO : move this to ingest.
    env.globals["resolve"] = resolve_(ref, known_refs, local_ref)
    for i, (type_, in_out) in enumerate(blob.example_section_data):
        if type_ == "code":
            in_, out = in_out
            for ii in in_:
                ii.append(None)
        if type_ == "text":
            blob.example_section_data[i][1] = paragraphs([in_out])

    return render_one(
        template=template,
        doc=blob,
        qa=ref,
        ext="",
        backrefs=blob.backrefs,
        pygment_css=None,
    )


async def ascii_render(name, store=None):
    print(await _ascii_render(name, store))


async def main():
    store = Store(ingest_dir)
    files = store.glob("*")

    env = Environment(
        loader=FileSystemLoader(os.path.dirname(__file__)),
        autoescape=select_autoescape(["html", "tpl.j2"]),
    )
    env.globals["len"] = len
    env.globals["paragraph"] = paragraph
    env.globals["paragraphs"] = paragraphs
    template = env.get_template("core.tpl.j2")

    known_ref = [x.name[:-5] for x in store.glob("*")]

    html_dir.mkdir(exist_ok=True)
    document: Store
    for p, document in progress(files, description="Rendering..."):
        if (
            document.name.startswith("__")
            or not document.name.endswith(".json")
            or document.name.endswith("__papyri__.json")
        ):
            continue
        qa = document.name[:-5]
        try:
            bytes_ = await document.read_text()
            brpath = store / f"{qa}.br"
            if await brpath.exists():
                br = await brpath.read_text()
            else:
                br = None
            doc_blob: IngestedBlobs = load_one(bytes_, br)

        except Exception as e:
            raise RuntimeError(f"error with {document}") from e

        # for p,(qa, doc_blob:IngestedBlobs) in progress(nvisited_items.items(), description='Rendering'):
        local_refs = [x[0] for x in doc_blob.content["Parameters"] if x[0]] + [
            x[0] for x in doc_blob.content["Returns"] if x[0]
        ]
        env.globals["resolve"] = resolve_(qa, known_ref, local_refs)
        for i, (type_, in_out) in enumerate(doc_blob.example_section_data):
            if type_ == "code":
                in_, out = in_out
                for ii in in_:
                    ii.append(None)
            if type_ == "text":
                doc_blob.example_section_data[i][1] = paragraphs([in_out])

        with (html_dir / f"{qa}.html").open("w") as f:
            f.write(
                render_one(
                    template=template,
                    doc=doc_blob,
                    qa=qa,
                    ext=".html",
                    backrefs=doc_blob.backrefs,
                    pygment_css=None,
                )
            )
