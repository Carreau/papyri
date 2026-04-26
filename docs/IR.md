# Papyri IR format

This document describes the on-disk intermediate representation (IR)
that `papyri gen` writes — i.e. a *DocBundle*. The IR is the contract
between `papyri gen` (run by a library maintainer) and any downstream
consumer (the in-tree `viewer/`, the central ingest service, or any
future out-of-tree tool).

What the central service does with bundles after they arrive — how it
indexes them, links them, or stores them — is not part of the IR and
is not described here.

The code of record is `papyri/gen.py`, `papyri/node_base.py`, and
`papyri/nodes.py`.

## Encoding

Papyri uses two encodings inside a bundle:

- **CBOR** (via `cbor2`) for all IR node graphs — everything that flows
  through `Encoder` in `papyri/nodes.py`. This covers API docs,
  narrative docs, and examples.
- **JSON** for small, human-authored or human-inspectable bundle
  metadata — `papyri.json` and `toc.json`.

The split is intentional: IR payloads are large, deeply nested, and
change shape frequently, so CBOR (typed tags, binary) is cheaper and
safer than JSON. Bundle-level metadata is small configuration, so JSON
is fine.

JS consumers therefore need both a JSON parser and a CBOR library (e.g.
`cbor-x`).

## Gen bundle layout

`papyri gen <cfg.toml>` writes to `~/.papyri/data/<module>_<version>/`.
See `papyri/gen.py` (`DocBundler.write`, line ~1540) for the writer side.

```
<module>_<version>/
├── papyri.json           # bundle metadata (JSON)
├── toc.json              # narrative TOC (JSON, optional)
├── module/               # API docs
│   ├── <qualname>.cbor   # one GeneratedDoc per qualified name
│   └── ...
├── docs/                 # narrative docs
│   ├── <name>            # one GeneratedDoc (CBOR) per narrative page
│   └── ...
├── examples/             # gallery / standalone examples
│   ├── <name>            # one Section (CBOR) per example
│   └── ...
└── assets/               # binary assets (images, logos) referenced by IR
    └── ...
```

### `papyri.json`

Top-level bundle metadata (JSON). Written by `DocBundler.write` from
`self._meta`. Known fields (non-exhaustive — consumers should tolerate
extra keys):

| Field     | Type            | Notes                                                   |
| --------- | --------------- | ------------------------------------------------------- |
| `module`  | `str`           | Root package name, e.g. `"numpy"`.                      |
| `version` | `str`           | Package version string, e.g. `"2.1.3"`.                 |
| `logo`    | `str \| null`   | Asset filename under `assets/`, or null.                |
| `tag`     | `str`           | Release tag, defaults to `version` if not templated.    |
| `aliases` | `dict[str,str]` | `long qualname -> canonical short qualname` alias map.  |

### `toc.json`

Present when the bundle has narrative docs. Two keys:

- `tree`: nested dict describing the narrative section hierarchy
  (produced by `papyri.toc.make_tree`).
- `titles`: flat `dict[str, str]` mapping each narrative document key to
  its rendered title.

### `module/<qualname>.cbor`

One CBOR-encoded `GeneratedDoc` (`papyri/gen.py`, `@register(4011)`) per
documented Python qualified name. `<qualname>` is the full dotted path,
e.g. `numpy.linspace.cbor`. The on-disk basename matches the qualname
exactly; colons are permitted (used for method qualifiers).

Key fields of `GeneratedDoc`:

- `_content: Dict[str, Section]` — numpydoc-style sections keyed by name
  (`"Parameters"`, `"Returns"`, `"Summary"`, `"Extended Summary"`,
  `"Notes"`, `"Examples"`, `"See Also"`, `"Raises"`, `"Yields"`,
  `"Receives"`, `"Attributes"`, `"Methods"`, `"Warns"`, `"Warnings"`,
  `"References"`, `"Signature"`). See the `sections` class attribute on
  `GeneratedDoc` for the canonical ordered list.
- `_ordered_sections: List[str]` — keys of `_content` in source order;
  paired with `_content` to preserve ordering across CBOR roundtrips.
- `example_section_data: Section` — examples extracted out-of-band,
  separate from `_content["Examples"]`.
- `item_file: Optional[str]` / `item_line: Optional[int]` — source file
  and line number, when resolvable (used for "view source" links).
- `item_type: Optional[str]` — one of `"module"`, `"class"`,
  `"function"`, `"method"`, etc.
- `aliases: List[str]` — list of alias qualnames that point to this item.
- `see_also: List[SeeAlsoItem]` — see-also entries; each is an `CrossRef` +
  description paragraphs + optional `:func:`-style type.
- `signature: Optional[SignatureNode]` — structured callable signature
  (see `papyri/signature.py`).
- `references: Optional[List[str]]` — explicit cross-reference targets.
- `arbitrary: List[Section]` — trailing sections that are not standard
  numpydoc sections (module-level narrative, etc.).

### `docs/<name>` and `examples/<name>`

Narrative docs (`docs/`) are `GeneratedDoc` blobs encoded the same way as
`module/*.cbor`, minus a meaningful `signature` and numpydoc-style
section set; narrative content lives in `arbitrary`.

Examples (`examples/`) are bare `Section` blobs — one section per
standalone example file.

#### Tutorials convention

Narrative documents of kind "tutorial" do not get a dedicated IR field
or directory; they are stored alongside the rest of the narrative under
`docs/`. Consumers that need to split tutorials out (the viewer's
sidebar, for instance) filter by filename convention:

- Files whose basename starts with `tutorial_` (e.g.
  `docs/tutorial_intro`) are treated as tutorials.
- Files that sit under a `tutorials/` path component (e.g.
  `docs/tutorials/intro`) are treated as tutorials.

Authors pick either convention when laying out their source docs.
Promoting this to a first-class IR field is a future change — flagging
it here so the convention stays stable in the meantime.

### `assets/`

Raw bytes. Images, logos, etc. Referenced from IR via the `Figure`
node, which carries a `RefInfo(module, version, "assets", filename)`.

The subdirectory names under a bundle — `module`, `docs`, `examples`,
`assets` — also serve as the `kind` discriminator on `RefInfo`
(below).

### RefInfo

`RefInfo(module, version, kind, path)` (`papyri/nodes.py`) is the
in-IR reference: it appears inside `GeneratedDoc` nodes as the target
of a cross-reference. The `Figure.value` field, for example, is a
`RefInfo`. The four fields address a blob inside a bundle
(`<module>/<version>/<kind>/<path>`), and a `RefInfo` is the only
form a cross-reference takes in the IR.

## Node type registry (CBOR tags)

Every serializable IR node has a unique CBOR tag declared by
`@register(<int>)` in `papyri/node_base.py`. The global tag map is
`TAG_MAP` / `REV_TAG_MAP`; `Encoder` (`papyri/nodes.py`) wraps
`cbor2.dumps` / `cbor2.loads` so each tagged blob is decoded back into
the right Python class.

Currently registered (see the `@register(...)` decorators — grep for them
for the authoritative list):

| Tag  | Class              | Module       |
| ---- | ------------------ | ------------ |
| 4000 | `RefInfo`          | `nodes.py`   |
| 4001 | `Root`             | `nodes.py`   |
| 4002 | `CrossRef`             | `nodes.py`   |
| 4003 | `InlineRole`       | `nodes.py`   |
| 4011 | `GeneratedDoc`     | `gen.py`     |
| 4012 | `NumpydocExample`  | `nodes.py`   |
| 4013 | `NumpydocSeeAlso`  | `nodes.py`   |
| 4014 | `NumpydocSignature`| `nodes.py`   |
| 4015 | `Section`          | `nodes.py`   |
| 4016 | `DocParam`         | `nodes.py`   |
| 4017 | `UnimplementedInline` | `nodes.py` |
| 4018 | `Unimplemented`    | `nodes.py`   |
| 4019 | `ThematicBreak`    | `nodes.py`   |
| 4020 | `Heading`          | `nodes.py`   |
| 4021 | `TocTree`          | `nodes.py`   |
| 4024 | `Figure`              | `nodes.py`   |
| 4026 | `Parameters`       | `nodes.py`   |
| 4027 | `SubstitutionDef`  | `nodes.py`   |
| 4028 | `SeeAlsoItem`      | `nodes.py`   |
| 4029 | `SignatureNode`    | `signature.py` |
| 4030 | `SigParam`         | `signature.py` |
| 4031 | `Empty`            | `signature.py` |
| 4033 | `DefList`          | `nodes.py`   |
| 4034 | `Options`          | `nodes.py`   |
| 4035 | `FieldList`        | `nodes.py`   |
| 4036 | `FieldListItem`    | `nodes.py`   |
| 4037 | `DefListItem`      | `nodes.py`   |
| 4041 | `SubstitutionRef`  | `nodes.py`   |
| 4045 | `Paragraph`        | `nodes.py`   |
| 4046 | `Text`             | `nodes.py`   |
| 4047 | `Emphasis`         | `nodes.py`   |
| 4048 | `Strong`           | `nodes.py`   |
| 4049 | `Link`             | `nodes.py`   |
| 4050 | `Code`             | `nodes.py`   |
| 4051 | `InlineCode`       | `nodes.py`   |
| 4052 | `Directive`        | `nodes.py`   |
| 4053 | `BulletList`       | `nodes.py`   |
| 4054 | `ListItem`         | `nodes.py`   |
| 4055 | `AdmonitionTitle`  | `nodes.py`   |
| 4056 | `Admonition`       | `nodes.py`   |
| 4057 | `InlineMath`       | `nodes.py`   |
| 4058 | `Math`             | `nodes.py`   |
| 4059 | `Blockquote`       | `nodes.py`   |
| 4060 | `Comment`          | `nodes.py`   |
| 4061 | `Target`           | `nodes.py`   |
| 4062 | `Image`            | `nodes.py`   |
| 4063 | `CitationReference` | `nodes.py`  | `label: str` |
| 4064 | `Citation`         | `nodes.py`   | `label: str`, `children: list[Paragraph]` |
| 4444 | `tuple` (built-in) | `nodes.py`   |

Tag `4444` is a special case: `register(tuple)(4444)` at the top of
`papyri/nodes.py` teaches the encoder to round-trip bare Python tuples
through CBOR so that sequence fields typed as `List[...]` vs tuple are
preserved. Non-Python consumers can treat it as an array.

`UnprocessedDirective`, `GenCode`, and `GenToken` inherit from
`UnserializableNode` — they are gen-time intermediates; reaching the
CBOR encoder with any of them is a bug. See
`node_base.UnserializableNode` for the invariant.

## Stability

The IR is **not yet stable**. Tag numbers are stable only once
assigned (never reuse a retired tag number), but field sets on
individual nodes change as gen evolves. Consumers should:

- Use `cbor2` tag-hook-based decoding via `papyri.nodes.Encoder` if
  running in Python; the encoder tolerates unknown trailing fields via
  `Node.__init__` kwargs validation.
- Treat `papyri.json` / `toc.json` as forward-compatible: ignore
  unknown keys.

Stabilizing the schema (versioning + a `docs/IR-CHANGELOG.md`,
possibly JSON Schema fragments per node) is tracked in `PLAN.md`
Phase 2.
