.. _specimen-inline:

Inline text and roles
=====================

This page collects everything that happens *inside* a paragraph: text-level
emphasis, literals, inline math, and the inline ``:role:`` family.

Emphasis and strong
-------------------

One asterisk is *emphasis* (rendered as italic), two asterisks are **strong**
(rendered as bold). They can sit next to each other — *this is emphasised* and
**this is strong** — within ordinary running text.

Inline literals
---------------

Double backticks produce an inline literal: ``papyri gen``, ``--no-api``,
``~/.papyri/data/``. Literals are not parsed for further markup, so ``*not
emphasised*`` stays verbatim with its asterisks intact.

Inline math
-----------

The ``:math:`` role typesets a short expression inline with the surrounding
prose: the area of a circle is :math:`A = \pi r^2`, and Euler's identity
:math:`e^{i\pi} + 1 = 0` reads naturally mid-sentence. Display (block) math
lives on the :ref:`tables and math page <specimen-tables-math>`.

Formatting-only roles
---------------------

A family of roles exists purely to mark *what kind of thing* a span of text is.
papyri does not cross-link these — they render as inline code — but they keep
the source semantic and round-trip cleanly:

- :file:`~/.papyri/config.toml` — a filesystem path (``:file:``).
- :kbd:`Ctrl+C` — a keystroke (``:kbd:``).
- :command:`papyri upload` — a shell command (``:command:``).
- :program:`papyri` — a program name (``:program:``).
- :samp:`gen {config}.toml` — a literal with a placeholder (``:samp:``).
- H\ :sub:`2`\ O uses subscript (``:sub:``), and x\ :sup:`2` uses superscript
  (``:sup:``).
- :kbd:`Esc` then :kbd:`:wq` — keystrokes chained in prose.

C-domain roles such as ``:c:func:`` and ``:c:type:`` also render as inline
code, since papyri does not index C symbols: :c:func:`PyList_Append` and
:c:type:`PyObject` appear verbatim.

GitHub and PEP roles
--------------------

When the project config sets ``[meta].github_slug``, the IPython-style GitHub
roles become links: pull request :ghpull:`42` and issue :ghissue:`7` link into
the configured repository. Without a slug they degrade gracefully to plain
``#N`` text.

The ``:pep:`` role links to python.org: :pep:`8` (style), :pep:`257`
(docstrings), and :pep:`440` (version identifiers).

Cross-reference roles such as ``:func:``, ``:class:``, and ``:ref:`` are
covered on the :ref:`cross-references page <specimen-crossrefs>`.

Not supported
-------------

- **Substitutions** (``|name|`` with a ``.. |name| replace::`` definition):
  ``replace::`` text substitutions are resolved at gen time; image and unicode
  substitutions are warned and dropped. The IR never carries a substitution
  node.
- There is no inline role for arbitrary HTML or raw output — the ``raw``
  directive is dropped for security, and there is no inline equivalent.
