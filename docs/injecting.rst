.. _injecting:

Injecting generated pages into a bundle
=======================================

Some documentation is *built*, not written: a CLI's option reference, a
plugin or magic listing, a key-binding table.  Sphinx projects typically
generate such pages with custom scripts before ``sphinx-build`` (IPython
runs three ``autogen_*.py`` scripts from its ``docs/Makefile``).

Papyri's equivalent is a custom step **between** ``gen`` and ``pack``.
The bundle directory ``papyri gen`` writes is deliberately lenient,
human-readable JSON so that tools other than gen can operate on it; the
:mod:`papyri.bundle_edit` module is the supported way to do that from
Python.  Content is built directly as IR nodes — no intermediate RST
files, no re-parsing — and the whole flow is three CI lines::

   papyri gen examples/IPython.toml
   python examples/ipython_inject.py ~/.papyri/data/IPython_<version>
   papyri pack ~/.papyri/data/IPython_<version>

``papyri pack`` validates whatever the injector wrote exactly like
gen-produced content: pages must decode as ``GeneratedDoc``, toc entries
must point at existing docs, and (under ``--strict``) injected pages must
be reachable from the toc.


Patching an existing page
-------------------------

The common case: a hand-written page should carry a generated block
(IPython's ``config/options/index.rst`` introduces the options; the
options themselves come from traitlets introspection).  Read the page,
replace the block, write it back:

.. code:: python

   from papyri.bundle_edit import read_doc, replace_block, write_doc
   from papyri.nodes import Paragraph, Section, Text

   generated = Section(
       (Paragraph((Text("… introspected content …"),)),),
       (Text("Options reference"),),
       level=2,
   )

   doc = read_doc(bundle_dir, "config:options:index")
   replace_block(doc, "Options reference", [generated])
   write_doc(bundle_dir, "config:options:index", doc)

Narrative pages are a *flat* sequence of ``Section`` nodes with heading
depth in ``Section.level`` — sections do not nest.  ``replace_block``
treats "the section titled X plus every following section of deeper
level" as one block and replaces it, or appends when no section matches.
Because the injected block's leading title matches on the next run,
injectors are idempotent: re-running updates content in place.


Adding a new page
-----------------

``narrative_doc`` builds a page in the same shape gen produces;
``add_toc_entry`` wires it into ``toc.json`` so it is reachable (an
unreferenced page is an orphan — a warning at pack time, an error under
``pack --strict``):

.. code:: python

   from papyri.bundle_edit import add_toc_entry, narrative_doc, write_doc

   write_doc(bundle_dir, "reference:options", narrative_doc(sections))
   add_toc_entry(bundle_dir, "reference:options", "Options", parent="index")


A complete injector
-------------------

``examples/ipython_inject.py`` ports IPython's three doc-generation
scripts to this model: traitlets config options become titled
admonitions, magics a definition list, and the prompt_toolkit key
bindings a table — all produced by importing IPython and introspecting
at inject time, in the same environment that ran ``papyri gen``.
