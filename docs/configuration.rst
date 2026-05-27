.. _configuration:

Papyri configuration reference
===============================

``papyri gen`` is driven by a TOML configuration file — one file per
library.  The file has two top-level sections:

- ``[global]`` — controls how ``papyri gen`` collects and processes the
  library.  All keys described below live here unless stated otherwise.
- ``[meta]`` — human-readable metadata attached to the published bundle
  (URLs, PyPI slug, version tag).

The ``module`` key inside ``[global]`` is the only **required** key.
Everything else has a sensible default or is simply omitted when not
needed.


Minimal example
---------------

.. code:: toml

   [global]
   module = 'mylib'

   [meta]
   github_slug = 'myorg/mylib'
   tag = 'v{version}'
   pypi = 'mylib'

Running ``papyri gen mylib.toml`` against this file discovers ``mylib``,
processes every public object it finds, executes the docstring examples,
and writes the DocBundle to ``~/.papyri/data/mylib_<version>/``.


``[global]`` reference
-----------------------

.. _config-module:

``module``
~~~~~~~~~~

**Type:** ``str`` — **required**

The importable root package name.  ``papyri gen`` imports this name and
walks its public API.

.. code:: toml

   module = 'numpy'


.. _config-submodules:

``submodules``
~~~~~~~~~~~~~~

**Type:** ``list[str]`` — default ``[]``

Extra submodules to collect in addition to the root.  Use this when
public objects live under subpackages that are not reachable just by
importing the root.  Names are relative to ``module``; ``'fft'`` means
``numpy.fft``.

.. code:: toml

   submodules = ['core', 'fft', 'linalg', 'ma', 'random']


.. _config-execute-doctests:

``execute_doctests``
~~~~~~~~~~~~~~~~~~~~

**Type:** ``bool`` — default ``true``

Whether to attempt to execute the code examples found in docstrings.
Set to ``false`` to skip execution entirely (faster builds, no
side-effects).  ``execute_exclude_patterns`` and ``exclude_jedi`` refine
*which* objects are executed when this is ``true``.

Can be overridden on the command line with ``--exec`` / ``--no-exec``.

.. code:: toml

   execute_doctests = false


.. _config-exec-failure:

``exec_failure``
~~~~~~~~~~~~~~~~

**Type:** ``'raise' | 'fallback' | null`` — default ``null``

Controls what happens when a docstring example raises an exception
during execution.

``'raise'``
   Re-raise the exception; the whole gen run aborts unless the object is
   listed in ``expected_errors``.

``'fallback'``
   Log the failure and continue; the example is stored unevaluated.
   Recommended for large third-party libraries where some examples are
   known to break outside their own test environment.

omitted / ``null``
   Same as ``'raise'``.

.. code:: toml

   exec_failure = 'fallback'


.. _config-execute-exclude-patterns:

``execute_exclude_patterns``
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

**Type:** ``list[str]`` — default ``[]``

Qualified name *prefixes* (dotted, with optional ``:``-separated
attribute path) whose docstring examples must **not** be executed.
Matching uses ``str.startswith``, so ``'numpy._'`` excludes every
private submodule of numpy.

Use this instead of ``exclude`` when you only want to skip *execution*
but still want the object documented in the bundle.

.. code:: toml

   execute_exclude_patterns = [
       'numpy._',                               # all private submodules
       'numpy.testing._priv',                   # a specific private subpackage
       'numpy.errstate',                        # a single class
       'numpy.core._multiarray_umath.bincount', # a single function
   ]


.. _config-exclude:

``exclude``
~~~~~~~~~~~

**Type:** ``list[str]`` — default ``[]``

Fully-qualified names of objects to **omit entirely** from the bundle.
The format is ``'package.module:ClassName'`` or ``'package.module'``.
Objects in this list are not collected, not executed, and not written to
the IR.

.. code:: toml

   exclude = [
       'numpy:tensordot',
       'numpy.ma.core:MaskedArray.resize',
   ]


.. _config-exclude-jedi:

``exclude_jedi``
~~~~~~~~~~~~~~~~

**Type:** ``list[str]`` — default ``[]``

Qualified names for which Jedi type-inference should be **skipped**.
Use when Jedi hangs, crashes, or produces wrong results for a specific
object.  The object is still collected and executed (unless also in
``exclude`` or ``execute_exclude_patterns``); only the Jedi inference
step is bypassed.

.. code:: toml

   exclude_jedi = [
       'scipy.linalg._sketches.clarkson_woodruff_transform',
       'scipy.optimize._lsq.least_squares.least_squares',
   ]


.. _config-jedi-failure-mode:

``jedi_failure_mode``
~~~~~~~~~~~~~~~~~~~~~

**Type:** ``'log' | 'raise' | null`` — default ``null``

Controls what happens when Jedi raises an error for an object that is
*not* in ``exclude_jedi``.

``'log'``
   Log the error and continue.

``'raise'``
   Re-raise the error.

omitted / ``null``
   Silently ignore.

.. code:: toml

   jedi_failure_mode = 'log'


.. _config-infer:

``infer``
~~~~~~~~~

**Type:** ``bool`` — default ``true``

Whether to run Jedi type-inference on code examples at all.  When
``false``, no Jedi calls are made and ``exclude_jedi`` has no effect.

Can be overridden on the command line with ``--infer`` / ``--no-infer``.

.. code:: toml

   infer = false


.. _config-early-error:

``early_error``
~~~~~~~~~~~~~~~

**Type:** ``bool`` — default ``true``

When ``true``, the gen run aborts on the first unexpected error (i.e.,
any error not listed in ``expected_errors``).  Set to ``false`` to
collect all errors and print a summary at the end.

Can be overridden on the command line with ``--fail-early``.

.. code:: toml

   early_error = false


.. _config-expected-errors:

``[global.expected_errors]``
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

**Type:** ``dict[str, list[str]]`` — default ``{}``

A mapping from exception class names to lists of fully-qualified object
names that are *expected* to raise that exception during generation.

- If a listed object does **not** raise the expected exception, the gen
  run fails.
- If an object raises an exception whose class is **not** listed here,
  it is treated as an unexpected error (subject to ``early_error`` and
  ``exec_failure``).

Use this to document known upstream issues without failing the build.

.. code:: toml

   [global.expected_errors]
   VisitCitationReferenceNotImplementedError = [
       'numpy.fft',
   ]
   WrongTypeAtField = [
       'scipy.signal._ltisys:StateSpace',
       'scipy.signal._ltisys:TransferFunction',
   ]
   IncorrectInternalDocsLen = [
       'matplotlib.dates:ConciseDateFormatter',
   ]
   AssertionError = [
       'scipy.optimize._linprog_ip:_ip_hsd',
   ]
   NumpydocParseError = [
       'distributed.client:default_client',
   ]


.. _config-implied-imports:

``[global.implied_imports]``
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

**Type:** ``dict[str, str]`` — default ``{}``

Namespace aliases that are pre-imported before each example block is
executed, so that short names used in examples resolve correctly.

Format::

   alias = 'package'        # equivalent to: import package as alias
   alias = 'package:name'   # equivalent to: from package import name as alias

Without this, examples like ``np.array([1, 2, 3])`` fail because ``np``
is not in scope.

.. code:: toml

   [global.implied_imports]
   np          = 'numpy'
   pd          = 'pandas'
   plt         = 'matplotlib.pyplot'
   xr          = 'xarray'
   get_ipython = 'IPython:get_ipython'


.. _config-docs-path:

``docs_path``
~~~~~~~~~~~~~

**Type:** ``str | null`` — default ``null``

Filesystem path to the narrative documentation source tree (the
directory containing ``.rst`` files).  ``~`` is expanded.  When set,
``papyri gen`` walks this tree and includes the narrative pages in the
bundle.

.. code:: toml

   docs_path = '~/dev/numpy/doc/source'


.. _config-narrative-exclude:

``narrative_exclude``
~~~~~~~~~~~~~~~~~~~~~

**Type:** ``list[str]`` — default ``[]``

Path fragments to skip inside ``docs_path``.  Any ``.rst`` file whose
path contains one of these strings is excluded from the bundle.

.. code:: toml

   narrative_exclude = [
       'doc/source/reference/arrays.ndarray.rst',
       'doc/source/_templates/',
       'doc/source/user/how-to-how-to.rst',
   ]


.. _config-examples-folder:

``examples_folder``
~~~~~~~~~~~~~~~~~~~~

**Type:** ``str | null`` — default ``null``

Filesystem path to a directory of Python example scripts to include in
the bundle.  ``~`` is expanded.  The scripts are executed and their
outputs (including plots) are captured.

.. code:: toml

   examples_folder = '~/dev/matplotlib/examples/'


.. _config-examples-exclude:

``examples_exclude``
~~~~~~~~~~~~~~~~~~~~

**Type:** ``list[str]`` — default ``[]``

Relative paths (inside ``examples_folder``) to skip.  The match is a
suffix test against the example file's path string.

.. code:: toml

   examples_exclude = [
       'logos2.py',
       'multipage_pdf.py',
       'units/artist_tests.py',
   ]


.. _config-logo:

``logo``
~~~~~~~~

**Type:** ``str | null`` — default ``null``

Path to the package logo, relative to the config file.  The logo is
embedded in the bundle and displayed by the viewer.

.. code:: toml

   logo = 'img/numpy_logo.png'


.. _config-wait-for-plt-show:

``wait_for_plt_show``
~~~~~~~~~~~~~~~~~~~~~~

**Type:** ``bool | null`` — default ``true``

When ``true``, papyri waits for ``matplotlib.pyplot.show()`` calls
inside example blocks to complete before moving on, ensuring that figure
output is captured.  Set to ``false`` when matplotlib examples do not
call ``plt.show()`` or when captures are handled another way.

.. code:: toml

   wait_for_plt_show = false


.. _config-source:

``source``
~~~~~~~~~~

**Type:** ``str | null`` — default ``null``

URL of the project's source repository.  Informational; stored in the
bundle metadata.

.. code:: toml

   source = 'https://github.com/numpy/numpy'


.. _config-homepage-global:

``homepage``
~~~~~~~~~~~~

**Type:** ``str | null`` — default ``null``

URL of the project's homepage.  Informational; stored in the bundle
metadata.  If present in both ``[global]`` and ``[meta]``, the ``[meta]``
value is authoritative for the viewer.

.. code:: toml

   homepage = 'https://numpy.org'


.. _config-docs:

``docs``
~~~~~~~~

**Type:** ``str | null`` — default ``null``

URL of the project's official rendered documentation.  Informational;
stored in the bundle metadata.

.. code:: toml

   docs = 'https://numpy.org/doc/stable/'


.. _config-directives:

``[global.directives]``
~~~~~~~~~~~~~~~~~~~~~~~~

**Type:** ``dict[str, str]`` — default ``{}``

Custom RST directive handlers to register for this bundle.  Keys are
directive names as they appear in RST (e.g. ``mydirective`` for
``.. mydirective::``); values are ``'module:callable'`` strings pointing
to the handler function.

.. code:: toml

   [global.directives]
   mydirective = 'mylib.docs:_mydirective_handler'

To silently drop a directive instead of raising an error, map it to
``papyri.directives:drop``:

.. code:: toml

   [global.directives]
   testsetup   = 'papyri.directives:drop'
   testcleanup = 'papyri.directives:drop'
   plot        = 'papyri.directives:drop'

The handler callable must accept ``(argument, options, content)`` and
return an IR node or ``None``.


``[meta]`` reference
---------------------

The ``[meta]`` section holds metadata attached verbatim to the published
bundle.  All keys are optional but recommended for bundles intended for
public consumption.

.. _config-github-slug:

``github_slug``
~~~~~~~~~~~~~~~

**Type:** ``str``

``owner/repo`` slug of the project's GitHub repository.  Used by papyri
to construct links to source files and issues.

.. code:: toml

   github_slug = 'numpy/numpy'


.. _config-tag:

``tag``
~~~~~~~

**Type:** ``str``

Git tag template for this bundle's release.  ``{version}`` is
interpolated with the package version at gen time; ``{{version}}``
produces a literal ``{version}`` in the tag string (useful when the
upstream tag format already contains braces).

.. code:: toml

   tag = 'v{version}'          # → v1.26.4
   tag = '{{version}}'         # → {version}
   tag = 'networkx-{version}'  # → networkx-2.7.1


.. _config-pypi:

``pypi``
~~~~~~~~

**Type:** ``str``

PyPI distribution name.  Used to construct links to the package on
PyPI.

.. code:: toml

   pypi = 'numpy'


.. _config-homepage-meta:

``homepage``
~~~~~~~~~~~~

**Type:** ``str``

URL of the project's homepage.

.. code:: toml

   homepage = 'https://numpy.org/'


.. _config-docspage:

``docspage``
~~~~~~~~~~~~

**Type:** ``str``

URL of the project's official documentation.

.. code:: toml

   docspage = 'https://numpy.org/doc/1.26/'


``papyri gen`` CLI reference
-----------------------------

All options override or supplement the TOML config.

.. code::

   papyri gen [OPTIONS] FILE

.. list-table::
   :header-rows: 1
   :widths: 30 15 55

   * - Option
     - Default
     - Description
   * - ``FILE``
     - —
     - Path to the ``.toml`` configuration file. **Required.**
   * - ``--infer / --no-infer``
     - ``true``
     - Override ``infer`` from the config.
   * - ``--exec / --no-exec``
     - config value
     - Override ``execute_doctests`` from the config.
   * - ``--debug``
     - ``false``
     - Enable debug-level logging.
   * - ``--no-progress``
     - ``false``
     - Disable progress bars (useful in CI or with ``ipdb``).
   * - ``--dry-run``
     - ``false``
     - Parse and collect, but do not write any output to disk.
   * - ``--api / --no-api``
     - ``true``
     - Include / skip the API documentation pass.
   * - ``--examples / --no-examples``
     - ``true``
     - Include / skip the examples pass.
   * - ``--narrative / --no-narrative``
     - ``true``
     - Include / skip the narrative documentation pass.
   * - ``--fail``
     - ``false``
     - Fail on the first error encountered.
   * - ``--fail-early``
     - ``false``
     - Override ``early_error`` from the config.
   * - ``--fail-unseen-error``
     - ``false``
     - Fail if any exception type not listed in ``expected_errors`` is raised.
   * - ``--only TEXT``
     - all objects
     - Restrict generation to this qualified name (repeatable).
   * - ``--upload``
     - ``false``
     - After generation, upload the bundle to ``$PAPYRI_UPLOAD_URL``.
   * - ``--pack``
     - ``false``
     - After generation, write a ``.papyri`` artifact in the current directory.

Environment variables read by ``--upload``:

.. list-table::
   :header-rows: 1
   :widths: 35 65

   * - Variable
     - Description
   * - ``PAPYRI_UPLOAD_URL``
     - Viewer ingest endpoint (default: ``http://localhost:4321/api/bundle``).
       Overridden by a named target if ``default_target`` is set in
       ``~/.papyri/config.toml``.
   * - ``PAPYRI_UPLOAD_TOKEN``
     - Bearer token for the ingest endpoint.  Overridden by a named target's
       token or keychain entry if ``default_target`` is set.


.. _upload-config:

``~/.papyri/config.toml`` — user upload config
------------------------------------------------

``papyri upload`` reads an optional user-level config file at
``~/.papyri/config.toml``.  It lets you define **named upload targets**
so you can type ``papyri upload --to staging`` instead of repeating a
long URL and token on every invocation.

The file is separate from the per-library TOML config used by
``papyri gen``.

.. code:: toml

   # ~/.papyri/config.toml

   [upload]
   # Optional: use this target when --to is not given.
   default_target = "localhost"

   # ── targets ────────────────────────────────────────────────────────────

   [upload.targets.localhost]
   url = "http://localhost:4321/api/bundle"
   # No token needed for a local dev instance.

   [upload.targets.staging]
   url   = "https://staging.example.com/api/bundle"
   token = "my-staging-token"        # plain-text — OK for dev/staging

   [upload.targets.production]
   url      = "https://docs.example.com/api/bundle"
   keychain = true                   # read token from system keychain


``[upload.targets.<name>]`` keys
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 20 15 65

   * - Key
     - Required
     - Description
   * - ``url``
     - **yes**
     - Full URL of the viewer's ``/api/bundle`` ingest endpoint.
   * - ``token``
     - no
     - Bearer token as plain text.  Cannot be combined with ``keychain``.
   * - ``keychain``
     - no
     - When ``true``, the token is fetched from the system keychain at
       upload time.  See :ref:`upload-keychain`.  Cannot be combined with ``token``.

``[upload]`` keys
~~~~~~~~~~~~~~~~~

.. list-table::
   :header-rows: 1
   :widths: 25 75

   * - Key
     - Description
   * - ``default_target``
     - Name of the target to use when ``--to`` is not supplied.  Must
       match a key under ``[upload.targets]``.  Omit to keep the current
       behaviour (fall through to ``$PAPYRI_UPLOAD_URL`` / hardcoded
       default).


.. _upload-keychain:

Storing tokens in the system keychain
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Setting ``keychain = true`` in a target tells ``papyri upload`` to look
up the bearer token from the OS credential store at upload time, rather
than storing it in the config file.  The lookup uses the `keyring
<https://pypi.org/project/keyring/>`__ package (macOS Keychain, Windows
Credential Manager, Linux Secret Service / KWallet).

**Install keyring support:**

.. code:: bash

   pip install "papyri[keychain]"

**Store a token (run once per machine / token rotation):**

.. code:: bash

   python -m keyring set papyri <target-name>
   # e.g.
   python -m keyring set papyri production

You will be prompted for the token value.  It is then encrypted and
stored in the OS credential store; ``papyri upload`` retrieves it
automatically.  The token never appears in ``~/.papyri/config.toml``.

If ``keyring`` is not installed or no entry is found, the upload fails
with a clear message explaining the fix.


``papyri upload`` CLI reference
---------------------------------

.. code::

   papyri upload [OPTIONS] PATH [PATH ...]

Each ``PATH`` may be a ``.papyri`` artifact (from ``papyri pack``), a
``.zip`` containing exactly one ``.papyri`` artifact, or a DocBundle
directory (packed on the fly).

.. list-table::
   :header-rows: 1
   :widths: 20 20 60

   * - Option
     - Default
     - Description
   * - ``--to NAME``
     - —
     - Named target from ``~/.papyri/config.toml``.  Supplies the URL and
       token for that target.  Explicit ``--url`` / ``--token`` flags
       override ``--to``.
   * - ``--url`` / ``-u``
     - see below
     - Viewer ingest endpoint.  Overrides ``--to`` and
       ``$PAPYRI_UPLOAD_URL``.
   * - ``--token`` / ``-t``
     - see below
     - Bearer token.  Overrides ``--to`` and ``$PAPYRI_UPLOAD_TOKEN``.
       Omit for local dev instances with no auth.
   * - ``--verbose`` / ``-v``
     - ``false``
     - Show per-step packing progress when building a bundle on the fly.

**URL resolution order** (first match wins):

1. ``--url`` flag
2. ``--to`` target's ``url`` (or ``default_target`` from config if ``--to`` is omitted)
3. ``$PAPYRI_UPLOAD_URL`` environment variable
4. ``http://localhost:4321/api/bundle``

**Token resolution order** (first match wins):

1. ``--token`` flag
2. ``--to`` target's ``token`` / ``keychain`` entry
3. ``$PAPYRI_UPLOAD_TOKEN`` environment variable
4. *(no token — omit the ``Authorization`` header)*

**Typical workflows:**

.. code:: bash

   # Local dev (no config needed — hits localhost by default).
   papyri upload ~/.papyri/data/mylib_1.0/

   # Named target from config (URL + token resolved automatically).
   papyri upload --to staging mylib-1.0.papyri

   # Named target but override URL for a one-off.
   papyri upload --to production --url https://override.example.com/api/bundle mylib.papyri

   # One-off with explicit credentials (no config file needed).
   papyri upload --url https://docs.example.com/api/bundle --token $MY_TOKEN mylib.papyri


``papyri pack`` CLI reference
------------------------------

.. code::

   papyri pack [OPTIONS] [BUNDLE_DIR]

Validates a DocBundle directory and writes a deterministic ``.papyri``
artifact (gzipped canonical-CBOR ``Bundle`` node).  Running pack twice
on the same input produces byte-identical output.  If ``BUNDLE_DIR`` is
omitted, every directory under ``~/.papyri/data/`` is packed in turn.

.. list-table::
   :header-rows: 1
   :widths: 25 30 45

   * - Option
     - Default
     - Description
   * - ``BUNDLE_DIR``
     - all bundles under ``~/.papyri/data/``
     - DocBundle directory to pack.
   * - ``--output`` / ``-o``
     - ``<module>-<version>.papyri`` in cwd
     - Output file or directory (single-bundle mode only).
   * - ``--verbose`` / ``-v``
     - ``false``
     - Show per-step progress.


Full annotated example
-----------------------

The following file shows every ``[global]`` key in one place.

.. code:: toml

   [global]
   # ── required ───────────────────────────────────────────────────────────
   module = 'mylib'

   # ── discovery ──────────────────────────────────────────────────────────
   submodules = ['io', 'utils']

   # Completely skip these objects (no collection, no execution, no IR entry).
   exclude = [
       'mylib.internal:_PrivateHelper',
       'mylib.compat',
   ]

   # ── doctest execution ───────────────────────────────────────────────────
   execute_doctests = true

   # What to do when a doctest raises unexpectedly: 'raise' or 'fallback'.
   exec_failure = 'fallback'

   # Skip execution for these prefixes (object still documented).
   execute_exclude_patterns = [
       'mylib._',                    # all private submodules
       'mylib.heavy:slow_function',  # a specific function
   ]

   # Skip Jedi inference for objects where it hangs or crashes.
   exclude_jedi = [
       'mylib.ffi:RawPointer',
   ]

   # What to do when Jedi errors: 'log' or 'raise'.
   jedi_failure_mode = 'log'

   # Run Jedi at all?
   infer = true

   # Wait for plt.show() before capturing figure output.
   wait_for_plt_show = true

   # ── error handling ──────────────────────────────────────────────────────
   # Abort on first unexpected error (override with --fail-early).
   early_error = false

   # ── narrative docs ──────────────────────────────────────────────────────
   docs_path = '~/dev/mylib/docs/source'

   narrative_exclude = [
       '_build/',
       '_templates/',
       'api/generated/',
   ]

   # ── examples ────────────────────────────────────────────────────────────
   examples_folder = '~/dev/mylib/examples/'

   examples_exclude = [
       'slow_demo.py',
       'requires_gpu/demo.py',
   ]

   # ── appearance ───────────────────────────────────────────────────────────
   logo = 'img/mylib_logo.png'

   # ── informational URLs ───────────────────────────────────────────────────
   source   = 'https://github.com/myorg/mylib'
   homepage = 'https://mylib.readthedocs.io/'
   docs     = 'https://mylib.readthedocs.io/en/stable/'

   # ── pre-imported aliases for example execution ───────────────────────────
   [global.implied_imports]
   ml = 'mylib'
   np = 'numpy'
   pd = 'pandas'

   # ── known failures (build succeeds despite these errors) ─────────────────
   [global.expected_errors]
   WrongTypeAtField = [
       'mylib.io:read_csv',
   ]
   IncorrectInternalDocsLen = [
       'mylib.utils:_internal_helper',
   ]

   # ── custom RST directives ─────────────────────────────────────────────────
   [global.directives]
   myspecial   = 'mylib.docs:_myspecial_handler'
   testsetup   = 'papyri.directives:drop'
   testcleanup = 'papyri.directives:drop'

   # ── bundle metadata ───────────────────────────────────────────────────────
   [meta]
   github_slug = 'myorg/mylib'
   tag         = 'v{version}'
   pypi        = 'mylib'
   homepage    = 'https://mylib.readthedocs.io/'
   docspage    = 'https://mylib.readthedocs.io/en/stable/'
