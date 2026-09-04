<!-- Generated 2026-09-04 against commit 8a9661c with IPython 9.17.1 and papyri 0.0.10 ingested. Screenshot references point at the full capture set produced by tools/screenshots.mjs; the subset committed under shots/ is listed in README.md. -->

# Papyri viewer — layout & information-architecture review

Scope: site IA, URL structure, page templates, sidebar, grid/responsive, navigation affordances,
and whether the layout has room for the PLAN.md features. Colours/typography/components are
covered by the separate design review and are not repeated here.

Evidence: pre-captured shots in `shots/`, plus my own `shots/agent-layout-*.png` (390 / 768 /
1024 / 1920 viewports), and DOM measurements from `layout-measure.mjs` / `layout-probe.mjs`
(raw output in `layout-measure.json`). All `file:line` refs are relative to `viewer/src/`.

---

## Executive summary

1. The IA is a sound three-level hierarchy (`/` → `/project/<pkg>/` → `/project/<pkg>/<ver>/…`) with a
   single URL module (`lib/links.ts`), but the **reader-facing navigation is polluted by developer
   tooling**: every bundle page shows "Browse → Text search / Images / Math / Code / All nodes",
   a floating "Raw JSON" button, and the bundle overview leads with two diagnostics buttons.
2. **The class page is upside-down**: a 116-chip "Members" wall (1 421 px tall, measured) sits between
   the signature and the one-line Summary, which lands at y = 1 797 px — two viewports below the fold.
3. **The bundle overview is empty** — three cards and two diagnostic links on a 1 152 px canvas.
   It is the landing page of every `latest` link from the home page, and gives the reader nothing to read.
4. **The API tree in the sidebar never shows you where you are**: on the `InteractiveShell` page the
   active item sits at offset 594 px inside a 360 px (40 vh) scroll box, in a sidebar that itself scrolls.
   `activeVisibleInTree === false` at every desktop width measured (1024–1920).
5. **No measure limit on prose**: 112 cpl at 1440 (doc page with TOC), 143 cpl on API pages at 1440,
   155 cpl at 1920. Comfortable reading is 60–90.
6. **Mobile (390 px) has horizontal page scroll** on every qualname page: the `<h1><code>` qualname is
   unbreakable (`docScrollX: true`, full-page capture is 710 px wide). The 2-column member chip grid
   also clips labels at 390.
7. **Three unrelated search boxes** (home filter, per-bundle symbol dialog, text-search page ×2 scopes) with
   no shared entry point, no keyboard shortcut (`/` and `Ctrl+K` do nothing, measured), no skip link,
   35 tab stops before `<main>`.
8. The class page silently fetches **all 116 member docs as `server:defer` islands even when "inline
   members" is off** (`[...slug].astro:208-223`); the DOM carries ~200 zero-height `.doc-section`s. With
   inline members on, the page is 44 470 px tall with no per-member collapse.
9. Responsive breakpoints (899 / 1100) work, but the 900–1100 band renders a phantom 32 px grid track for a
   TOC-collapse button whose TOC is hidden, and the collapse toggles (CSS `:has` + checkbox) lose state on
   every navigation.
10. The layout does have a slot for most planned features (banner region above `<main>`, identity block
    for badges) — but **cross-bundle search and version pinning have no home** in the current header,
    and the home page card grid will not survive 200 packages without grouping/sort/search-first design.

---

## 1. Site-level IA & URL structure

### What exists

```
/                                   BundleCard grid (index.astro)
/project/<pkg>/                     versions table + link pills + placeholder info cards
/project/<pkg>/<ver>/               bundle overview (3 cards + 2 diag links)
/project/<pkg>/<ver>/<qa$slug>/     qualname page (module / class / function / method)
/project/<pkg>/<ver>/docs/<a>/<b>/  narrative page  (':' → '/')
/project/<pkg>/<ver>/examples/<p>/  example page
/project/<pkg>/<ver>/{images,nodes,nodes/<type>,text-search}/
/project/<pkg>/<ver>/{validate,backref-validate}   (no trailing slash — inconsistent)
/project/<pkg>/diff?from=&to=
/text-search/  /nodes/  /ir-stats/  /admin/  /settings  /login
/api/…
```

`lib/links.ts` is a genuine single source of truth with template-literal types — good. `lib/slugs.ts`
maps `:` → `$` (lossless, readable). `lib/qualname.ts` is small and correct. `latest` resolves at
`ir-reader.ts:81` and the sidebar keeps `latest` in every href (`nav.ts:270-292`; verified:
`/project/IPython/latest/` → sidebar links all contain `/latest/`). No banner is shown on `latest`. Good.

### Findings

**IA-1 (P1) Developer surfaces are mixed into the reader navigation.**
Evidence: `BundleSidebar.astro:213-222` renders "Browse: Text search / Images / Math / Code / All nodes"
on *every* bundle page for *every* visitor; `BundleLayout.astro:169-174` floats a "{ } Raw JSON" button
top-right of every module/doc/example page (`ipython-class--desktop-light.png`, top right);
`[ver]/index.astro:74-86` puts "Outgoing ref diagnostics" and "14 broken incoming refs" as the only
content below the three cards (`ipython-bundle-index--desktop-light.png`). "Math", "Code", "All nodes"
are IR-node browsers (`ipython-nodes--desktop-light.png` shows a pill row of IR type names such as
`DocstringSentinel`, `UnimplementedInline`) — meaningless to a numpy user.
Recommendation: split the audience. Reader nav = Docs / Tutorials / Examples / API. Move Raw JSON,
All nodes, Math, Code, IR stats, validate, backref-validate under a single **"Developer"** disclosure
in the sidebar that is (a) collapsed by default and (b) only rendered when `isAuthenticated` or when a
`?dev=1` / localStorage `papyri-viewer:dev-tools` flag is set (the same pattern `index.astro:26-33`
already uses for "all nodes / IR statistics" on the home page — extend it). Keep the Images gallery
reader-facing only if it becomes a proper figure index; today it lists `auto_suggest_1_prompt_no_text.png`
filenames (`ipython-images--desktop-light.png`), which is a debug view.

**IA-2 (P2) `/project/<pkg>/` and `/project/<pkg>/<ver>/` compete for the "package home" role.**
The card on `/` stretches its primary link to `/project/<pkg>/latest/` (`BundleCard.astro:24,41`) and
offers a secondary "Project details (1 version) →" to `/project/<pkg>/`. The project page (a BaseLayout
page, no sidebar) is a versions table plus four placeholder cards (Stars —, Downloads —, License —,
Maintainers "Not available locally"; `ipython-project--desktop-light.png`). Two landing pages for one
package, neither of which contains documentation.
Recommendation: make `/project/<pkg>/` a thin redirect to `/project/<pkg>/latest/` for readers and move
the versions table + compare-versions form into the bundle overview page as a "Versions" section (it
already knows `pkgVersions`, `BundleLayout.astro:66-68`). Drop the placeholder info cards until there is
data; empty dashes signal "broken", not "coming soon". If a project page must stay (for staging /
maintainers), reach it from the version switcher ("All versions…") rather than from the home grid.

**IA-3 (P2) The `validate` / `backref-validate` routes lack trailing slashes** (`links.ts:131-141`) while
every other route has one. Cosmetic today, but it becomes a real cache/redirect inconsistency once behind
a reverse proxy with `trailingSlash` rules.

**IA-4 (P2) Home page is not designed for scale.** `index.astro` renders one `BundleCard` per package,
each of which calls `loadBundleNav()` (`BundleCard.astro:19`) — that is a full nav build (toc, docs
listing, module listing, logo base64) per card, per request. The grid is `repeat(auto-fill, minmax(16rem, 1fr))`
inside a 960 px `.base-main` (`global.css:119-123`, `:1336-1341`): measured 3 columns of 296 px at 1920.
With 2 packages it looks fine (`home--desktop-light.png`); with 200 it is 67 rows of cards with a
substring filter that only matches on `pkg` and `summary`.
Recommendation for a hosted top level: (1) search-first — one large input that searches packages *and*
symbols across bundles (PLAN.md "Per-bundle → global search"), (2) a compact list/table under it
(name, latest, one-line summary, doc/API counts) sorted by name with optional "recently updated",
(3) "featured" cards only for a curated handful. Precompute the per-package counts at ingest
(PLAN.md already lists ingest-time precomputation) so the home page is one query.

**IA-5 (P3) `latest` should be the canonical reader URL, and the version string an opt-in.**
Today the home card points at `latest` but the sidebar identity block on a versioned URL shows `9.17.1`
and on the alias shows the literal word `latest` (`bundle-identity-version`, verified). Show
"9.17.1 (latest)" in both cases; never show the bare word "latest" as if it were a version.

---

## 2. Page templates

### 2.1 Home (`index.astro`, `BundleCard.astro`)

Structure: h1 "Papyri viewer" → lede with count and "Search text across every bundle" link →
filter input → card grid. Card: logo + pkg + version / summary (3-line clamp) / counts row / "Project details" link.

- **(P2)** The only cross-bundle action is a text link in the lede. The page has no primary search.
  See IA-4.
- **(P3)** Card counts row ("1395 API · 73 DOCS") uses uppercase mono micro-labels at 0.65 rem
  (`global.css:1471-1475`) — fine at 2 cards, noise at 200. Prefer one muted line: "1 395 API objects · 73 pages".
- **(P3)** "Papyri viewer" as the h1 of the hosted service says nothing to a reader. The header
  wordmark already says papyri; the h1 should be the product statement ("Python documentation, cross-linked").

### 2.2 Project page (`project/[pkg]/index.astro`)

Structure: crumb → logo + h1 + lede → link pills (PyPI / GitHub / Documentation / conda-forge) →
2-col grid: versions table + compare form | four info cards.

- **(P2)** See IA-2. Four cards of dashes. `project/[pkg]/index.astro:272-323`.
- **(P2)** The "Documentation" pill (`:135-144`) links *away* to the upstream docs site. On a service
  whose purpose is to *be* the documentation, this is the wrong primary affordance; keep it, but label
  it "Upstream docs" and demote it to the info column.
- **(P3)** The versions table's "browse →" column duplicates the version link in column 1.

### 2.3 Bundle overview (`[ver]/index.astro`)

Structure: "← bundles" crumb → h1 `pkg <ver>` → lede → three `bundle-index-card`s (Narrative docs /
API reference / Examples) → diag links. Measured main column at 1440: 1 152 px wide, 494 px tall,
i.e. 70 % of the viewport is empty (`ipython-bundle-index--desktop-light.png`).

- **(P1)** This is the page every home-card click lands on, and it contains no documentation. The
  sidebar next to it already lists the same three destinations. Recommendation: render the docs index
  page (`nav.docsIndexHref`) *inline* as the overview body when it exists (IPython's "IPython
  Documentation" page is exactly the right landing content — `ipython-doc-index--desktop-light.png`),
  otherwise render the root module's summary + submodule list. Keep the three cards as a compact
  "Jump to" row above it, with the counts. See the template spec in §7.
- **(P1)** The diagnostics buttons are the *only* thing below the fold-line. Move them to the
  Developer section (IA-1); surface the count as a small badge on the identity block for logged-in
  maintainers (this is exactly where PLAN.md's "0 errors / N warnings" badge should live — §6).
- **(P2)** "API reference → 1395 items" links to the root module page (`:26-30`), which for IPython
  is 6 submodules + 4 members. A reader expecting a reference index gets a near-empty module. Either
  link to a generated "API index" page (all modules, grouped, with one-line summaries) or make the
  root module page richer.

### 2.4 Module page (`[...slug].astro`, non-class branch)

Structure: crumb → kind label ("MODULE") → h1 mono qualname → source line → [Signature] →
"Submodules" chips → "Members" chips → Summary → Extended Summary → Additional content → Aliases →
Referenced by. (`ipython-module-root--desktop-light.png`, `ipython-module-big--desktop-light.png`.)

- **(P1) Section order.** Summary is the first thing a reader needs and it is rendered *after* the
  member grids (`[...slug].astro:189-226` before `:228`). On `IPython.core.interactiveshell` the
  summary "Main IPython class." appears below 13 chips; on `InteractiveShell` it is 1 421 px down.
  Recommendation: header → summary/extended summary → signature → [contents] → parameters etc.
- **(P2) Members are unannotated chips.** `ul.qualnames` (`global.css:277-296`) is a 2-column list
  of `<code>` names with no kind (class vs function), no one-line summary, no private grouping.
  Compare the same data on `ipython-module-big`: `ExecutionInfo`, `InteractiveShell`,
  `is_integer_string` are indistinguishable. Recommendation: a compact table per group
  (name · kind badge · first sentence of summary), private members folded under a `<details>`
  ("12 private members") rather than the global "hide private" toggle.
- **(P2) "Additional content" duplicates Summary.** `ipython-module-big`: Summary says "Main IPython
  class.", Additional content says "Main IPython class." again (`QualnameDocSections.astro:38-58`
  renders `doc.arbitrary` untitled). Data issue surfaced by layout: either dedupe at gen or drop
  untitled arbitrary sections that equal the summary. Also rename the heading: "Additional content"
  is a label for the renderer, not for the reader — use the section's own title or nothing.
- **(P3) Source line shows `:0` for modules** (`/IPython/__init__.py :0`). Hide the line number
  when it is 0/undefined.

### 2.5 Class page (`[...slug].astro`, `isClassPage` branch)

Structure: crumb (6 code chips) → "METAHASTRAITS" kind label → h1 → source → Signature → **Members
(116 chips, 2 cols)** → Summary → Aliases. Measured: members section 1 421 px, summary at y = 1 797.

- **(P1) Same ordering problem, magnified.** The one-line class summary is the second-to-last thing on
  the page (`ipython-class--desktop-light--full.png`). A reader arriving from search sees a signature and
  116 names and must scroll ~2 viewports to learn what the class *is*.
- **(P1) Members list is a flat alphabetical wall.** Private (`_`-prefixed) and public are interleaved
  by `localeCompare` (`:98-101`), methods and attributes are not distinguished, and the two CSS
  columns (`columns: 2`) read column-major so the eye zig-zags. Recommendation: group — "Public methods",
  "Attributes", then a folded "Private (26)" — and render as a table with the first summary sentence.
  This is the single largest reading-UX gain on the API side and it needs no new data (the summaries
  are already fetched by the inline-members islands).
- **(P1) Inline-member islands are always fetched.** `:208-223` renders `<InlineMemberDoc server:defer>`
  for every non-private member unconditionally; visibility is CSS only (`global.css:910-918`). Measured
  DOM on the class page with the setting OFF: ~200 hidden `.doc-section`s. That is 116 server sub-requests
  per class-page view on the hosted service, for content nobody sees. Gate the islands on the flag
  (query param `?inline-members=1` as PLAN.md specifies, plus a client-side "expand" that fetches on
  demand) instead of always rendering them.
- **(P2) Inline-members mode has no page structure.** With the flag on (`x-inline-members--desktop-light--full.png`,
  44 470 px tall) there is no per-member collapse, no "collapse all", no anchor links in the members
  grid pointing at `#member-<label>` (the ids exist, `InlineMemberDoc.astro:43`, but the chips still link
  to the separate page), and no on-this-page TOC — the doc page TOC machinery (`hasToc`) is not used on
  qualname pages at all. Reuse it: in inline mode, the right column should list the members.
- **(P2) Kind label leaks the metaclass.** "METAHASTRAITS" (`doc.item_type`) is the metaclass name, not
  a kind the reader understands. Map to "class" (with the metaclass as a tooltip) in `ir-reader.ts`,
  the designated shock absorber.
- **(P3) Breadcrumb code chips.** Six `<code>` chips separated by " / " (`:134-155`) render as a row of
  grey boxes (`ipython-method--desktop-light.png` top). Chips are fine for the object segments but the
  package and module segments should be plain text; and the last crumb duplicates the h1.

### 2.6 Function / method page

Structure: crumb → "FUNCTION" → h1 → source → Signature → Summary → Parameters → (Returns rendered as
raw text: `Returns` / `-------` / `result : :class:\`ExecutionResult\`` — `ipython-method--desktop-light--full.png`)
→ Aliases. (`papyri-func-examples`: + Extended Summary, Examples with pass/fail badges, figure.)

- **(P2)** This is the best page type today; the order is right. Two layout issues: the raw
  "Returns / -------" block is a gen/IR problem visible as a layout break (out of scope for this review
  but it is a P1 data bug — flag it); and the h1 repeats the full qualname already in the breadcrumb.
  Use the short name as h1 (`run_cell`) with the module path as a muted line above it; keep the full
  qualname as a copy-to-clipboard affordance.
- **(P2)** No "on this page" / no back-to-class link beyond the crumb. On a long method page the
  parent class is only reachable via the crumb chip.
- **(P3)** The signature block is a full-width bordered box with `overflow-x: auto`
  (`global.css:583-589`) — correct, verified `sigOverflow: false` at 390 because `.sig-code` wraps.

### 2.7 Narrative doc page (`docs/[...doc].astro`)

Structure: crumb `bundles / IPython 9.17.1 / docs` → "DOC" label → h1 → `docs/interactive:tutorial`
path chip → prev/next (top) → sections → prev/next (bottom) → right-column "On this page".

- **(P2) The header is API-shaped chrome on a prose page.** "DOC" uppercase kind label
  (`:89`) and a mono `docs/interactive:tutorial` chip (`:91`) are IR internals; the reader wants the
  section trail ("Tutorial › Introducing IPython"), which the crumb does not give (it stops at "docs").
  Recommendation: crumb = `IPython › Tutorial › Introducing IPython` built from the toc ancestors
  (`collectExpandedHrefs` already walks that path, `BundleSidebar.astro:106-119`); drop the kind
  label and the path chip (keep the path in the Developer disclosure / Raw JSON).
- **(P2) prev/next at both top and bottom.** Top prev/next (`:95-119`) pushes the first paragraph
  down and competes with the h1; bottom is where readers expect it. Keep bottom only, make it a
  two-card "← Previous / Next →" with the page titles, and put a compact "Next: Rich Outputs →" in the
  right TOC column for long pages.
- **(P2) On-this-page collapses everything when the page has no h2.** The scroll-spy hides every
  `level > 1` entry whose `parentH2` is not the active h2 (`:224-232`). On `docs/interactive/magics/`
  both entries ("Line magics", "Cell magics") are level 2 with `parentH2 = undefined`, so the panel
  renders **only the label** and an empty list, yet still reserves the 15 rem column
  (`ipython-doc-magics--desktop-light.png`; probe: `count: 2, collapsed: true, true`). Fix: treat
  the shallowest level present on the page as top-level, and never collapse a level that has no
  parent. More broadly, hiding h3s under inactive h2s is a defensible density trade-off but it makes
  the TOC *change shape while scrolling*, which readers experience as flicker; the common pattern
  (MDN, Astro docs) shows all h2+h3 and only highlights. Prefer show-all with h4+ hidden.
- **(P3) TOC panel is 15 rem and its links wrap** ("The four most helpful commands" wraps to two lines
  at 0.82 rem). Either 16–17 rem or ellipsis with `title`.
- **(P3)** Sections use `scroll-margin-top: 1rem` (`global.css:328`) but there is no sticky header,
  so anchors land correctly; keep it that way — if the header ever becomes sticky this must change.

### 2.8 Example page (`examples/[...ex].astro`)

Structure: crumb → "EXAMPLE" → h1 `simple_plot.py` → code block → figure. (`papyri-example--desktop-light.png`)

- **(P2)** No description, no link to the API objects the example uses, no "other examples". The
  gallery-style entry (thumbnail grid on the overview page, like matplotlib's) is what readers expect;
  today "Examples" in the overview links straight to `nav.examples[0]` (`[ver]/index.astro:64`).
- **(P3)** The figure renders at full column width (1 100 px) — cap figures at `min(100%, 48rem)` and
  centre.

### 2.9 Search results (`text-search/index.astro`, `TextSearchPanel.tsx`, `BundleSearch.tsx`)

- **(P2)** Per-bundle text search page and global text search page are the same island with a
  different `apiPath`; the global one has no sidebar (BaseLayout) and the bundle one has the full sidebar
  — the same task in two layouts. The results container is `max-width: 800px` (`global.css:1597-1599`)
  — the only place in the viewer with a measure — good, but it should be the rule, not the exception.
- **(P2)** The symbol search dialog (`x-search-dialog--desktop-light.png`) is the best search
  surface in the viewer (two-line hits, arrow keys, Enter) and it is only reachable by clicking a
  sidebar button below the fold on doc pages (`ipython-doc-tutorial--desktop-light.png`: the "API"
  section starts at y ≈ 860). Promote it to the header (§5).
- **(P3)** `?q=` is honoured on the text-search page but the symbol dialog has no URL state — a
  symbol search cannot be shared or bookmarked.

### 2.10 Images / nodes / validate / backref-validate

Developer tooling wearing reader chrome (`ipython-nodes`, `ipython-validate`, `ipython-images`).
They are fine as debug pages; the issue is only their placement (IA-1). One structural note:
`validate.astro` walks the entire bundle on every request (`validate.astro:32-49`) — behind the
Developer disclosure that is acceptable; as a reader-nav link it is a DoS vector on the hosted service.

### 2.11 Login / settings / admin

`x-settings--desktop-light.png`: a centred 640 px card with stacked full-width primary buttons
("Save", "+ Add passkey", "Change password") — three primary CTAs of equal weight on one page. Group
into sections with one primary each. Login is a plain card; fine. Admin uses `AdminLayout` — not
reviewed in depth (not reader-facing).

---

## 3. Sidebar (`BundleSidebar.astro`, `global.css:996-1282`)

Current order: identity (logo, pkg, version) → DocSwitcher (only when > 1 version) → summary →
Docs (toctree) → Tutorials → Examples → Browse → API (search trigger + qualname tree, `max-height: 40vh`).

**SB-1 (P1) Nested scrolling hides the active item.** The sidebar is `position: sticky; max-height:
100vh; overflow-y: auto` (`global.css:214-224`) and the tree inside it is `max-height: 40vh;
overflow-y: auto` (`:1266-1271`). Measured on the `InteractiveShell` page at 1440×900: sidebar 832 px,
tree box 360 px, tree content 3 814 px (180 `<li>`), active item at offset 594 px → not visible
(`activeVisibleInTree: false` at 1024, 1280, 1440, 1920). The reader sees `IPython › core ›
_dunder_ops, alias, application…` (siblings of the ancestor) and no highlight
(`ipython-class--desktop-light.png`, left column). To find "you are here" they must scroll the inner
box (`agent-layout-class-tree-scrolled--1440.png` shows what they should have seen).
Recommendation: (a) drop the inner `max-height`; let the sidebar be the only scroll container;
(b) on load, `scrollIntoView({block: "center"})` the `.is-active` item inside the sidebar (3 lines of
inline script, no island); (c) collapse *siblings of ancestors* by default — the expansion rule
"children of every node on the active path" (`:60-79`) is what produces 180 rows; "ancestors + the
active node's siblings + its children" produces ~40.

**SB-2 (P1) Section order buries the API on doc pages and buries the docs on API pages.**
Sidebar height on the tutorial page: 925 px of content for a 900 px viewport, with the API search
trigger at y ≈ 860 (`ipython-doc-tutorial--desktop-light.png`). On API pages the Docs section is a single
line and Browse occupies the next 150 px before the tree. Recommendation: make the sidebar
*contextual* — on a docs page show the toctree first and fold API into a one-line "API reference →"
plus the search trigger; on an API page show the tree first and fold Docs into its top-level entries.
Keep the section headers as clickable disclosure triangles so the reader can open the other one.

**SB-3 (P1) "Browse" should not exist as a reader section.** See IA-1. Five links, none of which a
reader of numpy docs needs. Text search can become a mode of the header search.

**SB-4 (P2) 18 rem is too narrow for the tree at depth 5 and too wide for the flat lists.**
Indent is `0.75rem × (depth-1)` (`:1272-1275`), so a depth-5 member (`IPython.core.interactiveshell:
InteractiveShell._format_exception_for_storage`) has 3 rem of indent in a 16 rem content box; 1 of 180
labels measured is truncated on this page, but the ellipsis rule (`:1237-1244`) is doing the work
silently and `title=` is the only recovery. Recommendation: 19–20 rem on ≥ 1280, 17 rem on 900–1279,
and reset indentation at the `:` boundary (module path collapsed into the parent line, members
indented from the class only).

**SB-5 (P2) The identity block links to the empty overview** (`:125`). Once the overview has content
(§2.3) this is correct; today it is a dead-end click.

**SB-6 (P2) DocSwitcher only appears with ≥ 2 versions** (`DocSwitcher.tsx:91`). The single-version
case then has *no* affordance that versions exist at all; show a static "v9.17.1 · latest" pill so the
slot is stable and the "pinned to X, showing Y" text (§6) has a place.

**SB-7 (P3) Tutorials is a filename heuristic** (`nav.ts:184-189`: `tutorial_*` or `tutorials/`) that
IPython's real "Tutorial" toctree does not trigger, so the section is absent even though the docs have a
Tutorial chapter (visible under Docs). Either derive it from the toctree or drop the section.

**SB-8 (P3) Mobile "Navigation" drawer is inline, not overlay.** At 390 the checked sidebar inserts
833 px of content between the toggle and the page (`agent-layout-mobile-nav-open--390.png`); closing it
requires scrolling back up to the "× Navigation" label. Make it a fixed overlay (`position: fixed; inset:
3rem 0 0 0; overflow-y: auto`) with the close control sticky, or use `<dialog>`.

**SB-9 (P3) Desktop collapse state is not persisted** (`BundleLayout.astro:115-116` checkboxes; no
script). Every navigation re-opens the sidebar and TOC. Persist in localStorage like the theme, or
accept that CSS-only means non-persistent and remove the toggles (they are low-discoverability 1.5 rem
chevrons anyway — `x-sidebar-collapsed--desktop-light.png`).

---

## 4. Grid & responsive

Measured (`layout-measure.json`):

| viewport | grid (`.bundle-layout`) | main width | prose cpl (doc / API) | TOC |
|---|---|---|---|---|
| 390  | block, sidebar hidden | 390 | 44 | hidden |
| 768  | block, sidebar hidden | 768 | 93 | hidden |
| 1024 | 288 / 704 / **0 / 32** (doc) · 288 / 736 (API) | 704–736 | 85 / 89 | hidden, but chevron column reserved |
| 1280 | 288 / 752 / 240 | 752–992 | 91 / 122 | shown |
| 1440 | 288 / 912 / 240 | 912–1152 | 112 / 143 | shown |
| 1920 | 288 / 1008 / 240, layout capped 1536 @ x=192 | 1008–1248 | 124 / 155 | shown |

**RG-1 (P1) No measure on the main column.** `.bundle-main` has `min-width: 0` and padding only
(`global.css:227-231`); the comment says "no max-width (the grid contains it)". 143–155 characters per
line on API pages is roughly double the readable range, and the Parameters definition list stretches
its descriptions across 1 100 px (`agent-layout-method--1920.png`). Recommendation: `grid-template-columns:
18rem minmax(0, 1fr) 15rem` stays, but wrap the page body in `max-width: 46rem` for prose regions (h1,
paragraphs, dl, lists, admonitions) and let *only* code blocks, tables, signatures and figures extend to
`max-width: 100%` (CSS grid with named lines, or a simple `.prose { max-width: 46rem }` + `.wide {
max-width: none }` pair). Centre nothing — keep the column left-aligned next to the sidebar so the extra
space goes to the right, where the TOC lives.

**RG-2 (P1) Horizontal page scroll on mobile qualname pages.** `docScrollX: true` at 390 on the class
and method pages; `agent-layout-method--390--full.png` is 710 px wide for a 390 px viewport. Cause: `<h1><code>{doc.qa}</code></h1>`
(`[...slug].astro:159`) is a single 54-character mono token with no `overflow-wrap`. Also the
`.members-toc` 2-column chip grid overlaps at 390 (`agent-layout-class--390.png`: `_clear_warning_registry`
runs into `init_io`). Fix: `header.qa-header h1 { overflow-wrap: anywhere; }` (or the short-name h1 from
§2.6), and `ul.qualnames { columns: 1 }` below 600 px.

**RG-3 (P2) Phantom grid track between 900 and 1100 px.** At ≤ 1100 the TOC column is removed
(`global.css:508-516`) but the `.toc-collapse-label` still has `grid-area: toc` (`:437-440`) and is not
hidden until ≤ 899 (`:489-494`), so the grid grows an implicit `0px 32px` pair (measured cols
`288px 704px 0px 32px` at 1024) and the main column loses 32 px. Hide the label in the same 1100 media
query.

**RG-4 (P2) Header and page are capped at 96 rem but the body background is full-bleed.** At 1920 the
header strip (`global.css:678-687`) and `.bundle-layout` (`:131-139`) are both 1536 px wide centred at
x = 192, with the page background (`--bg`) showing on both sides while the sidebar and header have
`--surface` backgrounds (`agent-layout-method--1920.png`). The result reads as a floating panel with a
hard left edge at x = 192. Either let the header background span the full width (cap only its *content*)
or give the layout a border/shadow so the cap looks intentional. The sidebar's left border should not
appear at x = 192 with nothing to its left.

**RG-5 (P2) The 899 px breakpoint hides the sidebar for the whole tablet class.** At 768 (iPad portrait)
the reader gets a phone layout with a 93-cpl line (`agent-layout-class--768.png`). 768–899 has room for
a 15 rem sidebar + 33 rem main. Recommendation: three tiers — < 640 phone (drawer), 640–1023 tablet
(collapsible sidebar rail, no TOC), ≥ 1024 desktop (sidebar + main + TOC at ≥ 1280).

**RG-6 (P3) Sticky sidebar `top: 0` and `max-height: 100vh`** (`:216-219`) ignore the 3 rem header;
because the header is not sticky this is harmless today but will break the moment the header becomes
sticky (which the search-in-header recommendation implies). Use `top: var(--header-h)` and
`max-height: calc(100vh - var(--header-h))` now.

**RG-7 (P3) Tables and code on mobile** — `table.ir-table` has `max-width: 100%` (`ir-nodes.css:449`)
but no wrapping `overflow-x: auto` container; the specimen page did not overflow at 390
(`agent-layout-specimens--390--full.png`) only because its tables are narrow. Wrap tables in a
`.table-scroll` div at render time (`render-node.ts`).

---

## 5. Navigation affordances

**NA-1 (P1) Three searches, zero shared entry point, no shortcut.**
- home: `BundleGridSearch` substring filter on cards
- sidebar: `BundleSearch` symbol dialog (per bundle, client-side over `search.json`)
- `/text-search/` and `/project/<pkg>/<ver>/text-search/`: `TextSearchPanel` (server FTS)
Measured: `/` and `Ctrl+K` do nothing; `tabsBeforeMain: 35`; no `<a href="#main">`; `<main>` has no id.
Recommendation: one **header search** (island, in `SiteHeader.astro`'s existing `tools` slot) that
opens the current dialog with three tabs or prefixes — Symbols (current bundle), Text (current bundle),
Packages (all). Bind `/` and `Ctrl/⌘+K`. On bundle pages it defaults to the bundle; on `/` to packages.
This also gives PLAN.md's cross-bundle search a home (§6). Add a skip link as the first focusable element
and `id="main"` on both layouts' `<main>`.

**NA-2 (P2) Breadcrumb inconsistency across page types.**
- qualname: `bundles / IPython 9.17.1 / [IPython] / [core] / [interactiveshell] / [InteractiveShell]`
- doc: `bundles / IPython 9.17.1 / docs` (no page trail)
- example: `bundles / papyri 0.0.10 / examples`
- overview: `← bundles`; text-search/images/nodes: `← IPython 9.17.1`; project: `← bundles`
Two different idioms (trail vs back-arrow) and the word "bundles" for the site root. Use one trail
everywhere: `papyri › IPython 9.17.1 › …` where the first segment is the wordmark's job and can be
omitted. "bundles" is an implementation noun — readers browse *packages*.

**NA-3 (P2) Page header (kind label + full qualname + source).** Discussed in §2.5/2.6. The kind label
is useful; "METAHASTRAITS"/"FUNCTION" for a method is not (`ipython-method`: a method labelled
FUNCTION). Map `item_type` → {module, class, function, method, attribute, property} in `ir-reader.ts`.

**NA-4 (P2) "Raw JSON" float.** `float: right` + `margin-left` (`BundleLayout.astro:190-200`) sits
in the crumb row and on mobile wraps under the crumb (`agent-layout-class--390.png`). Move into the
Developer disclosure, or make it a tiny icon next to the kind label for authenticated users.

**NA-5 (P2) Version banner is the only feedback for non-latest**, and it is dismissible per session
(`VersionBanner.astro:62-76`). Once dismissed, nothing on the page says "old version" except the mono
version string in the identity block. Keep a non-dismissible compact marker in the identity block
("9.15.0 · older — latest 9.17.1") and let the banner be the dismissible explanation.

**NA-6 (P3) Prev/next only on doc pages.** API pages have no "previous / next sibling" navigation;
the sidebar tree is the only way. A small "‹ prev sibling · next sibling ›" at the bottom of qualname
pages (from `nav.qualnames`, sorted) is cheap and useful when reading a class's methods in order.

**NA-7 (P3) Keyboard: dialog has arrow keys (`BundleSearch.tsx:77-88`) but the sidebar tree, the
TOC and prev/next have no shortcuts.** `[`/`]` for prev/next page, `t` for TOC focus are common; low
priority but note the absence.

---

## 6. Anticipating PLAN.md

| Planned | Does the current layout have a place? | Note |
|---|---|---|
| Inline class members toggle | Partially — setting exists (`SettingsMenu.tsx:126-133`), islands exist | No per-member collapse, no member TOC, islands always fetched (§2.5). The right column (`page-toc-panel`, unused on qualname pages) is the natural home for a member index in inline mode. |
| Inline module functions | Same slot as above | Needs the same TOC column; large modules will hit the 44 k px problem immediately. Design "collapsed by default, expand per member" before enabling. |
| Bundle staging / PR-preview banner | Yes — `VersionBanner` slot above `<main>` (`BundleLayout.astro:163-167`) | A PR-preview banner must *not* be dismissible and needs a distinct colour token; the banner region should support stacking (old-version + staged). Also needs a marker in the identity block and exclusion from the home grid — home page needs a "staged" filter for maintainers. |
| Diagnostics badge ("0 errors / N warnings") | Half — `diag-links` exist on the overview only (`[ver]/index.astro:74-86`) | Move to the identity block as a small pill (maintainer-only), linking to the validate pages. Overview should not be the only place. |
| Cross-bundle search | **No** | There is no global search UI, only `/text-search/` behind a lede link. The header search (NA-1) is the slot. Results need a package column and grouping by package. |
| Version pins "pinned to X, showing Y" | **No** | Two places will need it: (1) inline, on the xref itself (tooltip/superscript — component review's domain), (2) the version banner/identity block when *the page itself* was reached via a pinned link. Reserve an inline-badge style and a banner variant now. |
| Ingest-time precomputed stats | Yes — overview cards and home cards | Home cards currently compute counts via full `loadBundleNav` per card (IA-4); the precomputation makes a search-first home page viable. |
| Second producer (MyST/Markdown) | Yes — templates are IR-driven | The "DOC" header chrome and `docs/<path>` chip assume RST paths; keep the doc header producer-agnostic (title + toc trail only). |

---

## 7. Proposed page-template spec — four core reader pages

Regions are listed top-to-bottom in the main column; `[TOC]` marks what goes in the right column.

### 7.1 Bundle overview `/project/<pkg>/<ver>/`
1. **Package masthead** — logo, name, version pill ("9.17.1 · latest" or "9.15.0 · older → latest"),
   one-line summary, link pills (PyPI, GitHub, upstream docs). *Why:* identity first; replaces the
   BaseLayout project page for readers.
2. **Jump row** — three compact cards: Guide (N pages) · API reference (N objects) · Examples (N).
   *Why:* keeps today's cards but as a secondary row, not the whole page.
3. **Landing content** — the docs index page body (`docsIndexHref`) rendered inline; fallback: root
   module summary + submodule table. *Why:* every home click lands here; it must contain documentation.
4. **Versions** — compact table (version · uploaded · API count) + "Compare versions" form, folded in a
   `<details>` when > 5 versions. *Why:* absorbs `/project/<pkg>/`.
5. *(maintainers only)* **Diagnostics** strip — errors/warnings badge, broken refs, staging status.
   *Why:* PLAN.md badge has a home without polluting the reader view.
`[TOC]`: on-this-page for the landing content.

### 7.2 Module / class page
1. **Trail** — `IPython › core › interactiveshell › InteractiveShell` (text, last item not a link).
2. **Title block** — kind badge (class / module), short name as h1, full qualname as a muted mono line
   with copy button, source link. *Why:* short h1 wraps on mobile; full name stays available.
3. **Summary + extended summary** — *first* prose the reader sees.
4. **Signature** (class constructor / none for modules).
5. **Contents** — grouped tables, not chips: Submodules · Classes · Functions · Methods · Attributes,
   each row = name (link) · kind · first summary sentence; "Private (N)" folded. In inline mode the rows
   become `<details>` cards with the member doc inside (fetched on open), with a "Expand all / Collapse all"
   control at the group header.
6. **Parameters / Attributes / Raises / Notes / Examples** — in `_ordered_sections` order.
7. **See also · Aliases · Referenced by** — folded "Referenced by" when > 20 rows.
8. **Sibling nav** — ‹ previous · next › within the parent.
`[TOC]`: section list (Summary, Signature, Methods (N), Attributes (N), Parameters, …); in inline mode,
one entry per member.

### 7.3 Function / method page
1. Trail; 2. Title block (kind badge "method" / "function", short h1, qualname line, source);
3. Signature; 4. Summary + extended summary; 5. Parameters · Returns · Yields · Raises;
6. Notes · Examples (with figures capped at 48 rem); 7. See also · Aliases · Referenced by;
8. Sibling nav (previous / next member of the same class or module).
`[TOC]`: only when ≥ 4 sections, otherwise the column collapses to give prose the space.
*Why:* this page is already close; the changes are the title block, measure, and sibling nav.

### 7.4 Narrative page
1. **Trail from the toctree** — `Tutorial › Introducing IPython` (ancestors from `collectExpandedHrefs`).
2. **h1** — page title only; no kind label, no path chip.
3. **Body** — sections, prose at 46 rem measure, code/tables/figures allowed to 100 %.
4. **Prev / Next cards** — bottom only, two half-width cards with titles.
`[TOC]`: "On this page" showing all h2 + h3 (h4+ hidden), highlight only — no collapsing; plus a
"Next: Rich Outputs →" line at the bottom of the TOC for long pages.

---

## 8. Sidebar spec

Width: 19 rem ≥ 1280, 17 rem 1024–1279, drawer (overlay) < 1024. One scroll container (the sidebar);
no nested `max-height` boxes. `top` and `max-height` derived from `--header-h`.

Order (contextual — the section for the *current* page type is expanded, the others are single-line
disclosures with a count):

1. **Identity** — logo · name · version pill (always present, even with one version; carries
   "latest"/"older"/"staged"/"pinned" state) · summary (2-line clamp).
2. **Search trigger** — one button, mirrors the header search (`/`).
3. **Guide** (toctree) — expanded on doc pages; on API pages shows only the top-level entries with the
   current chapter, if any, expanded. Tutorials folded into the toctree (drop the filename heuristic).
4. **API** — expanded on API pages: ancestors + siblings of the active node + its children; every other
   branch collapsed with a ▸ toggle (CSS `<details>` per depth-1 module is enough). Active item scrolled
   into view on load. On doc pages: a single "API reference ›" row with the top-level module list folded.
5. **Examples** — thumbnail-less list on API/doc pages; expanded on example pages.
6. **Developer** (folded, rendered only when authenticated or `?dev=1`) — Raw JSON, All nodes, Math,
   Code, Images index, Outgoing refs, Broken incoming refs, IR stats.

Rationale: the reader always sees identity + search + the one section relevant to the page in the
first viewport; the tree stops being a 180-row list; debug links stop being nav.

---

## 9. Responsive spec

| tier | width | sidebar | main | TOC | notes |
|---|---|---|---|---|---|
| phone | < 640 | overlay drawer (fixed, scrolls independently, sticky close) | 1 col, 100 % − 2 rem | none; "On this page" becomes a `<details>` under the h1 | members grid 1 col; h1 wraps (`overflow-wrap: anywhere`); tables in `.table-scroll` |
| tablet | 640–1023 | 15 rem rail, collapsible, state persisted | `minmax(0,1fr)` with 46 rem prose measure | none; `<details>` TOC | signature/code blocks scroll |
| desktop | 1024–1279 | 17 rem | 46 rem prose / 100 % wide blocks | none (or 13 rem when main ≥ 40 rem after sidebar) | — |
| wide | ≥ 1280 | 19 rem | 46 rem prose / 100 % wide blocks, left-aligned | 15 rem, all h2+h3 | layout cap 96 rem; header background full-bleed, header content capped |

Breakpoints in `em` (40 / 64 / 80) rather than px so they scale with user font size. Hide
`.toc-collapse-label` whenever the TOC column is absent. Persist collapse state in localStorage.

---

## 10. Quick wins (each < 1 h)

1. Move the Summary/Extended Summary sections above Signature and Members on qualname pages
   (`[...slug].astro`: render `QualnameDocSections` summary parts before `:180`). Fixes the #1 reading
   complaint.
2. `header.qa-header h1 { overflow-wrap: anywhere }` and `@media (max-width: 40em) { ul.qualnames { columns: 1 } }`
   — removes horizontal scroll at 390.
3. Delete `max-height: 40vh; overflow-y: auto` from `.sidebar-qualnames` (`global.css:1269-1270`) and add
   a 3-line inline script that `scrollIntoView`s `.sidebar-qualnames .is-active` on load.
4. Hide `.toc-collapse-label` inside the `@media (max-width: 1100px)` block (`global.css:508-516`) —
   reclaims the phantom 32 px column.
5. Add `id="main"` to both layouts' `<main>` and a visually-hidden `<a class="skip-link" href="#main">`
   as the first child of `<body>`.
6. Bind `/` and `Ctrl/⌘+K` in `BundleSearch.tsx` to open the dialog (`document.addEventListener("keydown")`
   in the existing `useEffect`).
7. Gate the "Browse" section and the Raw JSON link on `isAuthenticated` (the helper already exists in
   `lib/auth.ts` and is used in `index.astro:14`).
8. Remove the *top* prev/next nav on doc pages (`docs/[...doc].astro:94-119`), keep the bottom one.
9. In the TOC scroll-spy, skip collapsing when `parentH2Id` is undefined (`docs/[...doc].astro:224-232`;
   or compute `minLevel` in `doc-page.ts:95-104` and treat it as level 1) — fixes the empty TOC on
   `docs/interactive/magics/`.
10. `.bundle-main > :is(p, ul, ol, dl, blockquote, .admonition, h1, h2, h3, header) { max-width: 46rem }`
    as a first-pass measure; refine later.
11. Hide the `:0` line suffix when `item_line` is 0 (`[...slug].astro:167,172`).
12. Map `item_type` metaclass names to "class" in `ir-reader.ts` and "function" → "method" when the
    qualname has a `.` after the `:`.
13. Show a static version pill when `versions.length === 1` instead of returning `null`
    (`DocSwitcher.tsx:91`).
14. Replace the "← bundles" / "← IPython 9.17.1" back-arrow crumbs on overview, text-search, images,
    nodes with the same trail markup the qualname page uses.
15. Sort members public-first (`[...slug].astro:98-101`: compare `label.startsWith("_")` before
    `localeCompare`) so the first chips a reader sees are the public API.

