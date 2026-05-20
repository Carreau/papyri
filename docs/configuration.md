# Papyri configuration reference

`papyri gen` is driven by a TOML configuration file — one file per
library.  The file has two top-level sections:

- `[global]` — controls how `papyri gen` collects and processes the
  library.  All keys described below live here unless stated otherwise.
- `[meta]` — human-readable metadata attached to the published bundle
  (URLs, PyPI slug, version tag).

The `module` key inside `[global]` is the only **required** key.
Everything else has a sensible default or is simply omitted when not
needed.

---

## Minimal example

```toml
[global]
module = 'mylib'

[meta]
github_slug = 'myorg/mylib'
tag = 'v{version}'
pypi = 'mylib'
```

Running `papyri gen mylib.toml` against this file discovers
`mylib`, processes every public object it finds, executes the
docstring examples, and writes the DocBundle to
`~/.papyri/data/mylib_<version>/`.

---

## `[global]` reference

### `module`

**Type:** `str` — **required**

The importable root package name.  `papyri gen` imports this name and
walks its public API.

```toml
module = 'numpy'
```

---

### `submodules`

**Type:** `list[str]` — default `[]`

Extra submodules to collect in addition to the root.  Use this when
public objects live under subpackages that are not reachable just by
importing the root.

```toml
submodules = ['core', 'fft', 'linalg', 'ma', 'random']
```

The names are relative to `module`; `'fft'` means `numpy.fft`.

---

### `execute_doctests`

**Type:** `bool` — default `true`

Whether to attempt to execute the code examples found in docstrings.
Set to `false` to skip execution entirely (faster builds, no
side-effects).

```toml
execute_doctests = false
```

This is the master switch.  `execute_exclude_patterns` and
`exclude_jedi` refine *which* objects are executed when this is `true`.

---

### `exec_failure`

**Type:** `'raise' | 'fallback' | null` — default `null`

Controls what happens when a docstring example raises an exception
during execution.

| Value | Behaviour |
|---|---|
| `'raise'` | Re-raise the exception; the whole gen run aborts unless the object is in `expected_errors`. |
| `'fallback'` | Log the failure and continue; the example is stored unevaluated. |
| `null` (omitted) | Same as `'raise'`. |

`'fallback'` is recommended for large third-party libraries where
some examples are known to break outside their own test environment.

```toml
exec_failure = 'fallback'
```

---

### `execute_exclude_patterns`

**Type:** `list[str]` — default `[]`

Qualified name *prefixes* (dotted, with optional `:`-separated
attribute path) whose docstring examples must **not** be executed.
Matching is done with `str.startswith`, so `'numpy._'` excludes every
private submodule of numpy.

```toml
execute_exclude_patterns = [
    'numpy._',                      # all private submodules
    'numpy.testing._priv',          # a specific private subpackage
    'numpy.errstate',               # a single class
    'numpy.core._multiarray_umath.bincount',  # a single function
]
```

Use this instead of `exclude` when you only want to skip *execution*
but still want the object documented in the bundle.

---

### `exclude`

**Type:** `list[str]` — default `[]`

Fully-qualified names of objects to **omit entirely** from the bundle.
The format is `'package.module:ClassName'` or `'package.module'`.

```toml
exclude = [
    'numpy:tensordot',
    'numpy.ma.core:MaskedArray.resize',
]
```

Objects in this list are not collected, not executed, and not written to
the IR.

---

### `exclude_jedi`

**Type:** `list[str]` — default `[]`

Qualified names for which Jedi type-inference should be **skipped**.
Use when Jedi hangs, crashes, or produces wrong results for a specific
object.

```toml
exclude_jedi = [
    'scipy.linalg._sketches.clarkson_woodruff_transform',
    'scipy.optimize._lsq.least_squares.least_squares',
]
```

The object is still collected and executed (unless also in `exclude` or
`execute_exclude_patterns`); only the Jedi inference step is bypassed.

---

### `jedi_failure_mode`

**Type:** `'log' | 'raise' | null` — default `null`

Controls what happens when Jedi raises an error for an object that is
*not* in `exclude_jedi`.

| Value | Behaviour |
|---|---|
| `'log'` | Log the error and continue. |
| `'raise'` | Re-raise the error. |
| `null` (omitted) | Silently ignore. |

```toml
jedi_failure_mode = 'log'
```

---

### `infer`

**Type:** `bool` — default `true`

Whether to run Jedi type-inference on code examples at all.  When set
to `false`, no Jedi calls are made during the gen run.  This also
suppresses the per-object `exclude_jedi` logic because there is nothing
to exclude.

This value can be overridden on the command line with `--infer` /
`--no-infer`.

```toml
# disable type inference globally (rarely needed)
infer = false
```

---

### `early_error`

**Type:** `bool` — default `true`

When `true`, the gen run aborts on the first unexpected error it
encounters (i.e., any error not listed in `expected_errors`).  Set to
`false` to collect all errors and report a summary at the end.

```toml
early_error = false
```

This value can be overridden by `--fail-early` on the command line.

---

### `[global.expected_errors]`

**Type:** `dict[str, list[str]]` — default `{}`

A mapping from exception class names to lists of fully-qualified
object names that are *expected* to raise that exception during
generation.

If an object in the list does **not** raise the listed exception, the
gen run fails.  If an object raises an *unexpected* exception that is
not listed here, it is also treated as an error (subject to
`early_error` and `exec_failure`).

```toml
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
```

Use this to document known issues in upstream libraries without
failing the build.

---

### `[global.implied_imports]`

**Type:** `dict[str, str]` — default `{}`

Namespace aliases that are pre-imported before each example block is
executed, so that short names used in examples resolve correctly.

The format is:

```
alias = 'package'           # imports the package under `alias`
alias = 'package:name'      # does `from package import name as alias`
```

```toml
[global.implied_imports]
np = 'numpy'
pd = 'pandas'
plt = 'matplotlib.pyplot'
xr = 'xarray'
get_ipython = 'IPython:get_ipython'
```

Without this, examples like `np.array([1, 2, 3])` would fail because
`np` is not in scope.

---

### `docs_path`

**Type:** `str | null` — default `null`

Filesystem path to the narrative documentation source tree (the
directory containing `.rst` files).  `~` is expanded.  When set, `papyri
gen` walks this tree and includes the narrative pages in the bundle.

```toml
docs_path = '~/dev/numpy/doc/source'
```

---

### `narrative_exclude`

**Type:** `list[str]` — default `[]`

Path fragments to skip inside `docs_path`.  Any `.rst` file whose path
contains one of these strings is excluded from the bundle.

```toml
narrative_exclude = [
    'doc/source/reference/arrays.ndarray.rst',  # exact relative path
    'doc/source/_templates/',                    # whole directory prefix
    'doc/source/user/how-to-how-to.rst',
]
```

---

### `examples_folder`

**Type:** `str | null` — default `null`

Filesystem path to a directory of Python example scripts to include in
the bundle.  `~` is expanded.  The scripts are executed and their
outputs (including plots) are captured.

```toml
examples_folder = '~/dev/matplotlib/examples/'
```

---

### `examples_exclude`

**Type:** `list[str]` — default `[]`

Relative paths (inside `examples_folder`) to skip.  The match is a
suffix test against the example file's path string.

```toml
examples_exclude = [
    'logos2.py',
    'multipage_pdf.py',
    'units/artist_tests.py',
    'axisartist/demo_parasite_axes2.py',
]
```

---

### `logo`

**Type:** `str | null` — default `null`

Path to the package logo, relative to the config file.  The logo is
embedded in the bundle and displayed by the viewer.

```toml
logo = 'img/numpy_logo.png'
```

---

### `wait_for_plt_show`

**Type:** `bool | null` — default `true`

When `true`, papyri waits for `matplotlib.pyplot.show()` calls inside
example blocks to complete before moving on, ensuring that figure
output is captured.  Set to `false` when matplotlib examples do not
call `plt.show()` or when captures are handled another way.

```toml
wait_for_plt_show = false
```

---

### `source`

**Type:** `str | null` — default `null`

URL of the project's source repository.  Informational; stored in the
bundle metadata.

```toml
source = 'https://github.com/numpy/numpy'
```

---

### `homepage`

**Type:** `str | null` — default `null`

URL of the project's homepage.  Informational; stored in the bundle
metadata.  If present in both `[global]` and `[meta]`, the `[meta]`
value is authoritative for the viewer.

```toml
homepage = 'https://numpy.org'
```

---

### `docs`

**Type:** `str | null` — default `null`

URL of the project's official rendered documentation.  Informational;
stored in the bundle metadata.

```toml
docs = 'https://numpy.org/doc/stable/'
```

---

### `[global.directives]`

**Type:** `dict[str, str]` — default `{}`

Custom RST directive handlers to register for this bundle.  Keys are
directive names (as they appear in RST, e.g. `mydirective` for
`.. mydirective::`); values are `'module:callable'` strings pointing to
the handler function.

```toml
[global.directives]
mydirective = 'mylib.docs:_mydirective_handler'
```

To silently drop a directive instead of raising an error:

```toml
[global.directives]
testsetup   = 'papyri.directives:drop'
testcleanup = 'papyri.directives:drop'
plot        = 'papyri.directives:drop'
```

The handler callable must accept `(argument, options, content)` and
return an IR node or `None`.

---

## `[meta]` reference

The `[meta]` section holds metadata attached verbatim to the published
bundle.  All keys are optional but recommended for bundles intended for
public consumption.

### `github_slug`

**Type:** `str`

`owner/repo` slug of the project's GitHub repository.  Used by papyri
to construct links to source files and issues.

```toml
github_slug = 'numpy/numpy'
```

---

### `tag`

**Type:** `str`

Git tag template for this bundle's release.  `{version}` is
interpolated with the package version at gen time; `{{version}}`
produces a literal `{version}` in the tag string (useful when the
upstream tag format already contains braces).

```toml
tag = 'v{version}'        # → v1.26.4
tag = '{{version}}'       # → {version}  (for packages that use that convention)
tag = 'networkx-{version}'
```

---

### `pypi`

**Type:** `str`

PyPI distribution name.  Used to construct links to the package on
PyPI.

```toml
pypi = 'numpy'
```

---

### `homepage`

**Type:** `str`

URL of the project's homepage.

```toml
homepage = 'https://numpy.org/'
```

---

### `docspage`

**Type:** `str`

URL of the project's official documentation.

```toml
docspage = 'https://numpy.org/doc/1.26/'
```

---

## `papyri gen` command-line reference

All command-line options are passed in addition to (or as overrides of)
the TOML config.

```
papyri gen [OPTIONS] FILE
```

| Option | Default | Description |
|---|---|---|
| `FILE` | — | Path to the `.toml` configuration file. **Required.** |
| `--infer / --no-infer` | `true` | Override `infer` from the config. |
| `--exec / --no-exec` | config value | Override `execute_doctests` from the config. |
| `--debug` | `false` | Enable debug-level logging. |
| `--no-progress` | `false` | Disable progress bars (useful in CI or with `ipdb`). |
| `--dry-run` | `false` | Parse and collect, but do not write any output to disk. |
| `--api / --no-api` | `true` | Include / skip the API documentation pass. |
| `--examples / --no-examples` | `true` | Include / skip the examples pass. |
| `--narrative / --no-narrative` | `true` | Include / skip the narrative documentation pass. |
| `--fail` | `false` | Fail on the first error encountered. |
| `--fail-early` | `false` | Override `early_error` from the config (same effect as setting `early_error = true`). |
| `--fail-unseen-error` | `false` | Fail if any exception type not listed in `expected_errors` is raised. |
| `--only TEXT` | all objects | Restrict generation to this qualified name (repeatable). |
| `--upload` | `false` | After generation, upload the bundle to `$PAPYRI_UPLOAD_URL`. |
| `--pack` | `false` | After generation, write a `.papyri` artifact in the current directory. |

### Environment variables read by `papyri gen --upload`

| Variable | Default | Description |
|---|---|---|
| `PAPYRI_UPLOAD_URL` | `http://localhost:4321/api/bundle` | Viewer ingest endpoint. |
| `PAPYRI_UPLOAD_TOKEN` | — | Bearer token for the ingest endpoint. |

---

## `papyri upload` command-line reference

```
papyri upload [OPTIONS] PATH [PATH ...]
```

Each `PATH` may be:

- A `.papyri` artifact (produced by `papyri pack`).
- A `.zip` file containing exactly one `.papyri` artifact.
- A DocBundle directory (output of `papyri gen`), packed on the fly.

| Option | Default | Description |
|---|---|---|
| `--url` / `-u` | `http://localhost:4321/api/bundle` | Viewer ingest endpoint URL. Overridden by `$PAPYRI_UPLOAD_URL`. |
| `--token` / `-t` | — | Bearer token for `/api/bundle` authentication. Overridden by `$PAPYRI_UPLOAD_TOKEN`. Omit for local dev instances with no auth. |
| `--verbose` / `-v` | `false` | Show per-step packing progress when building a bundle on the fly. |

### Environment variables

| Variable | Description |
|---|---|
| `PAPYRI_UPLOAD_URL` | Overrides `--url`. |
| `PAPYRI_UPLOAD_TOKEN` | Overrides `--token`. |

---

## `papyri pack` command-line reference

```
papyri pack [OPTIONS] [BUNDLE_DIR]
```

Validates a DocBundle directory and writes a deterministic `.papyri`
artifact (gzipped canonical-CBOR `Bundle` node).  Running pack twice on
the same input produces byte-identical output.

If `BUNDLE_DIR` is omitted, every directory under `~/.papyri/data/` is
packed in turn.

| Option | Default | Description |
|---|---|---|
| `BUNDLE_DIR` | all bundles under `~/.papyri/data/` | DocBundle directory to pack. |
| `--output` / `-o` | `<module>-<version>.papyri` in cwd | Output file path or directory (single-bundle mode only). |
| `--verbose` / `-v` | `false` | Show per-step progress. |

---

## Full annotated example

The following file shows every `[global]` key in one place with
commentary.

```toml
[global]
# ── required ──────────────────────────────────────────────────────────────
module = 'mylib'

# ── discovery ─────────────────────────────────────────────────────────────
# Extra submodules to walk (relative to `module`).
submodules = ['io', 'utils']

# Completely skip these objects (no collection, no execution, no IR entry).
exclude = [
    'mylib.internal:_PrivateHelper',
    'mylib.compat',
]

# ── doctest execution ──────────────────────────────────────────────────────
execute_doctests = true

# What to do when a doctest raises unexpectedly: 'raise' or 'fallback'.
exec_failure = 'fallback'

# Skip execution for these prefixes (object still documented).
execute_exclude_patterns = [
    'mylib._',                   # all private submodules
    'mylib.heavy:slow_function', # a specific function
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

# ── error handling ─────────────────────────────────────────────────────────
# Abort on first unexpected error (override with --fail-early).
early_error = false

# ── narrative docs ─────────────────────────────────────────────────────────
# Path to .rst source tree. ~ is expanded.
docs_path = '~/dev/mylib/docs/source'

# Skip these paths inside docs_path.
narrative_exclude = [
    '_build/',
    '_templates/',
    'api/generated/',
]

# ── examples ───────────────────────────────────────────────────────────────
# Directory of standalone example scripts.
examples_folder = '~/dev/mylib/examples/'

# Skip these files inside examples_folder (suffix match).
examples_exclude = [
    'slow_demo.py',
    'requires_gpu/demo.py',
]

# ── appearance ─────────────────────────────────────────────────────────────
# Path to the logo, relative to the config file.
logo = 'img/mylib_logo.png'

# ── informational URLs ──────────────────────────────────────────────────────
source   = 'https://github.com/myorg/mylib'
homepage = 'https://mylib.readthedocs.io/'
docs     = 'https://mylib.readthedocs.io/en/stable/'

# ── per-object short-name aliases pre-imported before each example ─────────
[global.implied_imports]
ml = 'mylib'
np = 'numpy'
pd = 'pandas'

# ── known failures (build succeeds despite these errors) ──────────────────
[global.expected_errors]
WrongTypeAtField = [
    'mylib.io:read_csv',
]
IncorrectInternalDocsLen = [
    'mylib.utils:_internal_helper',
]

# ── custom RST directives ──────────────────────────────────────────────────
[global.directives]
# Register a custom handler:
myspecial = 'mylib.docs:_myspecial_handler'
# Silently drop directives that papyri doesn't support:
testsetup   = 'papyri.directives:drop'
testcleanup = 'papyri.directives:drop'

# ── bundle metadata ────────────────────────────────────────────────────────
[meta]
github_slug = 'myorg/mylib'
tag         = 'v{version}'
pypi        = 'mylib'
homepage    = 'https://mylib.readthedocs.io/'
docspage    = 'https://mylib.readthedocs.io/en/stable/'
```
