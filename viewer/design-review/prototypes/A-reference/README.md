# Direction A — Reference (docs.rs / rustdoc / pkg.go.dev)

**Optimises for** API readers at numpy/scipy scale: fast scanning, everything about one object on one
page, a sidebar that always answers "where am I, what else is here", and a keyboard model (`/`, `S`,
`+`/`-`, `[`/`]`, `?`). Dense pages look intentional because density is the design.

**Costs.** Narrative docs get the same two-column shell with a per-page rail (no separate guide layout);
the global module tree is demoted to a collapsed disclosure, so cross-module orientation relies on the
trail, the "In <module>" sibling list and search; a 116-member class page is long (mitigated by
collapsed-by-default rows, a folded Private group and an rustdoc-style auto-collapse preference later).

## Page anatomy (ordered regions)

Shared shell: skip link → sticky **top bar** (wordmark · package name · **version ▾ + Latest pill** or
"Not the latest · Go to 9.17.1" · contributor-only diagnostics badge · search trigger `/` · theme ·
contributor mode · sign-in) → `shell` grid = **left rail** (17 rem, 19 rem ≥ 80 em) + **content**
(max 72 rem, prose capped at `--measure: 72ch`, code/tables/signatures full width) → footer.
There is no right column: the rail *is* "on this page".

| page | content column, top → bottom | left rail |
|---|---|---|
| **class.html** | trail · kind badge + short `h1` + ABC pill + Source · full qualname + Copy (+ Raw JSON in contributor mode) · one-line summary + member counts · signature · **Methods (97)** / Static methods / Dunder tables (row = name · summary · chevron; `<details>` reveals real signature, summary, Full page, Source, "Also documents: Parameters · Returns") with Expand all / Collapse all · **Private (17)** folded table, no invented summaries · Aliases · Referenced by (folded > 20) · ‹ prev / next › sibling in module | item title · Sections (with counts) · **Methods 97** (every member, anchor links, scroll-spy) · Static methods · Dunder · **In IPython.core.interactiveshell** (siblings) · Module tree (collapsed) · Developer (contributor mode) · key hints |
| **function.html** | trail · `method` badge + short `h1` + **Changed in 8.0** pill + Source · qualname + Copy · signature with linked types (`str`/`bool` → intersphinx, `ExecutionResult` → class) · summary · versionchanged block · **Parameters** as a compact 2-column table · Returns · Examples · See also · Aliases · Referenced by (with a "pinned 9.15" pill on a cross-bundle ref) · ‹ prev / next › member | title · Sections · **In InteractiveShell** (neighbouring members + "all 96") · In module · tree · Developer |
| **overview.html** (`/project/IPython/9.17.1/`) | trail · monogram + `h1` + package badge · lede · **metadata strip** (Version ▾ Latest · Uploaded + ingest status · License · Requires · PyPI/GitHub/conda-forge/Upstream docs · bundle counts) · root-module doc (falls back to the first paragraph of `docs/index`) · **Guide** table (73 pages) · **Submodules** · **Functions** · Dunder (folded) · **Versions** table + compare | package identity · Sections · Guide top level · Modules |
| **doc.html** | trail from the toctree (`IPython › Guide › Tutorial › …`) · sans `h1` + Edit on GitHub · path line · body (`.doc`: h2 rules, 72ch prose, full-width code) · ‹ Previous / Next › cards | page title · **On this page** (h2 + h3, scroll-spy) · **In Tutorial** siblings · Guide tree (open) · API shortcuts · Developer |
| **home.html** | product `h1` · counts · **one big search** with three syntax hints (package / symbol / scoped `pkg#sym`, `class:`, `fn:`) · feed tabs Recent / A–Z / Failures · **Recent uploads** list (monogram · name version · summary · counts · relative time · ingest status pill) | none (single column, 60 rem) |

## Sidebar behaviour
Per-page, never the global tree. Order is always: *this page* (sections, member groups with counts,
one link per member) → *siblings in the parent* → *collapsed tree* → *Developer* (only with `data-dev`).
One scroll container, sticky under the header, active link gets `aria-current` via a 20-line
IntersectionObserver and is scrolled into view. On phones/tablets (< 64 em) the rail becomes a fixed
drawer opened from the ☰ button (backdrop, closes on link click).

## Responsive
≥ 80 em: 19 rem rail · 64–80 em: 17 rem rail · < 64 em: drawer, single column, search trigger collapses
to an icon, "Go to latest" note hidden (still in the version menu) · < 40 em: member rows stack name
over summary, params table stacks name over description, feed drops counts, wordmark → pilcrow.
No horizontal page scroll at 390/768/1024/1440/1920 (verified with Playwright during the review); tables and code scroll inside
`.table-scroll` / `pre`; long qualnames wrap with `overflow-wrap: anywhere`.

## Search model
`/`, `S`, `Ctrl/⌘+K` open one dialog (mocked). Scope pill = current bundle; `numpy#linspace` re-scopes;
`class:` `fn:` `mod:` `attr:` filter by kind; `"exact"`. Results in three rustdoc tabs — **In names /
In parameters / In return types** — switched with ←/→; each hit shows kind badge, name, module, package
pill, summary. Home uses the same dialog with scope "All packages". `?` opens the shortcuts sheet.

## Where PLAN.md features land
- **Inline members**: the member tables *are* inline members — collapsed `<details>` per row, body
  fetched on open in the real viewer (no more 116 always-rendered islands); `+`/`-` and per-group
  Expand/Collapse; `#m-<name>` anchors open the row (`hashchange` handler included).
- **Staging / PR-preview banner**: a non-dismissible strip slot between the top bar and `.shell`
  (same place a "not latest" explanation would stack); the top-bar version pill carries the state
  word (`Latest` / `Not the latest` / `staged`).
- **Diagnostics badge**: `0 errors · 14 warnings` pill next to the version in the top bar, contributor
  mode only, linking to the validate pages; unresolved xrefs get orange/red boxes only under `data-dev`,
  readers see a dotted underline (`doc.html`, "Python tutorial").
- **Cross-bundle search**: the scope pill + `pkg#symbol` syntax + package column in results.
- **Version pins**: `pinned 9.15` pill on a cross-bundle "Referenced by" row (`function.html`) and the
  "Not the latest · Go to 9.17.1" note in the top bar when a pinned link lands on an old version.

## Migration note (`viewer/src/`)
- **Layouts**: `BundleLayout.astro` → one `RefLayout` (top bar + rail + content grid); drop the
  three CSS-only checkbox toggles and the right `page-toc-panel`; `BaseLayout` keeps home/login/admin.
- **Components**: `SiteHeader` grows `PackageNav` (name, `VersionSwitcher` from `DocSwitcher.tsx`,
  diagnostics badge) and the search trigger; new `PageRail.astro` fed by a per-page view model
  (`{sections, groups, siblings, tree}`) from `qualname-page.ts` / `doc-page.ts` — replaces
  `BundleSidebar` + `BundleSidebarTocItem`; new `MemberTable.astro` (kind-grouped `<details>` rows)
  replaces the `ul.qualnames` chips and wraps `InlineMemberDoc` lazily; `TitleBlock.astro` (kind badge,
  short name, qualname + copy, source, version pills from `versionadded/changed/deprecated` nodes);
  `ParamsTable` in `render-node.ts` for numpydoc Parameters/Returns; `BundleSearch.tsx` gains tabs,
  scope pill and prefix parsing.
- **Pages**: `[ver]/index.astro` renders root-module doc + kind tables + versions (absorbs
  `project/[pkg]/index.astro`); `[...slug].astro` orders summary → signature → member groups;
  `index.astro` becomes search + feed (needs ingest-time counts/status).
- **CSS**: replace `global.css` tokens with the design-review token set (this file's `:root`), add
  `--measure`, `.rail`, `.mtable/.mrow`, `table.ref`, `table.params`, `.pill/.kind`; gate diagnostic
  skins in `ir-nodes.css` behind `html[data-dev]`; ir-reader maps `MetaHasTraits` → `class`,
  `function` inside a class → `method`.
