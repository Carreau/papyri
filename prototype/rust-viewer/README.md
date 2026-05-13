# papyri-rust-viewer (prototype)

A throwaway prototype of the "what if we built the viewer in Rust" branch
discussed in `claude/explore-tech-stack-SI7Zw`. It is **not** part of the
shipped product — `viewer/` (TS/Astro) remains the reference implementation.
This exists to let us *feel* the alternative end-to-end before deciding
anything.

## Stack

| Concern    | Choice                                                      |
| ---------- | ----------------------------------------------------------- |
| HTTP       | `axum` + `tokio`                                            |
| Templates  | `maud` — compile-time-checked HTML                          |
| IR codec   | `ciborium` + `flate2` (gzip + canonical CBOR, same as pack) |
| Index      | `rusqlite` in-memory, FTS5 virtual table                    |
| Frontend   | Server-rendered HTML, no JS, no build step                  |

Same single static binary deploys anywhere — not just Cloudflare.

## Layout

```
prototype/rust-viewer/
├── Cargo.toml
├── src/
│   ├── main.rs        # axum app, routes
│   ├── ir.rs          # CBOR → typed IR (tag map mirrors ingest/src/encoder.ts)
│   ├── render.rs      # IR → HTML via maud
│   └── db.rs          # SQLite cross-link index (single-bundle stub)
├── templates/style.css
└── fixtures/
    ├── make_fixture.py    # builds demo.papyri (gzip+CBOR Bundle, tag 4070)
    └── demo.papyri
```

## Run

```sh
# (re)generate the synthetic bundle, if you don't trust the checked-in one
python3 prototype/rust-viewer/fixtures/make_fixture.py \
    prototype/rust-viewer/fixtures/demo.papyri

cd prototype/rust-viewer
cargo run -- fixtures/demo.papyri
# → http://127.0.0.1:8765
```

Multiple bundles work too:

```sh
cargo run -- one.papyri two.papyri three.papyri
```

## What it covers

- Load a `.papyri` artifact (gzip + CBOR) into typed Rust IR nodes.
- Render `Section`, `Paragraph`, `Heading`, `Text`, `InlineCode`, `Code`,
  `Emphasis`, `Strong`, `Link`, `BulletList`/`ListItem`, `ThematicBreak`,
  `Directive`. Unknown IR tags fall through to a visible `[tag]` placeholder
  rather than crashing.
- Render a function `Signature` (4029) with positional/keyword params.
- Per-module API and narrative pages.
- Prefix search across all loaded bundles via SQLite FTS5.

## What it deliberately does not cover

- No ingest pipeline (no `RefInfo` resolution, no cross-bundle links).
- No persistent storage — index is in-memory, rebuilt on each start.
- No syntax highlighting, no MathJax/KaTeX, no asset serving.
- No upload endpoint.
- Only the IR tags my synthetic fixture exercises are decoded richly.

## Where the IR contract lives

The CBOR tag table in `src/ir.rs` mirrors
`ingest/src/encoder.ts::FIELD_ORDER`. If a tag's field list changes there,
update it here too — there is no shared schema source (yet). One of the
arguments for the Rust direction is that ingest *and* render could share
a single `serde`-derived schema crate; this prototype does not yet do that.

## Tradeoffs surfaced by building this

- **Wins**: single binary, zero JS, no build pipeline beyond `cargo`,
  fast startup, ergonomic templates, ingest and render can share types.
- **Costs**: existing TS ingest pipeline would need a port (real work, the
  IR tag table is the easy part — `RefInfo` resolution and the graph are
  not). Smaller docs-tooling ecosystem (syntect ≠ Shiki, KaTeX via WASM).
- **Open question**: does the hosted service want a single Rust binary
  fronting Postgres, or many small workers behind a queue? Not answered
  by this prototype.
