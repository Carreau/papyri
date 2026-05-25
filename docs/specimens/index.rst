.. _specimens:

Specimen pages
==============

.. toctree::

   inline
   blocks
   admonitions
   tables-and-math
   crossrefs

These pages are a *specimen book* for papyri's narrative documentation: a
deliberately exhaustive tour of every RST construct, directive, role, and
inline style that ``papyri gen`` understands and the viewer renders.

They serve two audiences at once:

- **Contributors** get a single place to eyeball how each construct renders,
  catch regressions, and see what the IR looks like for a given bit of RST.
- **Maintainers writing docs** get a copy-pasteable reference of what is safe
  to use, what is silently dropped, and what is not supported yet.

Everything shown across these pages parses into proper IR nodes — no raw
``Directive`` fall-through, no validation failures. Anything papyri does *not*
support is called out explicitly under "Not supported" so the specimens stay
an accurate map of the territory.

How to read these
-----------------

Each page groups related constructs under a section heading and shows the
rendered result. Where the behaviour is subtle (a directive that is dropped on
purpose, a role that renders as plain code rather than a link) the page says so
inline rather than leaving you to guess.

The five pages are:

:ref:`Inline text and roles <specimen-inline>`
    Emphasis, strong, literals, inline math, and the inline ``:role:`` family.

:ref:`Block constructs <specimen-blocks>`
    Paragraphs, lists, definition and field lists, block quotes, literal and
    code blocks, doctests, and transitions.

:ref:`Admonitions <specimen-admonitions>`
    Every admonition kind, the version-change directives, ``seealso``,
    ``topic``, and ``rubric``.

:ref:`Tables and math <specimen-tables-math>`
    ``list-table`` and ``csv-table``, plus display and inline math.

:ref:`Cross-references <specimen-crossrefs>`
    Internal label refs, API object refs, citations, footnotes, and the
    ``pep`` / ``ghpull`` / ``ghissue`` roles.
