# Papyri

**Papyri** is a Python tool that parses library docstrings into a portable
**intermediate representation (IR)**, enabling documentation to be built once
and rendered many times — independently, and across projects.

---

> **Project status (2026): active development.** Core `gen` / `ingest`
> pipeline works on Python 3.14. A local web viewer lives under `viewer/`.
> See `PLAN.md` for roadmap.

| Information | Links |
| :---------- | :-----|
|   Project   | [![License](https://img.shields.io/badge/License-MIT-gray.svg?colorA=2D2A56&colorB=5936D9&style=flat.svg)](https://opensource.org/license/mit/) |
|     CI      | [![Python Package](https://github.com/carreau/papyri/actions/workflows/python-package.yml/badge.svg)](https://github.com/carreau/papyri/actions/workflows/python-package.yml) [![Linting](https://github.com/carreau/papyri/actions/workflows/lint.yml/badge.svg)](https://github.com/carreau/papyri/actions/workflows/lint.yml) |
| Coverage | [![codecov](https://codecov.io/gh/carreau/papyri/branch/main/graph/badge.svg)](https://codecov.io/gh/carreau/papyri) |

---

## The problems this project solves

### 1. Build and render are coupled in Sphinx

In the standard Sphinx workflow, *parsing documentation* and *rendering it to
HTML* happen in the same step. This means:

- Fixing an HTML template (e.g. for accessibility) requires a full rebuild of
  every project that uses it — which means reinstalling the project, its
  dependencies, and re-executing all examples.
- The rendering environment must match the build environment.
- There is no reusable artifact between "what the project documents" and "how
  it looks".

Papyri separates these two concerns:

1. **IR generation** (`papyri gen`) — run **per project**, by the library
   maintainer, in the project's own CI or build environment. Produces a
   self-contained *DocBundle* capturing the documented API in a structured,
   renderer-agnostic format.
2. **Rendering** — a separate, stateless process that reads DocBundles and
   produces HTML. Updating the renderer never requires touching the original
   source or re-running the project's build environment.

### 2. Documentation is fragmented across domains

Every Python library hosts its docs on a separate subdomain
(`numpy.org/doc`, `docs.scipy.org`, `pandas.pydata.org/docs`, …).
This makes it hard to:

- Search across projects in one place.
- Follow cross-package links without leaving the current domain.
- Keep those cross-links valid when upstream APIs change.

Papyri's model (inspired by conda-forge) is:

- Each library maintainer runs `papyri gen` in their project's CI and uploads
  the resulting DocBundle to a central service.
- The central service runs `papyri ingest` to wire bundles together, then
  serves them all from one place with real bidirectional cross-links between
  packages.

The `viewer/` directory in this repo is being built with this centralized
model in mind. It currently works locally for development and debugging, and
its design is intended to evolve into — or directly inform — the hosted
service.

---

## Table of contents

- [Installation](#installation)
- [Usage](#usage)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [When things don't work](#when-things-dont-work)

## Installation

Papyri requires Python **3.14+** and is `pyproject.toml`-driven.

### Development installation (recommended)

The project has not been re-cut on PyPI recently and evolves faster than
releases. Install from a clone:

```
git clone https://github.com/carreau/papyri
cd papyri
pip install -e .
```

RST parsing uses `tree-sitter-rst` on top of
`tree-sitter >= 0.24`; both are pulled in as regular dependencies.

Verify with:

```
papyri --help
```

### Installation from PyPI

`pip install papyri` installs `0.0.8` (March 2024), which predates the
current architecture. Prefer the development install above.

### Testing

```bash
pip install -r requirements-dev.txt
python -m pytest -m "not postingest"
```

Use `python -m pytest` (not bare `pytest`) to ensure the same interpreter as
your editable install.

The `postingest` tests require a populated `~/.papyri/ingest/`; see the CI
workflow for the full sequence.

---

## Usage

Papyri has two stages that run in different contexts:

- **IR generation** (`papyri gen`) — run **per project**, by the library
  maintainer, in the project's own environment (typically CI). Produces a
  DocBundle and uploads it.
- **IR ingestion** (`papyri ingest`) — run by the **central service** (or
  locally for development) to wire multiple bundles together into a
  cross-linked graph.

Rendering is handled by the `viewer/` web app, which reads the ingested graph.
It is not part of the Python package itself.

### IR Generation (`papyri gen`)

The TOML files in `examples/` show configuration for several real libraries:

```
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
> Full numpy/scipy generation is slow. Use `--no-infer` for a faster run
> that skips type-inference on examples.

```
papyri gen examples/numpy.toml
```

Output lands in `~/.papyri/data/<library>_<version>/`.

Generate docs for a single object:

```
papyri gen examples/numpy.toml --only numpy:einsum
```

> [!IMPORTANT]
> Papyri uses [fully qualified names](#qualified-names) (`numpy:einsum`, not
> `numpy.einsum`) to avoid module/attribute ambiguity.

### Ingestion (`papyri ingest`)

Ingestion adds a bundle into the local cross-linked SQLite graph and resolves
forward and back references across all known bundles.

```
papyri ingest ~/.papyri/data/<bundle-folder>
```

Ingested data lives in `~/.papyri/ingest/`. Do not edit this folder manually.

---

## Architecture

### Generation (`papyri gen`)

Walks the documented API of a project and emits a *DocBundle*: a directory of
per-object JSON/CBOR files (`module/*.cbor`), plus `papyri.json` (manifest),
`toc.json`, `assets/`, `docs/`, and `examples/`.

During generation, normalisation steps run:

- Type inference on `Examples` sections → stored as `(token, reference)` pairs
  so renderers can hyperlink `np.array` to the numpy array page.
- "See Also" parsed into a structured list.
- Local references resolved to fully-qualified names (e.g. `zeros_like` →
  `numpy.zeros_like`).
- Examples executed to capture output images (partially implemented).

### Ingestion (`papyri ingest`)

Takes a DocBundle and merges it into the local SQLite graph
(`~/.papyri/ingest/papyri.db`), updating forward references and
backreferences across all ingested bundles.

### Viewer (`viewer/`)

An Astro + React + TypeScript app that reads the IR from `~/.papyri/data/`
and the SQLite graph. It is the primary way to browse generated docs locally
during development, and is being built with the centralized service in mind:
the same viewer code, or a close derivative, is the intended rendering
frontend for the hosted service.

The boundary between the Python side (gen + ingest) and the rendering side is
the on-disk IR, kept stable so any renderer — local or hosted — can consume
it without changes to the Python package.

### Qualified names

Papyri uses `:` to separate the module path from the attribute path, e.g.
`numpy:einsum` or `package.sub:attribute`. This removes the ambiguity that
arises when a package re-exports names from submodules under the same name,
and makes `importlib.import_module` calls unambiguous.

---

## Contributing

The project is in active development; contributions are very welcome.

The Python side (IR generation and ingestion) is the core focus:

- **IR correctness**: does `papyri gen` faithfully represent a library's API?
- **Cross-link resolution**: does `papyri ingest` correctly wire references
  across packages?
- **IR schema**: see `docs/IR.md` for the current format; help stabilising it
  is valuable.

The `viewer/` app has its own `viewer/PLAN.md` with its own milestone
tracking.

For any change: read `PLAN.md` first, keep PRs small and focused.

---

## Name

See the [Villa of Papyri](https://en.wikipedia.org/wiki/Villa_of_the_Papyri),
named for its collection of many papyrus scrolls.

---

## When things don't work

#### `SqlOperationalError`

The DB schema changed. Run `rm -rf ~/.papyri/ingest/` and re-ingest.

#### `ModuleNotFoundError: No module named 'tomli_w'` when running `pytest`

Your `pytest` is from a different Python than the one papyri is installed
into. Use `python -m pytest` instead.
