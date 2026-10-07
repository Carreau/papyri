# Viewer design & layout review (2026-09)

A review of the papyri viewer as it renders today, four directions (one incremental, three alternatives), and
clickable prototypes for each. Generated against commit `8a9661c` with IPython 9.17.1
and papyri 0.0.10 ingested into a local dev server.

| File | What it is |
| --- | --- |
| [`01-design-review.md`](01-design-review.md) | Visual system: tokens, contrast (computed WCAG tables for both themes), type scale, components, IR-node skin, brand, accessibility. Ends with a replacement token set + type scale and 15 quick wins. |
| [`02-layout-review.md`](02-layout-review.md) | Information architecture, page templates, sidebar, grid/responsive (measured at 390–1920), navigation, where PLAN.md features land. Ends with page-template / sidebar / responsive specs and 15 quick wins. |
| [`03-benchmarks.md`](03-benchmarks.md) | How docs.rs, pkg.go.dev, hexdocs, pydata, Furo, Material, Docusaurus, Starlight, MDN, Stripe and DevDocs solve each page type, and three coherent directions. |
| [`prototypes/`](prototypes/) | Self-contained HTML prototypes, one directory per direction (see below). Open any `.html` directly in a browser. A single-page gallery that flips between directions, pages, viewport widths and themes is published at <https://claude.ai/code/artifact/9c1ef4e8-f8ca-4b5d-814e-191091b51fb6>; rebuild it locally with `node tools/build-gallery.mjs prototypes /tmp/gallery.html`. |
| [`shots/`](shots/) | Curated screenshots of the current viewer referenced by the reviews. `tools/screenshots.mjs` regenerates the full set (needs Playwright and a running `pnpm dev` with the two bundles). |

## Executive summary

**What is good.** The base palette is sound and passes AA in both themes; the sidebar, search
dialog and version switcher already read as one product; the narrative page is close to the
three-column norm; `links.ts` is a real single source of truth for URLs; the IR-node skin renders
most block constructs calmly.

**The problems that matter (all P1, evidence in the reports):**

1. **Class and module pages are upside-down.** The one-line summary renders *after* a 116-chip
   Members wall; on `InteractiveShell` it lands at y ≈ 1 800 px. Members are an alphabetical,
   private-first, kind-less chip list with no summaries, even though the summaries are already
   fetched by the (always-rendered, 116 sub-requests per view) inline-member islands.
2. **Developer tooling is reader navigation.** "Browse → Text search / Images / Math / Code /
   All nodes", a floating "Raw JSON" button, diagnostics buttons as the only overview content,
   and orange outlined boxes on every unresolved cross-reference inside reader prose.
3. **No prose measure and no "you are here".** 112–155 characters per line on wide screens;
   the API tree sits in a 40 vh inner scroll box inside a scrolling sidebar, so the active item
   is never visible on load at any desktop width.
4. **A second, undefined token vocabulary.** 34 custom properties referenced in admin, login,
   settings and diagnostics pages are defined nowhere, so those pages run on hard-coded light
   fallbacks (grey `#666` at 3.2:1 in dark mode, white-on-`#5ea2eb` buttons at 2.7:1).
5. **Inverted type hierarchy and no scale.** Page titles (20.8 px / 500) are smaller than the
   section headings under them (24 px / 600); 17 font sizes in use; code blocks fall through to
   the UA `monospace 13px`.
6. **Mobile horizontal scroll** on every qualname page (unbreakable `<h1><code>` qualname; the
   two-column member grid clips at 390 px), plus the CSS-only toggles are `aria-hidden` yet
   keyboard-focusable, no skip link, no `:focus-visible` policy, no reduced-motion rule.
7. **Three unrelated searches** (home filter, per-bundle symbol dialog, text-search page) with
   no shared entry point and no `/` or `Ctrl+K`, and no slot for the planned cross-bundle search.

## The four directions

All four prototypes share the *same* token set and type scale (from `01-design-review.md`), so
the comparison is about structure. Every prototype uses real harvested content (the 116
`InteractiveShell` members with their real signatures and summaries, the real `run_cell` page,
the real tutorial and toctree), works in light and dark, has no horizontal scroll from 390 to
1920 px, hides developer tooling behind a "contributor mode" toggle, and includes its own
`README.md` with page anatomy, sidebar/responsive/search behaviour, PLAN.md accommodation and a
migration note listing the `viewer/src/` files that change.

| Direction | One line | Optimises for | Main cost |
| --- | --- | --- | --- |
| **0 · Evolve** | Today's markup + the token set + every quick win. `evolve.css` is a section-for-section drop-in candidate for `global.css` + `ir-nodes.css`. | Lowest risk: one CSS swap plus ~10 template edits, every class name survives. | Global 180-row tree, card-grid home and per-route sidebar stay; the flat member wall becomes a table but the tree still has no sibling collapse. |
| **A · Reference** | docs.rs / pkg.go.dev-style dense reference: per-page left rail (sections → members by kind → siblings → collapsed tree), no right column, kind-grouped `<details>` member tables, metadata strip, search-first home with an upload feed. | API readers at numpy/scipy scale; keyboard users; density that looks intentional. | Narrative docs get the same shell; cross-module orientation relies on trail + siblings + search. |
| **B · Reading-first** | pydata / Furo-style three columns done properly: sticky navbar with section tabs (Guide · API · Examples) and header search, *contextual* left rail (toctree on guide pages, module tree on API pages), "On this page" on every page including API pages, A's page anatomy inside. | The audience papyri targets first (people who already read numpy/pandas docs in this layout); narrative and API share one visual system; smallest redesign of the three restructures. | Three columns cost width at 1024–1280; two rails to keep in sync per route. |
| **C · App shell** | DevDocs / hexdocs-style persistent left column that *is* navigation and search (all packages as disclosure rows with version state; `pkg ` + Tab scoping), one 72ch column with a Stripe-style sticky secondary panel, a preferences page instead of a header gear. | The hosted multi-package promise: cross-package browsing and search as the primary interaction, scales to hundreds of bundles. | It is an app: fights Astro per-route SSR (needs `<ClientRouter>` + `transition:persist`), no-JS/SEO floor, virtualised trees, loses the Sphinx look maintainers expect. |

## Recommendation

Take **B as the destination, in two steps, borrowing from A and C**:

1. **Land Direction 0 first** (one or two PRs, days of work). The token set, type scale and the
   ~30 quick wins from both reviews are independent of any structural decision, remove every P1
   contrast/a11y/mobile bug, and reorder the class page so the summary comes first. The
   `evolve.css` file in `prototypes/0-evolve/` is the starting point; its README lists
   the ten template edits and the file each one touches.
2. **Then restructure towards B** one route at a time: header search with scope tabs (`/`,
   `Ctrl+K`) as the single search entry and the future home of cross-bundle search; contextual
   sidebar (tree collapsed to ancestors + siblings + children, active item scrolled into view,
   Browse section deleted, Developer disclosure gated on contributor mode); A's page anatomy on
   API pages (short-name h1 + qualname line, kind-grouped member tables with one-line summaries
   fetched on expand, which *is* the planned inline-members feature and removes the 116
   always-rendered islands); "On this page" on API pages; overview page that renders the docs
   index inline and absorbs `/project/<pkg>/`.
3. **Keep C as the reference for search and scale**, not as the shell: the `pkg ` + Tab scoping,
   the per-package version-state pills (latest / older → x / staged · pr-N) and the search-first
   home with an upload feed all transfer into B without the SSR cost.

Two decisions are the maintainer's, not the reviewer's, and should be made before step 2:
whether narrative guides get section tabs in the navbar (B) or stay a sidebar section (0/A),
and whether the home page becomes search-first with a feed (A/C) or keeps cards (0). The
prototypes show both options for each.

## Committed screenshots

`shots/` holds 21 downscaled captures of the current viewer used as evidence in the reviews
(home, overview, project page, module, class, method, tutorial, magics, specimens, mobile, tablet,
search dialog, settings menu, admin, login, node browser, collapsed sidebar). The reports also
reference `agent-design-*` / `agent-layout-*` captures and probe JSON that were produced during
the review and are not committed; `tools/screenshots.mjs` reproduces the base set.

## Follow-ups filed in PLAN.md

- Quick wins (Direction 0) as the first viewer PR.
- The two open design decisions above.
- Gen-side data bugs surfaced by the review: numpydoc `Returns` rendered as raw
  `Returns / -------` text on `run_cell`; "Additional content" duplicating the summary on module
  pages; `item_type` exposing metaclass names (`MetaHasTraits`) and `function` for methods.
