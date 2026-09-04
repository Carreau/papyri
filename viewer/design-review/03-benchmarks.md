<!-- Generated 2026-09-04 against commit 8a9661c with IPython 9.17.1 and papyri 0.0.10 ingested. Screenshot references point at the full capture set produced by tools/screenshots.mjs; the subset committed under shots/ is listed in README.md. -->

# Reference survey: how the best doc front-ends solve papyri's page types

Raw material for an alternative-design proposal for `viewer/`. Sources: live HTML fetched
2026-09-04 (docs.rs tokio 1.53.1 / 1.0.0, docs.rs home, pkg.go.dev net/http + gorilla/mux@v1.7.0,
phoenix.hexdocs.pm Phoenix.Controller + overview (1.8.13, 1.6.0), numpy stable/2.1/1.24 linspace,
MDN Window.fetch, docs.stripe.com/api/charges/create, docusaurus.io/docs + /docs/2.x, Tailwind
Vite guide, Starlight sidebar guide, Furo admonitions page, MkDocs Material admonitions page) plus
upstream source for JS-rendered parts (rustdoc `main.js`/`settings.js`, pydata-sphinx-theme
`pydata-sphinx-theme.js`, DevDocs `help_tmpl.js`/`settings_tmpl.js`).
**Could not fetch**: hexdocs.pm home and devdocs.io home are JS shells (no server HTML); Stripe's
HTML is a 1.7 MB SPA (text extracted, layout partly from memory); MkDocs Material keyboard keys
are from memory (fetch of `bundle.ts` returned nothing). Marked "(mem)" where relied on.

Papyri today (screenshots `shots/*--desktop-light.png`): home = card grid + filter box; bundle
overview = two big cards (Narrative docs / API reference) + diagnostics buttons; every bundle
page has a left sidebar with DOCS / BROWSE (Text search, Images, Math, Code, All nodes) / API
(symbol search + module tree); class page = kind label ("METAHASTRAITS"), qualname, source path,
SIGNATURE, then "Members" as a two-column chip list; "{ } Raw JSON" button top-right on every
page for every reader; docs pages get a right "ON THIS PAGE" rail; search is a modal with
name + qualname rows.

---

## 1. Multi-package home / package list

| Site | What the home page is | Row / card contents | Search on home |
|---|---|---|---|
| docs.rs | Search-first landing: "Find crate" box + **"I'm Feeling Lucky"** button; then **"Recent Releases"** feed (name-version, one-line description, "6 seconds ago", build-status icon). Tabs Recent / Stars / Recent failures / Failures (mem); Atom feed; "Build queue" link. | crate-version, description, relative time | Crate-name search; lucky = jump to top hit |
| pkg.go.dev | Search-first: one big box "Search packages or symbols" with three tips: *package e.g. 'http'*, *symbol e.g. 'Unmarshal' or 'io.Reader'*, *symbols within a package using the `#` filter*. Below: FAQ, footer. | n/a (no list; discovery is search) | Global symbol search across all modules |
| hexdocs.pm | JS app (not fetched). (mem) full-text search box over all published docs + package list. | | Global full-text |
| DevDocs | App shell: **left column is the whole home** — search input at top, list of enabled docs with disclosure triangles, "Enable more…" link; main pane shows welcome + shortcut tips. | doc name + version | Scoped by typing `js ` + Tab |
| pydata / Furo / Material / Docusaurus / Starlight / Tailwind / MDN / Stripe | Single-project — no multi-package home. | | |

**Worth borrowing**
- docs.rs / pkg.go.dev put *one search box* at the centre of the home; the package list is secondary (a feed, not the primary nav). Papyri's home is card-first with search buried in a small filter input; flipping that suits a hosted "hundreds of bundles" future better than a card grid.
- docs.rs "Recent Releases" with relative time + build status is exactly what a hosted ingest service should show (uploads, ingest OK/failed) — the same rows papyri's admin/maintenance pages show today, but public.
- pkg.go.dev's three search tips teach the query syntax right in the empty state (package / symbol / `#` in-package). Papyri's dialog has no empty-state guidance.
- DevDocs's persistent left doc list doubles as home, so "home" is never a separate page you leave the docs to reach.

## 2. Package landing / version overview

| Site | Header/meta block | Version selector | Landing body |
|---|---|---|---|
| docs.rs | docs.rs top bar (above rustdoc): crate-version dropdown → crate page, license, date, Links (Homepage / Repository / crates.io / Source), Owners, Dependencies (normal/dev/build), "100% of the crate is documented", Platform dropdown, Feature flags | Dropdown in top bar lists all versions; `/latest/` URL alias | Crate root doc = README-like prose ("A Tour of Tokio", "Feature flags", …) then **Re-exports / Modules / Macros / Attribute Macros** tables with one-line summaries; sidebar lists page Sections + "All Items" |
| pkg.go.dev | Breadcrumb "Discover Packages / Standard library / net / http" (copy icon); name + kind ("package standard library"); **"Version: go1.27.1 ▾" + "Latest" pill**; Published / License / Imports: 44 / Imported by: 1,776,917; tabs Main · Versions · Licenses · Imports · Imported By; right "Details" card with four green checks (Valid go.mod / Redistributable license / Tagged version / Stable version), Repository, Links, **Report a Vulnerability** | Version dropdown next to name; `@v1.7.0` in URL | Overview (README) + Index of *all signatures* on the same page; left "Jump to …" outline |
| hexdocs | Sidebar head: "Phoenix v1.8.13 ▾" | Dropdown at top of sidebar; latest labelled "Latest" | Overview guide page; tabs Guides / Modules / Mix Tasks |
| pydata (numpy) | Navbar: sections (User Guide / API reference / …), search Ctrl+K, **"Choose version ▾"** (fed by `_static/versions.json`: `dev`, `2.5 (stable)` preferred, 2.4 …), GitHub, theme | Dropdown in navbar | Sphinx index page |
| Docusaurus | Navbar version dropdown "2.x ▾": Canary 🚧, 3.10.2 … 2.x, "Archived versions", "All versions"; "Version: 2.x" badge under title | Navbar | Docs intro page |
| Tailwind | "v4.3 ▾" badge next to logo, links to older major docs | Header badge | Guide |

**Worth borrowing**
- pkg.go.dev's metadata strip (version ▾ + Latest pill, published, license, imports/imported-by) is the model for papyri's project page: papyri already has the table + GitHub/PyPI cards but they are placeholders ("—"); pkg.go.dev shows how to make that block *the* landing header on every page, not a separate page.
- docs.rs shows the landing as the root-module doc + module table; papyri's overview has two cards and diagnostics but no module table. Merging "bundle overview" and "root module page" (as rustdoc does) removes a hop.
- Version selector lives *next to the package name* in every site surveyed, never in a sidebar footer or a separate page.
- pkg.go.dev's right-hand "Details" card (checks + repo + report link) is where papyri's diagnostics ("14 broken incoming refs") belong — as a badge with explanation, off the main reading path.

## 3. Module / namespace page

| Site | Ordering | Member listing style | Sidebar on this page |
|---|---|---|---|
| rustdoc | Breadcrumb `tokio::sync`, "Module sync", Source link, module doc, then per-kind tables **Modules / Structs / Enums / Traits / Functions / Type Aliases** — each row = name + one-line summary (+ feature badge) | Two-column table (name, summary) grouped by kind | crate + version, "Sections" (headings of the doc), kind lists, "In tokio::" (siblings) |
| pkg.go.dev | Overview → **Index** (every exported signature, methods nested under types, `deprecated` tag) → Examples → Constants → Variables → Functions → Types, all on one long page | Signatures, not names; `¶` anchor + "View Source" per item; "added in go1.1" tags | Left "Jump to …" outline mirrors the page; platform "Rendered for linux/amd64 | …" |
| hexdocs | Module doc prose → **Summary** (Types, Functions: `accepts(conn, accepted)` + one-liner) → full Types → full Functions | Summary list with arity, one-line doc | Modules tab tree, functions nested under expanded module |
| pydata | Sphinx autosummary tables (name + summary) | Table | Section nav |
| MDN | Interface page: description, Constructor, Instance properties, Instance methods, Events, Examples | dl name/summary with status badges (Deprecated, Experimental) | Sidebar groups: Instance properties / methods / Events / Inheritance / Related pages |

**Worth borrowing**
- Every reference site shows a **one-line summary next to each member name**; papyri's module and class pages show bare chips (`ipython-module-big`, `ipython-class`). The IR already has the summary paragraph.
- Group by kind (classes / functions / constants / submodules) as rustdoc/pkg.go.dev do, instead of one alphabetical chip list mixing `_IPythonMainModuleBase`, `ExecutionInfo`, `is_integer_string`.
- rustdoc's sidebar changes per page: page sections first, siblings ("In tokio::sync") second. Papyri's sidebar is the same global tree on every page.
- pkg.go.dev's "Index of signatures" is the fastest scanning surface for a module; a collapsible "Index" block at the top of a module page costs nothing.

## 4. Class / struct page with many members

| Site | Head | Body order | Member presentation |
|---|---|---|---|
| rustdoc (Mutex) | `tokio::sync` breadcrumb · **"Struct Mutex"** · "Copy item path" · "Source" (right) · code decl `pub struct Mutex<T: ?Sized> { /* private fields */ }` · badge "Available on crate feature `sync` only." · "Expand description" toggle | description → **Implementations** (Associated Functions `new`, `const_new`; Methods `lock`, `try_lock`…) → Trait Implementations → Auto Trait Implementations → Blanket Implementations | Each method = `<details>` with signature + "Source" link, doc collapsible; `+`/`-`/`_` expand/collapse all; sidebar lists Sections / Associated Functions / Methods / Trait Impls / … as anchors |
| pkg.go.dev (`type Response`) | `type Response ¶` + View Source + struct literal with field comments | Type doc → constructor funcs (`func Get`, `func Head`…) → methods `func (r *Response) Cookies()` nested | All inline, one page; outline nests methods under the type |
| hexdocs | h1 `Phoenix.Controller (Phoenix v1.8.13)` + Copy Markdown + View Source | moduledoc → **Summary** (Types/Functions one-liners) → full entries with `@spec`, anchor icon, View Source, Examples | Inline, anchor per function `#accepts/2` |
| pydata (ndarray) | title + full signature + `[source]` | description → Parameters → **Attributes table** → **Methods table** (signature + one-liner) → See also → Notes → Examples | Table rows link to *separate* per-method pages; "On this page" shows only the class |
| MDN (Response) | "Response" + Baseline widget | Constructor → Instance properties → Instance methods → Examples → Specs → Compat | dl of links to per-member pages with status badges |
| Stripe | "The Charge object" | Attributes list `id string`, `amount integer`, expandable child attributes; right sticky JSON example | Inline, expandable |

**Worth borrowing**
- rustdoc's split of **Associated functions / Methods / Trait impls** with a per-page sidebar anchor list is the closest analogue to Python's classmethods / methods / properties / dunder; papyri's "Members" is one undifferentiated list with `__init__` and `_atexit_once` first.
- pydata's Attributes/Methods *tables with one-line summaries* are what numpy users already read; papyri has inline members planned (`x-inline-members`) — rustdoc shows how to make inline *and* scannable: collapsed `<details>` per member with the first paragraph as summary.
- rustdoc/hexdocs put the "Copy item path" / "Copy Markdown" affordance in the title line; papyri's qualname header has none.
- Private-looking members (`_foo`) are hidden by rustdoc entirely and by pydata by default; papyri lists 30+ underscore members before the public API.

## 5. Single function page

| Site | Title line | Signature block | Section order |
|---|---|---|---|
| rustdoc (`task::spawn`) | breadcrumb `tokio::task` · "Function spawn" · Copy item path · Source · feature badge "Available on crate feature `rt` only." | `pub fn spawn<F>(future: F) -> JoinHandle<F::Output> where …` with linked types | prose → Examples → Panics → "Using `!Send` values"; sidebar: Sections + "In tokio::task" |
| pkg.go.dev (`Get`) | `func Get ¶` · "View Source" · "added in go1.x" when applicable | `func Get(url string) (resp *Response, err error)` with linked types | prose → Example (runnable "Share Format Run") |
| pydata (`linspace`) | `numpy.linspace` + `#` anchor | `numpy.linspace(start, stop, num=50, endpoint=True, …, *, device=None)` + `[source]` | one-line summary → "Changed in version 1.20.0" → Parameters (dl: `start` / `array_like` / text) → Returns → See also → Examples → prev/next footer |
| MDN (`fetch()`) | "Window: fetch() method" + **Baseline: Widely available** | Syntax box listing overloads `fetch(resource)` / `fetch(resource, options)` | Parameters (dl with "Optional" badge) → Return value → Exceptions → Examples → Specifications → Browser compatibility → See also |
| hexdocs (`accepts/2`) | `accepts(conn, accepted)` · link icon · View Source · `@spec` line | `@spec accepts(Plug.Conn.t(), [binary()]) :: Plug.Conn.t()` | prose → Examples |
| Stripe (`Create a charge`) | title + **Deprecated** tag + "Ask about this section / Copy for LLM / View as Markdown" | `POST /v1/charges` | Parameters (name · type · **Required** badge · "Show child parameters") ‖ right sticky request/response |

**Worth borrowing**
- Everyone puts the *one-line summary immediately under the signature*, before Parameters. Papyri's method page follows the numpydoc order already; keep it, but drop the "SIGNATURE" section heading — no site labels the signature.
- Version/status badges in the title line: rustdoc feature badge, pkg.go.dev "added in go1.1", MDN Baseline, Stripe Deprecated. Papyri's IR has `versionadded/deprecated` directives; surface them as a pill next to the name.
- Stripe's "View as Markdown / Copy for LLM" and hexdocs "Copy Markdown" are the reader-facing form of papyri's "Raw JSON" — a copy action, not a route into the IR.
- rustdoc's sidebar for a function page = this page's headings + siblings in the same module. That is a cheap, high-value replacement for the global tree on leaf pages.

## 6. Narrative guide page

| Site | Columns | Left rail | Right rail | Bottom |
|---|---|---|---|---|
| pydata | 3 | section tree for current top-level section (User Guide / API …) | "On this page" + Show Source / Edit on GitHub | prev/next with titles, copyright, theme credits |
| Furo | 3 (≈20/60/20, content max-width) | brand + search + full "Contents" tree | "On this page" | prev/next cards with arrows, "Made with Sphinx and Furo", back-to-top |
| MkDocs Material | 3 + **tabs row** for top-level sections | section tree, "Back to top" | "Table of contents" | prev/next with titles, copyright, social icons; announcement bar; edit/view-source icons at title |
| Docusaurus | 3 | collapsible categories, "hide sidebar" button at bottom | "table of contents" | "Edit this page", "Last updated on … by …", Previous/Next cards |
| Starlight | 3 | groups, collapsible, "New" badges | "On this page" with an "Overview" entry | "Last updated: …", "Edit page", Previous/Next |
| Tailwind | 3 | flat grouped lists (Getting started, Core concepts, …) | "On this page" | prev/next |
| hexdocs | 2 (sidebar + content; no right rail) | Guides / Modules / Mix Tasks tabs | none — headings are nested under the page in the sidebar | "← Previous Page Changelog" / "Next Page → Installation", View Source at title |
| MDN | 3 | related pages for the API | "In this article" | "Was this page helpful?", Help improve MDN: View on GitHub · Report a problem, last modified |

**Worth borrowing**
- Papyri's doc page already matches the three-column norm (`ipython-doc-tutorial`) — it is the API pages that break from it (no right rail, sidebar = global tree).
- Material's **tabs row** (top-level sections) is how a large project separates User Guide / API / Dev guide without a 200-item sidebar; pydata does the same in the navbar. Papyri collapses all 73 IPython pages into one tree.
- Docusaurus's "hide sidebar" toggle at the *bottom* of the rail and Furo's back-to-top are small but shipped everywhere; papyri's collapse chevron is at the top and the collapsed state loses the tree.
- Every site has prev/next *with titles*; papyri has "← Tutorial / Rich Outputs →" at the top only.

## 7. Search (global + per-package)

| Site | Trigger | UI | Scoping | Query syntax |
|---|---|---|---|---|
| rustdoc | `S` or `/` focus, `?` help | Inline results page with tabs "In Names / In Parameters / In Return Types"; `←/→` switch tab, `↑/↓`, `⏎`; `+`/`-`/`_` expand/collapse sections | Per crate (docs.rs top bar box = crate search) | `fn:` `mod:` `struct:` … kind prefix; type-signature `vec -> usize`; exact `"string"`; path `vec::Vec`; setting "Directly go to item if only one result" |
| pkg.go.dev | `/` search, `f` "Jump to Identifier", `y` canonical URL, `?` modal | Site search results page; **Jump-to dialog filters the current page's outline** | Global by default; `#` filters symbols within a package | package / symbol / `pkg#symbol` |
| hexdocs | `/` ("Press / to search"), `?` help | Sidebar box with **search-engine selector**: "Latest — Search latest versions of Plug, Phoenix, Phoenix.{HTML, LiveView, PubSub, Template}" vs "Current version — Search only this project" | Per project *or* across the project's declared dependency set | Typesense full-text |
| DevDocs | typing anywhere focuses search; `?` help; `Esc` clear | Sidebar list is the result list; `Tab`/`↓` move, `⏎` open, `Ctrl+⏎` new tab, `Alt+R` reveal in sidebar; `Ctrl+,` prefs | **`js ` + Tab scopes to one doc**; URL `#q=js date` | prefix scope |
| pydata / Starlight / Docusaurus / Tailwind | `Ctrl+K` / `⌘K` | Modal command palette (DocSearch-style) | Per site | full-text |
| MkDocs Material | `/`, `s`, `f` (mem); `p`/`,` prev page, `n`/`.` next page (mem) | Header overlay with "Type to start searching" | Per site | full-text |
| Stripe | `/` "Find anything", "Ask AI" | Palette | Per site | |
| MDN | header box, "Filter" in sidebar | Results page | Global | |

**Worth borrowing**
- hexdocs's scope switch ("this version" vs "latest of this project + its deps") is the closest existing answer to papyri's planned cross-bundle search and version pinning — one selector in the search box, not a separate page.
- DevDocs's `pkg ` prefix scoping and pkg.go.dev's `pkg#symbol` give a *typed* scope the URL can carry (`/text-search/?q=…` already exists in papyri).
- rustdoc's result tabs (names / parameters / return types) map to papyri's IR (name / param names / return type); tabs beat one flat list of `run_cell` × 5 qualnames (`x-search-dialog`).
- pkg.go.dev's `f` "jump to identifier on this page" is a second, page-local palette — cheap for class pages with 200 members.
- Standardise on `/` *and* `Ctrl+K`, `?` for a help dialog; papyri's dialog has no visible shortcut hint anywhere in the chrome.

## 8. Version switching and "old version" banners

| Site | Where the switcher lives | Old-version signal (exact text) | Notes |
|---|---|---|---|
| docs.rs | crate-version dropdown in docs.rs top bar; `/latest/` alias | `div.warning`: **"This release has been yanked, go to latest version"** (yanked); for merely old builds the same slot shows an "old version" warning with "go to latest version" link (mem) | Version switch keeps the item path; dropdown also carries Platform + Feature flags |
| pkg.go.dev | "Version: v1.7.0 ▾" + pill; `@v1.7.0` URL | Inline under the version: **"This package is not in the latest version of its module. Go to latest"**; "Latest" pill when current | Also a "Versions" tab listing all with dates |
| pydata (numpy 2.1) | "Choose version ▾" in navbar from `versions.json` (`preferred: true` marks stable) | Client-side banner `#bd-header-version-warning`: **"This is documentation for an old version (2.1)."** + button **"Switch to stable version"** (checks the same path exists on stable before redirecting; dismissable, remembered) | numpy 1.24 (older theme build) shows *no* banner — signal depends on the theme version each build used |
| Docusaurus | navbar dropdown (Canary 🚧 / 3.10.2 … / Archived versions / All versions); "Version: 2.x" badge under h1 | `alert--warning` above the article: **"This is documentation for Docusaurus 2.x, which is no longer actively maintained. For up-to-date documentation, see the latest version (3.10.2)."** | Separate text for unreleased: "This is unreleased documentation for … Next version." |
| hexdocs | "v1.8.13 ▾" at top of sidebar, latest marked "Latest" | none found in the 1.6.0 static HTML (dropdown label is the signal) | |
| Tailwind | "v4.3 ▾" badge by logo | v3 docs are a separate site with a header link back | |
| MkDocs Material | mike selector next to site name (mem) | optional banner via mike (mem) | |

**Worth borrowing**
- Two distinct states, both sites that do it well phrase them differently: *old* ("not the latest… Go to latest") vs *unreleased/dev* (Docusaurus "unreleased", pydata "unstable development version"). Papyri's `VersionBanner.astro` should carry both since bundle staging/PR previews are planned.
- pydata's "switch keeps the path, falls back to root if the page doesn't exist" is the right behaviour for qualname URLs (`/project/IPython/<ver>/<qualname>/`).
- The switcher sits beside the package name in every site; papyri's project page is a separate route (`/project/IPython/`) with no per-page dropdown.
- pkg.go.dev's "Latest" pill on the current version is as important as the warning on the old one.

## 9. Developer / debug surfaces

| Site | Reader-visible dev affordance | Where the rest is hidden |
|---|---|---|
| rustdoc / docs.rs | "Source" link in the title line and per method (right-aligned, small); "Copy item path" | **Settings page** (gear icon → `settings.html`): Theme / preferred light/dark theme / *Auto-hide item contents for large items* (on) / auto-hide method docs / auto-hide trait impls / go-to-only-result / line numbers / hide persistent nav bar / hide TOC / hide module navigation / disable shortcuts / sans-serif / word-wrap source / hide deprecated items. Help page (`?`). docs.rs crate page: build logs, "Rustdoc JSON", "Build queue", "Metadata", badges — all under the docs.rs menu, never in rustdoc chrome |
| pkg.go.dev | `¶` anchors, "View Source" per declaration, "Report a Vulnerability" in the right Details card, "Report an Issue" + "Theme Toggle" + "Shortcuts Modal" in the *footer* | No IR/JSON surface at all; platform "Rendered for …" selector is the only build-time knob |
| hexdocs | "View Source" at h1 and per function; footer: "View llms.txt", "Download ePub", "Built using ExDoc (v0.40.3)"; "Copy Markdown" | Settings cog (theme, shortcuts) in sidebar header |
| pydata | `[source]` next to signature; "Show Source" / "Edit on GitHub" in the *right* rail | Theme toggle in navbar |
| MDN | Footer only: "View this page on GitHub • Report a problem with this content", last-modified/contributors, "Was this page helpful?" | Baseline/compat data is reader content, not debug |
| Stripe | "View as Markdown / Copy for LLM / Ask about this section" per section | API version selector in header; sandbox/live toggled by sign-in |
| DevDocs | none in content; `Alt+O` open original page, `Alt+C` copy original URL | Preferences page (`Ctrl+,`): theme, fixed-width layout, sidebar auto-hide, offline download, arrow-scroll, export/import |

**Worth borrowing**
- Nobody puts a raw-data button in the title line for readers. Papyri's "{ } Raw JSON" (every page) and BROWSE › "All nodes / Math / Code / Images" belong behind an admin/contributor toggle (papyri already has auth + a settings menu) or under a footer "Built with papyri · IR" link, as docs.rs relegates build logs to the crate page.
- rustdoc's settings page is the model for reader preferences papyri will want (auto-collapse large member lists, hide private members, hide deprecated) — and it is one static page, not a menu.
- pkg.go.dev's footer trio (Report an Issue · Theme Toggle · Shortcuts) shows that theme and shortcuts help can live in the footer without a header gear.
- pydata/rustdoc keep `[source]` tiny and adjacent to the thing it links; papyri's "source: /IPython/core/interactiveshell.py:345" is a full metadata line above the signature.

---

## Three coherent directions

**A. docs.rs-style dense reference (rustdoc + pkg.go.dev)**
Two columns: a *per-page* left rail (this page's sections → members grouped by kind → siblings in the parent module) and a wide content column. Module pages become kind-grouped tables with one-line summaries; class pages inline every member as a collapsed `<details>` with signature + summary, expand-all / collapse-all keys; function pages are short with a feature/version badge in the title line. Version dropdown + "Latest" pill + "Go to latest" note next to the package name on every page; project metadata (repo, PyPI, license, imports) in a pkg.go.dev-style header strip. Search: `S`/`/` inline results with Name / Parameter / Return tabs, `fn:`/`class:` prefixes, `#` in-package scoping.
*Optimises for*: API readers at numpy/scipy scale — fast scanning, everything on one page, great for keyboard users; the sidebar always answers "where am I / what else is here". Easiest to make dense pages feel intentional.
*Costs*: narrative docs feel bolted on (rustdoc has no guide sidebar; papyri would need a second layout as hexdocs does with its Guides/Modules tabs); long class pages get very long (mitigated by rustdoc's auto-hide setting); the global module tree disappears from most pages, so cross-module orientation relies on breadcrumb + search.

**B. pydata/Furo-style reading-first three-column (numpy, Furo, Starlight, Material)**
Keep the current shell but commit to it: top navbar with *section tabs* (Guide · API · Examples · Dev) and the version chooser; left rail = tree of the *current section only* (guide TOC or module tree, never both); right rail = "On this page" on *every* page including API pages (Parameters / Returns / Examples / Members-by-kind); prev/next with titles at the bottom; `[source]`, "Show source", "Edit" in the right rail footer. Class pages use pydata's Attributes/Methods summary tables linking to member pages, with the planned inline-member view as a toggle. Search = `Ctrl+K` palette with a scope switch ("this version / latest of all packages").
*Optimises for*: the audience papyri actually targets first — Python users who already read numpy/pandas/scipy docs in exactly this layout; narrative and API share one visual system; least redesign risk (the doc page already looks like this).
*Costs*: three columns + tree + TOC eat width at 1024–1280 px (pydata hides the right rail below ~1200 px); per-page rails don't give rustdoc's "siblings + members" orientation, so big classes still need a members index; two sidebars to keep in sync on every route.

**C. DevDocs-style app shell (DevDocs + hexdocs sidebar + Stripe)**
A persistent left column that *is* the navigation and the search: a search input pinned at top, below it the package list (each package a disclosure with version pill; expanding shows Guides / Modules; expanding a module shows members), scoped search by typing `numpy ` + Tab. Content column is single-column, reading-width, with Stripe-style sticky secondary panel on wide screens (examples / signature / on-this-page). Version switching and "old version" state are per-package rows in the sidebar; `?`, `/`, `Alt+←/→`, `Alt+R` (reveal in sidebar) keyboard model; preferences page (theme, hide private members, wide layout, collapse members) instead of a header gear. Debug tooling only via preferences ("contributor mode" reveals Raw JSON / nodes / diagnostics).
*Optimises for*: the hosted multi-package promise — cross-package browsing and search are the primary interaction, not a home page; one URL scheme (`#q=numpy linspace`) shared by search, deep links and the CLI; strong keyboard story; the shell scales from 2 to 2,000 bundles without a card grid.
*Costs*: it is an app, not a document — SSR/SEO and "no-JS" reading degrade, and it fights Astro's per-route SSR model (the shell wants to persist across navigations); sidebar tree state for 1,400-symbol packages needs virtualisation; narrative pages lose the familiar Sphinx look that library maintainers expect; harder to theme per project.

A pragmatic hybrid many sites converge on: **B's shell with A's page anatomy** (per-page members/sections in the right rail, kind-grouped tables with summaries, badges in the title line, version dropdown + Latest pill by the package name) and **C's search** (scoped palette with `pkg ` prefix and result tabs), with all IR/diagnostic surfaces gated behind the existing login.

