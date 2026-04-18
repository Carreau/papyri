# Viewer — HTML serving for ingested papyri IR

This subfolder hosts a **read-only web viewer** that renders pages directly
from the local papyri IR on disk (`~/.papyri/data/<pkg>_<ver>/`) and the
SQLite cross-link graph (`~/.papyri/ingest/papyri.db`).

> Relation to top-level `PLAN.md`: that doc's Phase 3 punted rendering to a
> *separate* repo. This subfolder is a deliberate revision of that decision:
> keep the renderer in-tree but in its own folder so the Python IR and the
> JS/TS renderer evolve together. The top-level `PLAN.md` should be updated
> to reference this directory once the direction is confirmed. Until then,
> treat this as a proposal.

## Goals

1. Serve browsable HTML for every ingested package/module/qualname.
2. Consume the IR **directly** — no Python-side rendering, no new
   intermediate format.
3. Support both a local dev server (for working on papyri) and a static
   export (for publishing a site from a given set of ingested bundles).
4. Stay small. No authoring, no search backend, no database beyond what
   papyri already writes.

## Non-goals (for v0)

- Running or re-executing examples. `papyri gen` produces the captured
  outputs; the viewer only displays them.
- Authentication, multi-tenant hosting, comments, edit-in-browser.
- Full-text search. Start with qualname/prefix search against the graph;
  revisit later.
- Server-side math rendering via `flatlatex` (that was removed on purpose).
- Re-implementing the old `papyri serve` / `serve-static` Quart stack.

## Features

### Must-have (v0)

- **Package index**: list ingested `(pkg, version)` bundles from the graph
  DB.
- **Module / page index**: TOC per bundle, driven by `toc.json`.
- **Qualname page**: signature, parameters, description, see-also, notes,
  examples.
- **Cross-links**: forward links resolve via the graph; 404 → nearest
  match.
- **Back-references**: "used by" / "referenced from" section fed by the
  graph.
- **Math**: KaTeX in the client (swap in for the removed `flatlatex`).
- **Code highlighting**: Python, text, console. Precomputed at build where
  possible.
- **Example blocks**: render captured stdout/plots/HTML assets from the
  bundle's `assets/` dir.
- **Dev server**: hot-reloads when a new bundle is ingested.
- **Static build**: pre-rendered HTML + assets for hosting behind any
  static file server.

### Nice-to-have (later)

- Prefix / fuzzy search (client-side index built at export time).
- Dark mode toggle.
- Permalink copy for any anchor.
- Per-bundle version picker.
- Diff view between versions of the same qualname.

## Tech choices

Leaning toward the minimum that reads the IR cleanly.

| Area            | Choice                        | Why                                             |
| --------------- | ----------------------------- | ----------------------------------------------- |
| Language        | TypeScript                    | Typed IR = fewer renderer bugs                  |
| Runtime         | Node LTS                      | Matches the "future Node project" in `PLAN.md`  |
| Framework       | **Astro** (SSG + SSR islands) | Content-shaped site; minimal JS by default      |
| UI components   | React (inside Astro islands)  | Familiar; matches the original Phase 3 intent   |
| CBOR reader     | `cbor-x`                      | Fast, streaming, TS types                       |
| Graph client    | `better-sqlite3`              | Sync, tiny, reads `papyri.db` directly          |
| Math            | `katex` (client)              | Replaces `flatlatex`; no server dep             |
| Syntax highlight| `shiki`                       | Zero-runtime, VS Code grammars                  |
| Styling         | Plain CSS + CSS custom props  | No Tailwind yet; keep the surface small         |
| Package manager | `pnpm`                        | Workspace-ready if we add a shared IR lib       |
| Lint / format   | ESLint + Prettier             | Standard                                        |
| Tests           | Vitest + Playwright smoke     | Unit for IR reader; e2e for a few golden pages  |

### Alternatives considered

- **Next.js**: heavier, RSC + route conventions don't buy much for a
  content-only site, deploy story is more opinionated.
- **SvelteKit / Remix**: fine, but the main `PLAN.md` calls out React and
  there's no reason to diverge.
- **Plain Express/Fastify + server-rendered React**: more plumbing than
  Astro, no static-export story out of the box.
- **Python-side rendering** (Jinja etc.): out of scope — top-level
  `PLAN.md` explicitly removed this.

## Architecture sketch

```
viewer/
├── PLAN.md                  # this file
├── package.json
├── pnpm-workspace.yaml      # if we split packages later
├── astro.config.ts
├── src/
│   ├── lib/
│   │   ├── ir-reader.ts     # load bundle dir, decode CBOR/JSON, typed IR
│   │   ├── graph.ts         # better-sqlite3 wrapper over papyri.db
│   │   └── paths.ts         # ~/.papyri discovery, env override
│   ├── components/          # React islands: Signature, Param, SeeAlso, …
│   ├── pages/
│   │   ├── index.astro      # list of (pkg, version) bundles
│   │   ├── [pkg]/[ver]/index.astro
│   │   └── [pkg]/[ver]/[...slug].astro   # qualname pages
│   └── styles/
└── tests/
```

Data flow per request/page:

1. Resolve `(pkg, ver, qualname)` from the URL.
2. `ir-reader` loads the matching `module/*.json` (or CBOR) from the
   bundle dir and the referenced `docs/` / `examples/` / `assets/` files.
3. `graph` queries `papyri.db` for forward and back references.
4. Astro page renders structured IR nodes → JSX. No ad-hoc HTML strings.

## Config

- `PAPYRI_DATA_DIR` — defaults to `~/.papyri/data`.
- `PAPYRI_INGEST_DB` — defaults to `~/.papyri/ingest/papyri.db`.
- `--mode dev | build` via Astro.

## Milestones

1. **M0 — scaffolding.** `pnpm init`, Astro app boots, reads
   `~/.papyri/data` and lists bundles. No qualname rendering yet.
2. **M1 — single-page render.** Given `(pkg, ver, qualname)`, render
   signature + description from the IR. No crosslinks.
3. **M2 — crosslinks + backrefs** via `papyri.db`.
4. **M3 — examples, math, syntax highlighting.**
5. **M4 — static export** (`astro build`) verified against a real
   ingested set (numpy, scipy).
6. **M5 — polish**: search, error pages, dark mode.

## Open questions

- Directory name: `viewer/` vs `web/` vs `site/`. Going with `viewer/`
  because it describes intent (view ingested IR) rather than delivery.
- Encoding convergence (top-level `PLAN.md` Phase 2): if everything moves
  to CBOR or everything to JSON, the `ir-reader` gets simpler. Until then,
  it handles both.
- Do we vendor a tiny IR schema doc inside `viewer/` or wait for
  `docs/IR.md` (Phase 2) and consume that?
- Publishing target: GitHub Pages from `viewer/dist/`? Out of scope for
  v0, but the static export should make it trivial.
- Should the viewer have its own CI workflow, or piggyback on the
  existing Python CI? Probably separate, filtered on `viewer/**`.

## Ground rules for this subfolder

- No Python code here. Everything reads the IR produced by the top-level
  `papyri` package.
- No changes to the IR format from inside `viewer/`. If the viewer needs
  a field the IR doesn't expose, raise it against the top-level plan
  (Phase 2) first.
- Keep dependencies tight. Every new runtime dep needs a one-line
  justification in the PR.
