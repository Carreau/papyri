.. _specimen-admonitions:

Admonitions
===========

Admonitions are call-out boxes. papyri recognises the full set of standard RST
admonition kinds, the version-change directives, and a few Sphinx extras. Each
carries a ``kind`` the viewer can style independently.

Standard admonitions
--------------------

.. note::
   A note draws attention to a useful aside without implying any risk.

.. tip::
   A tip suggests a better or faster way to do something.

.. hint::
   A hint nudges the reader toward an answer without spelling it out.

.. important::
   An important box marks something the reader must not skip.

.. attention::
   An attention box is a step up from a note — read this carefully.

.. caution::
   A caution warns that an action may have surprising consequences.

.. warning::
   A warning marks something that can go wrong if ignored.

.. danger::
   A danger box is the strongest call-out: this can break things badly.

.. error::
   An error box describes a failure condition.

Generic admonition
------------------

The generic ``admonition`` directive takes an explicit title, for call-outs
that do not fit a standard kind:

.. admonition:: Design note

   The bundle directory is intentionally human-readable JSON. CBOR encoding
   begins only at ``papyri pack``; never write CBOR into the bundle directory.

Topic
-----

A ``topic`` is a self-contained mini-section — a digression that has its own
title but does not belong in the document's heading hierarchy:

.. topic:: Why split building from rendering?

   In Sphinx, parsing docstrings and emitting HTML happen together, so a
   template change forces a full rebuild from source. papyri separates IR
   generation from rendering precisely to break that coupling.

Rubric
------

A ``rubric`` is an unnumbered heading that stays out of the table of contents
— handy for "References" or "Notes" headings that should not appear in
navigation:

.. rubric:: Further reading

The rubric renders as a heading-like call-out without becoming a section.

Version-change directives
-------------------------

These behave like admonitions but carry a version argument:

.. versionadded:: 0.1.0
   The ``papyri gen`` command and the DocBundle format.

.. versionchanged:: 0.0.10
   ``papyri upload`` now sends ``PUT`` (not ``POST``) to ``/api/bundle`` and
   sets the ``Origin`` header so the viewer's CSRF check passes.

.. deprecated:: 0.0.10
   Python-side rendering. The TypeScript viewer is the sole renderer; there is
   no ``papyri render`` and no JupyterLab extension.

See also
--------

The ``seealso`` directive groups related references. Its body is a definition
list mapping a target to a short description:

.. seealso::

   :ref:`Cross-references <specimen-crossrefs>`
       How internal labels, API object refs, and citations work.

   :ref:`Tables and math <specimen-tables-math>`
       Structured tables and typeset equations.
