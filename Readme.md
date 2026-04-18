# Papyri

**Papyri** parses Python library docstrings into an **intermediate
representation (IR)** and ingests many libraries' IR into a local
cross-linked SQLite graph.

---

> **Project status (2026): revival in progress.** The last upstream release
> was `0.0.8` (March 2024). The scope of this repo has been narrowed to
> "Python IR producer + local graph store" — all rendering (HTML, terminal,
> TUI, JupyterLab) has been removed and is expected to live in a future
> separate Node/React project that reads the IR directly. See `PLAN.md`.
>
> The core `gen` / `ingest` pipeline works on Python 3.14; older Pythons are
> explicitly unsupported.

| Information | Links |
| :---------- | :-----|
|   Project   | [![License](https://img.shields.io/badge/License-MIT-gray.svg?colorA=2D2A56&colorB=5936D9&style=flat.svg)](https://opensource.org/license/mit/) |
|     CI      | [![Python Package](https://github.com/carreau/papyri/actions/workflows/python-package.yml/badge.svg)](https://github.com/carreau/papyri/actions/workflows/python-package.yml) [![Linting](https://github.com/carreau/papyri/actions/workflows/lint.yml/badge.svg)](https://github.com/carreau/papyri/actions/workflows/lint.yml) |

Papyri aims to allow:
- bidirectional crosslinking across libraries,
- navigation,
- proper reflow of user docstring text,
- proper math handling,
- and more — via a stable intermediate representation that downstream
  renderers can consume.

## Motivation

See some of the reasons behind the project on [this blog post](https://labs.quansight.org/blog/2021/05/rethinking-jupyter-documentation/).

Key motivation is building a set of tools to build better documentation for Python projects.
  - Uses an opinionated implementation to enable better understanding about the structure of your project.
  - Allow automatic cross-links (back and forth) between documentation across Python packages.
  - Use a documentation IR (intermediate representation) to separate building the docs from rendering the docs in many contexts.

This approach should hopefully allow a conda-forge-like model, where projects
upload their IR to a given repo, a _single website_ that contains documentation
for multiple projects (without sub domains). The documentation pages can then
be built with better cross-links between projects, and _efficient_ page rebuild.

## Overview Presentation

And this [small presentation at CZI EOSS4 meeting in early november 2021](https://docs.google.com/presentation/d/1sSh44smooCiOlj0-Zrac9n5KX0K_ABBFznDmMIwUnbM/edit?usp=sharing).

---

## Table of contents

- [Installation](#installation)
- [Usage](#usage)
- [Architecture](#architecture)
- [When things don't work](#when-things-dont-work)

## Installation

Papyri is `pyproject.toml`-driven and requires Python **3.14+**.

### Development installation (recommended)

The project has not been re-cut on PyPI in over a year and is evolving faster
than releases. Install from a clone:

```
git clone https://github.com/carreau/papyri
cd papyri
pip install -e .
```

RST parsing uses the PyPI `tree-sitter-rst` wheel on top of
`tree-sitter >= 0.24`; both are pulled in as regular dependencies.

Verify with:

```
papyri --help
```

### Installation from PyPI

`pip install papyri` will install `0.0.8` from March 2024. It predates the
revival described in `PLAN.md` — prefer the development install above.

### Testing

Install extra development dependencies:

```bash
$ pip install -r requirements-dev.txt
```

Run tests using:

```bash
$ python -m pytest -m "not postingest"
```

(Using `python -m pytest` ensures the test runner uses the same interpreter as
your editable install, avoiding `ModuleNotFoundError: tomli_w` if you have a
separate `pytest` on `$PATH`.)

The `postingest` tests require `papyri ingest` to have populated
`~/.papyri/ingest/` first; see the CI workflow for the full sequence.

## Usage

Papyri has two stages:

 - IR generation (executed by package maintainers);
 - IR ingestion into the local cross-linked graph (executed by end users).

Rendering is out of scope for this repo.

### IR Generation (`papyri gen`)

This is the step you want to trigger if you are building documentation using
Papyri for a library you maintain.

The Toml files in `examples` will give you example configurations from some
existing libraries.

```
$ ls -1 examples/*.toml
examples/IPython.toml
examples/astropy.toml
examples/dask.toml
examples/matplotlib.toml
examples/numpy.toml
examples/papyri.toml
examples/scipy.toml
examples/skimage.toml
```

> [!NOTE]
> It is _slow_ on full numpy/scipy; use `--no-infer` (see below) for a subpar
> but faster experience.

Use `papyri gen <path to example file>`:

```
$ papyri gen examples/numpy.toml
```

This will create intermediate docs files in
`~/.papyri/data/<library name>_<library_version>`. See
[Generation](#generation-papyri-gen) for more details.

You can also generate intermediate docs files for a subset of objects using
the `--only` flag:

```
$ papyri gen examples/numpy.toml --only numpy:einsum
```

> [!IMPORTANT]
> To avoid ambiguity, papyri uses [fully qualified names](#qualified-names)
> to refer to objects. You need to use `numpy:einsum` instead of `einsum` or
> `numpy.einsum` to refer to the `einsum` function in the `numpy` module.

### Ingestion (`papyri ingest`)

The ingestion step makes all bundles "aware" of each other, and allows
crosslinking/indexing to work.

You can ingest local folders with:

```
$ papyri ingest ~/.papyri/data/<path to folder generated at previous step>
```

This will crosslink the newly generated folder with the existing ones.
Ingested data can be found in `~/.papyri/ingest/` but you are not supposed
to interact with this folder with tools external to papyri.

## Papyri - Name's meaning

See the legendary [Villa of Papyri](https://en.wikipedia.org/wiki/Villa_of_the_Papyri), which gets its name from its
collection of many papyrus scrolls.

## Architecture

### Generation (`papyri gen`)

Collects the documentation of a project into a *DocBundle* -- a number of
*DocBlobs* (currently json files with CBOR-encoded fields in some places),
with a defined semantic structure, and some metadata (version of the project
this documentation refers to, and potentially some other blobs).

During the generation a number of normalisation and inference steps can and
should happen. For example:

  - Using type inference into the `Examples` sections of docstrings and storing
    those as pairs (token, reference), so that a later renderer can decide
    that clicking on `np.array` in an example brings you to numpy array
    documentation — whether or not we are currently in the numpy documentation;
  - Parsing "See Also" into a well defined structure;
  - Running examples to generate images for docs with images (partially
    implemented);
  - Resolve local references. For example, when building the NumPy docs,
    `zeroes_like` is non-ambiguous and should be normalized to
    `numpy.zeroes_like`. Similarly, `~.pyplot.histogram`, should be normalized
    to `matplotlib.pyplot.histogram` as the **target** and `histogram` as the
    text.

The Generation step is likely project specific, as there might be import
conventions that are defined per-project and should not need to be repeated
(`import pandas as pd`, for example.)

The generation step results in, for each project:

- A `papyri.json` file, listing unique qualified names for documented objects;
- A `toc.json` file;
- An `assets` folder, containing images generated during generation;
- A `docs` folder;
- An `examples` folder;
- A `module` folder, containing one json file per documented object.

### Ingestion (`papyri ingest`)

The ingestion step takes a DocBundle and adds it into a SQLite graph of known
items; the ingestion is critical to efficiently build the collection graph
metadata and understand which items refer to which. This allows:

 - Update the list of backreferences to a *DocBundle*;
 - Update forward references metadata to know whether links are valid.

### Qualified names

To avoid ambiguity when referring to objects, papyri uses the
*fully qualified name* of the object for its operations. This means that instead
of a dot (`.`), we use a colon (`:`) to separate the module part from the
object's name and sub attributes.

To understand why we need this, assume the following situation: a top level
`__init__` imports a function from a submodule that has the same name as the
submodule:

```
# project/__init__.py
from .sub import sub
```

This submodule defines a class (here we use lowercase for the example):

```
# project/sub.py
class sub:
    attribute:str
attribute = 'hello'
```

and a second submodule is defined:
```
# project/attribute.py
None
```

Using qualified names only with dots (`.`) can make it difficult to find out
which object we are referring to, or implement the logic to find the object.
For example, to get the object `project.sub.attribute`, one would do:

```
import project
x = getattr(project, 'sub')
getattr(x, 'attribute')
```

But here, because of the `from .sub import sub`, we end up getting the class
attribute instead of the module. This ambiguity is lifted with a `:` as we now
explicitly know the module part, and `package.sub.attribute` is distinct from
`package.sub:attribute`. Note that `package:sub.attribute` is also
non-ambiguous, even if not the right fully qualified name for an object.

Moreover, using `:` as a separator makes the implementation much easier, as
in the case of `package.sub:attribute` it is possible to directly execute
`importlib.import_module('package.sub')` to obtain a reference to the `sub`
submodule, without try/except or recursive `getattr` checking for the type of an
object.

### Tree sitter information

See https://tree-sitter.github.io/tree-sitter/creating-parsers

## When things don't work

#### `SqlOperationalError`

The DB schema likely has changed. Try: `rm -rf ~/.papyri/ingest/` and
re-ingest.

#### `ModuleNotFoundError: No module named 'tomli_w'` when running `pytest`

Your `pytest` entry point is from a different Python than the one you
installed papyri into. Run tests via `python -m pytest` instead.
