.. _specimen-crossrefs:

Cross-references
================

papyri's reason for existing is cross-linking, so references get their own
page: internal labels, API object refs, external links, citations, and
footnotes.

Internal label references
-------------------------

Any ``.. _label:`` target can be linked from anywhere in the same bundle with
the ``:ref:`` role. This page defines the target below:

.. _specimen-anchor:

Referencing across pages works the same way — :ref:`back to the specimen
index <specimens>`, or to a sibling page such as :ref:`admonitions
<specimen-admonitions>`. Within a page you can jump to a local anchor:
:ref:`the anchor defined just above <specimen-anchor>`.

When the bracketed text is omitted, the link text falls back to the target's
section title: :ref:`specimen-inline`.

API object references
---------------------

The Python-domain roles link to documented API objects. They resolve when the
bundle also contains API docs for the target (built without ``--no-api``);
unresolved targets render with a distinct "unresolved" style so broken links
are visible rather than silent.

- Module: :mod:`papyri`
- Class: :class:`papyri.gen.Gen`
- Method: :meth:`papyri.gen.Gen.collect_narrative_docs`
- Function: :func:`papyri.gen.Gen`

The same roles cross *packages*: a papyri doc can link straight to
:func:`numpy.linspace`. The viewer resolves such a reference against an
ingested numpy *bundle* if one is present, or — failing that — against a
registered external numpy *inventory* (see below). With neither in place the
target renders unresolved, which is exactly how a dangling cross-package link
looks.

External API references (intersphinx)
-------------------------------------

A cross-package reference whose target is *importable at gen time* but lives
outside any ingested bundle can still be linked, by resolving it against a
Sphinx ``objects.inv`` inventory registered with the viewer (Admin →
*External inventories*, or ``POST /api/inventory``). This is how a papyri
bundle links into projects that don't ship a DocBundle — numpy, scipy, or the
Python standard library:

- Class: :class:`pathlib.Path`
- Function: :func:`json.loads`
- Class: :class:`datetime.datetime`
- Class: :class:`collections.OrderedDict`
- Module: :mod:`collections`
- Function: :func:`functools.partial`
- Function: :func:`re.compile`
- Class: :class:`collections.abc.Mapping`

Resolution is by **object name**, like intersphinx itself: the dotted name is
looked up across every registered inventory, preferring one whose project name
matches the reference's top-level module. So a single Python inventory —
``https://docs.python.org/3/objects.inv`` registered as ``python`` — resolves
references into *any* stdlib module above (``pathlib.Path``, ``json.loads``,
``collections.abc.Mapping``, …), even though gen records each object's real
top-level module (``pathlib``, ``json``, ``collections``). A resolved external
link renders as an ``external`` xref with a trailing arrow; a name that is in
no registered inventory stays unresolved, like any other cross-package miss.

.. rubric:: Not supported

- **C-accelerated stdlib objects.** A reference resolves via the object's real
  defining module, which for C-accelerated callables is a private module:
  ``os.getcwd`` resolves to ``posix.getcwd`` and ``os.path.join`` to
  ``posixpath.join``, neither of which matches the public name on
  docs.python.org. Prefer pure-Python targets (as above) for external links.

External links
--------------

An inline external link wraps the text and trails a double underscore:
`the papyri repository <https://github.com/carreau/papyri>`__.

A named target lets you reuse a URL by name:

.. _papyri issues: https://github.com/carreau/papyri/issues

Report problems on the `papyri issues`_ tracker. The target is defined once and
referenced by name.

PEP, pull-request, and issue roles
----------------------------------

- :pep:`440` — links to the version-identifier PEP on python.org.
- :ghpull:`1` — links to a pull request in the configured GitHub repo.
- :ghissue:`1` — links to an issue in the same repo.

Citations
---------

Citations are named references collected at the bottom of the document. Cite
inline with ``[label]_`` and define with ``.. [label]``:

The split-pipeline design follows the conda-forge publishing model [condaforge]_,
and the IR is encoded with CBOR [RFC8949]_.

.. [condaforge] conda-forge: a community-led collection of recipes, build
   infrastructure, and distributions.
.. [RFC8949] C. Bormann and P. Hoffman, "Concise Binary Object Representation
   (CBOR)", RFC 8949.

Footnotes
---------

Footnotes use ``[#label]_`` for auto-numbered notes that render at the foot of
the page:

papyri targets Python 3.13 and newer [#py]_, and the viewer runs on both
Node.js and Cloudflare Workers [#cf]_.

.. [#py] Older interpreters are intentionally unsupported; no compatibility
   shims are carried.
.. [#cf] Backend selection happens at build time via the ``PAPYRI_ADAPTER``
   environment variable.

The ``:doc:`` role
------------------

The ``:doc:`` role links to another narrative document by path rather than by
label: ``:doc:`inline```. Prefer ``:ref:`` with an explicit ``.. _label:``
target where possible — label resolution is bundle-wide and does not depend on
the on-disk path of either document.
