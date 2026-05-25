.. _specimen-blocks:

Block constructs
================

Block-level structure: paragraphs, the three kinds of list, block quotes,
literal and code blocks, doctests, and transitions.

Paragraphs
----------

A paragraph is any run of text separated from its neighbours by a blank line.

This is a second paragraph. Paragraphs are the default container — most other
block constructs are introduced by a marker (a bullet, a directive, an
indent), but plain prose needs no ceremony.

Bullet lists
------------

- First item.
- Second item, which is long enough to wrap onto a second line so you can see
  how continuation text aligns under the bullet rather than under the marker.
- Third item.

Lists nest by indentation:

- Top-level item.

  - Nested item A.
  - Nested item B.

- Back to the top level.

Enumerated lists
----------------

1. First.
2. Second.
3. Third.

Auto-numbered lists use ``#``:

#. Counts from one.
#. Without you tracking the numbers.

Nested enumeration mixes letters and digits:

1. Step one.

   a. Sub-step.
   b. Another sub-step.

2. Step two.

Definition lists
----------------

A definition list pairs a term with its definition:

DocBundle
    The self-contained intermediate representation produced by ``papyri gen``
    for a single project at a single version.

ingest
    The TypeScript pipeline that wires uploaded bundles into the cross-linked
    graph served by the viewer.

graphstore
    A derived cache. The only authoritative IR is the raw ``.papyri.gz``
    archive; the graphstore can always be rebuilt by re-ingesting it.

Field lists
-----------

Field lists are ``:name: value`` pairs, useful for compact metadata:

:Author: The papyri contributors
:Status: Specimen
:Encoding: JSON in the bundle directory, CBOR in the ``.papyri`` artifact

Block quotes
------------

A block quote is simply an indented block of text:

   Documentation should be generated once and rendered many times. Splitting
   the two halves is the whole point of papyri.

   A block quote can span multiple paragraphs, and the indentation is what
   marks it as quoted.

Literal blocks
--------------

A double colon at the end of a paragraph introduces a literal block, rendered
verbatim with no markup processing::

    This text is shown exactly as written.
        Indentation is preserved.
    *asterisks* are literal, not emphasis.

Code blocks
-----------

The ``code-block`` directive (and its aliases ``code`` and ``sourcecode``)
takes an explicit language for syntax highlighting:

.. code-block:: python

   from papyri.gen import Gen

   def build(config_path: str) -> None:
       gen = Gen(config_path)
       gen.collect_narrative_docs()

A TOML snippet, highlighted as TOML:

.. code-block:: toml

   [global]
   module = "mylib"
   docs_path = "docs"

Doctests
--------

Doctest blocks begin with the ``>>>`` prompt and are executed at gen time when
``execute_doctests`` is enabled, so the captured output is part of the IR::

   >>> 1 + 1
   2
   >>> "papyri".upper()
   'PAPYRI'

Transitions
-----------

A transition is a horizontal rule between blocks, written as a line of
punctuation:

----

It separates content without introducing a new section heading.

Not supported
-------------

- **Line blocks** (lines prefixed with ``|`` to preserve line breaks) are
  currently dropped with a warning — do not rely on them.
- **Block-quote attributions** (a ``-- Author`` line at the end of a quote)
  are not implemented and will fail the whole document; write the attribution
  as ordinary text instead.
