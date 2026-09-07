# Direction C — App shell (DevDocs / hexdocs / Stripe)

**Optimises for** the hosted multi-package promise. The left column *is* the product: search
pinned on top, every package underneath, each a disclosure row with its version state. Nothing
leaves the docs to reach "home" — `home.html` is the same shell with nothing selected. One
query model (`numpy ` + Tab scopes, `class:`/`fn:` prefixes, `#q=` in the URL) is shared by the
sidebar, deep links and, later, the CLI. Reading column is one 72ch measure with a Stripe-style
sticky secondary panel on ≥ 1440 px. Readers never see IR tooling; contributors flip it on in
Preferences.

**Costs** (see "The cost" below): it is an app, not a document. The shell wants to persist
across navigations, which fights Astro's per-route SSR; SEO/no-JS degrade to "works but
re-renders the rail on every page"; the rail must be virtualised/lazy for 1,400-symbol packages;
narrative pages lose the Sphinx look maintainers expect; per-project theming is limited to the
monogram/hue.

## Page anatomy (ordered regions, main column; `[P]` = secondary panel)

| Page | Regions |
|---|---|
| **Class** (`class.html`) | trail › title block (kind badge, short h1, qualname + copy, version marker, source · metaclass · alias) › **Summary** (empty-state when the IR says *No Docstrings*) › Signature › **Members**: kind-grouped rows (`Methods 97` · `Static methods 1`), each row = name + first sentence (real, harvested from `.inline-member`; "—" when absent), expandable inline to signature + summary + parameters, *Expand all* per group › `Private 18` folded, names only › Aliases. `[P]` on-this-page · *Expand all inline* + *Hide private* toggles · member index grouped by kind with counts (scrollable) · contributor box. |
| **Function** (`function.html`) | trail (parent class linked) › title block › one-line summary as lede › Signature › Parameters (anchored per param) › Returns (split out of the `Returns / -------` residue) › Examples (empty-state) › sibling prev/next + `Alt+←/→` hint. `[P]` signature card (one param per line) · parameter jump list · Examples · See also. |
| **Doc** (`doc.html`) | trail from the toctree (`IPython › Guide › Tutorial`) › `GUIDE` badge + h1 (no path chip; IR path only in contributor mode) › body at 72ch, code/tables full column, tables in `.table-scroll` › prev/next cards with titles, bottom only. `[P]` on-this-page h2+h3, highlight-only scroll-spy, never collapses. |
| **Overview** (`overview.html`) | trail › masthead (monogram, name, version marker, summary, PyPI/GitHub/upstream/license/uploaded pills) › jump row (Guide · API · most-referenced class) › docs index body inline › Versions table. `[P]` on-this-page · jump list · contributor: broken refs, diff. |
| **Home** (`home.html`) | h1 product statement › big search affordance › four query tips › *Recently updated* (relative time, ingest status: ingested / failed / staged) › keyboard cheatsheet. Rail: all 24 packages collapsed. |
| **Prefs** (`prefs.html`) | theme (system/light/dark) · wide layout · hide private · expand members inline · contributor mode. Persisted in `localStorage["papyri:prefs"]`, applied on every page before paint. `Ctrl+,` opens it. |

Title block everywhere carries a compact, **non-dismissible** version marker (`9.17.1 · latest`).

## Sidebar

20 rem, its own scroll container (the only one — no nested `max-height` boxes). Head: brand +
search input (`/`, `Ctrl+K`); typing replaces the package list with grouped results (Packages /
Symbols with a package column / Docs); `pkg ` + Tab scopes (chip in the input, ⌫ on empty
unscopes). Body: one `<details>` per package, monogram + name + version pill; the open package's
summary is sticky. Pill states: `9.17.1 · latest` (green), `1.11.4 · older → 1.16.0` (amber,
scipy), `staged · pr-1234` (purple, matplotlib). Inside a package: Guide (toctree, current
chapter open) · API (module tree: ancestors open, siblings collapsed, non-active branches
`data-lazy` — filled on expand) · Examples. Active row has `aria-current="page"` and is scrolled
into view on load; `Alt+R` re-reveals it. Foot: Preferences · theme · contributor · `?`.
Non-IPython packages show "fetched on expand" placeholders: only the current package's tree is in
the HTML.

## Responsive

| tier | rail | panel |
|---|---|---|
| ≥ 1440 (90em) | 20 rem fixed | sticky right column, 17 rem |
| 1280–1439 | 20 rem fixed | folds under the title as `<details>` |
| 1024–1279 (64–80em) | **icon rail** 3.5 rem (search glyph + monograms); any click opens it as a 20 rem overlay | folded |
| < 1024 | hidden; top bar (menu · brand · search) opens it as an overlay with backdrop, `Esc` closes | folded |

Members grid goes 1-col at < 1024; prev/next stacks; no horizontal scroll at 390–1920 (checked).

## Search model

The rail is the result list (DevDocs). Default scope = everything; `pkg ` + Tab scopes; results
carry a package column when unscoped; `↑/↓/⏎`; URL form `#q=numpy linspace`. Kinds are shown as
a column (function / class / method / doc) — rustdoc-style tabs (names / params / returns) fit
as a second row later. Staged bundles are excluded from results.

## Where PLAN.md features land

- **Inline members** — the member rows *are* the inline view; `Expand all` (panel) / per-group
  buttons / `expandMembers` pref; `?inline-members=1` maps to "all rows open". Bodies are in the
  HTML here; in the viewer they should be fetched on first open (one blob per member).
- **Staging / PR preview** — sidebar pill (`staged · pr-1234`), title-block marker variant
  (`.ver-mark.staged`), home *Recently updated* row, excluded from search.
- **Diagnostics badge** — contributor box in the panel (`0 errors · 14 warnings` → validate
  page); unresolved xrefs get dotted underline for readers, orange/red outline + `data-debug`
  tooltip only under `html[data-dev]`.
- **Cross-bundle search** — the rail search, unscoped by default; package column on hits.
- **Version pins** — the per-package pill is the pin display ("older → latest"); a pinned xref
  would render the same pill inline next to the link.

## The cost, explicitly

**Astro per-route SSR vs a persistent shell.** Today every route renders `BundleLayout` server-
side and the browser replaces the whole document. This shell can *look* persistent under that
model with `<ClientRouter />` (view transitions): mark the rail `transition:persist` so its DOM,
scroll offset and open `<details>` survive navigations, and let `main` swap. What must become a
client island regardless: the search (`SearchRail.tsx` — results replace the package list,
scope chips, keyboard), the lazy tree branches (fetch `/api/[pkg]/[ver]/tree?path=…` on
expand), member-row bodies (fetch on open), prefs application. What stays SSR: the title block,
body, panel skeleton, the *current* package's Guide/API tree (ancestors + siblings only, ~60
rows), the package list itself (24 rows, or the first N + "more" for hundreds — `/api/bundles.json`
already exists). Without view transitions the shell still works, it just re-renders the rail on
every navigation and loses transient state (open branches, search text) — acceptable as the
no-JS floor, not as the default.

**SEO / no-JS.** Every page is complete HTML: rail, trail, title, body, panel, prev/next, member
rows (native `<details>`), preferences as a plain form. Without JS you lose: search, lazy
branches (the closed branches show "fetched on expand"), scroll-spy, keyboard model, rail
overlay on < 1024 (it needs a checkbox-hack fallback or stays hidden — accept the latter, the
trail + prev/next still navigate). Crawlers see the same HTML as readers; the rail's 24×3 links
are a mild crawl-budget cost, so `nofollow` the non-current packages' section links.

**1,400-symbol trees.** Never ship the full tree. Server renders ancestors-of-active + their
siblings (IPython class page: 64 rows, function page: 64 + 98 public members + a folded private
group). Every other branch is a `<details data-lazy>` whose children are fetched on expand and
rendered as a flat list; branches with > ~200 children (numpy's root) get a windowed list
(fixed row height 22 px, `content-visibility: auto` on the `<ul>` first, real virtualisation
only if profiling demands it). The member index in the panel is capped by a scrollable
`max-height` and would get a filter input at > 50 members (pkg.go.dev's `f`).

## Migration note (`viewer/src/`)

- **Layouts**: fold `BaseLayout` + `BundleLayout` into one `AppShell.astro` (rail + content +
  optional panel slot); `AdminLayout` stays. `BundleSidebar.astro` → `Rail.astro` (package list,
  SSR) + `SearchRail.tsx` island + `TreeBranch.astro` (lazy `<details>`). Add `<ClientRouter />`
  and `transition:persist` on the rail.
- **Pages**: `[...slug].astro` uses a `TitleBlock.astro`, `MemberRows.astro` (kind-grouped,
  summaries from the blobs `qualname-page.ts` already loads), `Panel.astro` slots per page type.
  `docs/[...doc].astro` drops the top nav and the path chip; `index.astro` (home) becomes the
  welcome pane; `project/[pkg]/index.astro` folds into the overview's Versions section;
  `settings.astro` gains the reader prefs. New: `api/[pkg]/[ver]/tree.json.ts` (branch
  children), `api/search.json.ts` (cross-bundle, `pkg`/`kind` filters).
- **CSS**: replace `global.css` tokens with the review's token set (verbatim here); add
  `--rail-w/--panel-w`, the 64/80/90em tiers, `html[data-dev]` gate for diagnostic xref styles,
  `html[data-hide-private]`, `html[data-wide]`; delete `.bundle-index-card`, `.doc-page-nav--top`,
  `.raw-json-link`, the Browse section, and the checkbox collapse hacks.
- **Verified** during the review: 6 pages × 5 widths + dark + 12 interaction states, no horizontal overflow (build and capture scripts not committed).
