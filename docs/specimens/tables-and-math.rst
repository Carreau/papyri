.. _specimen-tables-math:

Tables and math
===============

Structured tables and typeset mathematics.

List tables
-----------

The ``list-table`` directive builds a table from a nested bullet list — one
outer item per row, one inner item per cell. ``:header-rows:`` marks how many
leading rows are headers:

.. list-table:: papyri commands
   :header-rows: 1

   * - Command
     - Run by
     - Produces
   * - ``papyri gen``
     - the library maintainer
     - a DocBundle directory
   * - ``papyri pack``
     - the maintainer
     - a ``.papyri`` artifact
   * - ``papyri upload``
     - the maintainer
     - an ingested bundle in the viewer

``:widths:`` hints at relative column widths:

.. list-table::
   :header-rows: 1
   :widths: 20 80

   * - Field
     - Meaning
   * - ``module``
     - The importable root package name (the only required key).
   * - ``docs_path``
     - Directory scanned recursively for narrative ``.rst`` files.

CSV tables
----------

The ``csv-table`` directive is more compact for dense data, taking the cell
values as comma-separated rows. ``:header:`` supplies the header row inline:

.. csv-table:: IR encodings by stage
   :header: "Stage", "On disk", "Encoding"

   "papyri gen", "bundle directory", "JSON (human-readable)"
   "papyri pack", ".papyri artifact", "gzip + CBOR"
   "ingest", "graphstore + blobs", "derived cache"

Display math
------------

The ``math`` directive typesets a display equation, centred on its own line:

.. math::

   \int_0^\infty e^{-x}\,dx = 1

Multi-line aligned math works too:

.. math::

   f(x) &= (x + a)(x + b) \\
        &= x^2 + (a + b)x + ab

Inline math
-----------

For short expressions inside prose, the ``:math:`` role keeps the equation on
the baseline: the Gaussian integral :math:`\int_{-\infty}^{\infty} e^{-x^2}\,dx
= \sqrt{\pi}` reads inline, as does a simple fraction :math:`\frac{1}{2}`.

Not supported
-------------

- **Grid tables** and **simple tables** (the ASCII-art ``+---+`` and ``===``
  forms) are not parsed into a table yet — they fall back to a verbatim code
  block. Use ``list-table`` or ``csv-table`` for real tables.
