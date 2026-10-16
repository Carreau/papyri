# Direction B — Reading-first (pydata / Furo / Starlight shell + rustdoc page anatomy + scoped palette)

Prototypes: `home.html`, `overview.html`, `doc.html`, `class.html`, `function.html` (self-contained, built from real DOM pulled from the running viewer; the build, harvest and screenshot scripts are not committed). Layout QA during the review covered 5 pages × 390/768/1024/1440/1920 plus dark and interaction states. Tokens and type scale are the design-review proposal verbatim (top of each file's `<style>`).

## What it optimises for, what it costs

**For:** the audience papyri targets first — people who already read numpy/pandas/scipy docs in exactly this three-column shape. Narrative and API pages share one shell and one visual system; the page you land on from a search always answers "what is this / where am I / what else is here" in the first viewport. Least redesign risk: the doc page already looks like this, and every change is a template/CSS change, not an IR change.

**Costs:** three columns eat width — the right rail disappears below 1280 and the left rail becomes a drawer below 1024; two rails must stay in sync on every route (contextual left rail + scroll-spy right rail); the module tree is still long on a 116-member class (mitigated: one scroll container, active item centred on load, other branches folded); big classes still need the members index, which is why it lives in the right rail rather than a second sidebar.

## Page anatomy (ordered regions)

- **Home** — masthead h1 + counts · search-first input (filters the list live; `⏎`, `/`, `Ctrl+K` open the palette) · query-syntax tips · at most 3 featured cards · "All packages" table (name · latest · summary · counts · updated) with Name / Recently-updated sort. Staged rows appear only in contributor mode.
- **Overview** (`/project/<pkg>/<ver>/`) — banner stack (staged / old-version / pinned — stackable, staged is not dismissible) · masthead (logo frame, name, version pill ▾, summary, link pills, maintainer-only diagnostics pill) · jump row (Guide · API · Examples with counts; Examples dashed when empty) · the docs index page body rendered inline with "Open as a page" · Versions folded in `<details>` (absorbs `/project/<pkg>/`) · contributor-only Diagnostics/Staging strip. Right rail: landing headings + Versions.
- **Class** — trail → title block (kind badge + metaclass, short mono h1, muted qualname + Copy, `file:line` source link) → summary (lede, hidden h2) → Signature → **Members** grouped: Constructor · Methods · Static methods · Private (N) folded; rows = name · one-line summary harvested from the member docstrings ("—" when absent) → Aliases → sibling nav (‹ ExecutionResult · InteractiveShellABC ›). *Referenced by* and Parameters/Examples render only when the IR has them (this class has none). Right rail: Summary · Signature · Members (116) › groups · Aliases, plus the **Inline member docs** toggle: rows become `<details>` cards (real signature + extended summary + Parameters/Returns/Notes/Examples), group headers get Expand/Collapse all, and the rail grows a per-member index; `#m-<name>` deep links open the card.
- **Function / method** — trail → title block (badge "method") → Signature → summary → Parameters → Returns (rendered as its own section; today's IR emits it as three bogus `dt`s) → Aliases → sibling nav (‹ run_ast_nodes · run_cell_async ›). Right rail shown when ≥ 4 sections, with "Back to InteractiveShell" and View source.
- **Narrative** — trail from the toctree (`Tutorial › Introducing IPython`), h1 only (no kind label, no path chip — the path moves to the contributor-only Raw JSON entry), body at 72ch with code/tables/figures free to 100 %, prev/next cards at the bottom only. Right rail: every h2 + h3, highlight-only scroll-spy, no collapsing, "Next: Rich Outputs ›" at the foot.

## Sidebar behaviour

Sticky top bar: wordmark · package + version pill (`9.17.1 · latest ▾` menu: versions, latest/older/staged tags, "All versions…") · section tabs Guide · API · Examples (`aria-current`; Examples disabled when the bundle has none) · header search (`/`, `Ctrl/⌘K`) · theme · contributor toggle · login. The **left rail is contextual**: Guide pages show the toctree only (current chapter expanded, others `▸` with their real children); API pages show the module tree only — ancestors + siblings of the active node + its children, every other branch collapsed with `▸` and a count, private members folded under "Private (N)"; the overview shows the top-level toctree plus API/Examples rows. One scroll container, `top`/`height` derived from `--header-h`, active item scrolled to centre on load. Widths: 19 rem ≥ 1280, 17 rem 1024–1279, overlay drawer < 1024 (fixed, backdrop, sticky close, `Esc`, focus moved to the close button; section tabs move into the drawer head; login moves to the drawer foot < 640). The **Developer** section (Raw JSON, All nodes, Math, Code, Images, validate, backref-validate, IR stats) renders only under `html[data-dev]`.

## Responsive

| tier | left rail | main | right rail |
|---|---|---|---|
| ≥ 80em (1280) | 19 rem | 72ch prose, left-aligned; `pre`/tables/signature/member tables/figures to 100 % | 15 rem, sticky |
| 64–80em | 17 rem | same | hidden; `<details>` "On this page" under the h1 |
| < 64em (1024) | drawer | 1 col | `<details>` |
| < 40em (640) | drawer | 1 col; member table wraps names; jump/featured/sibling cards stack; `overflow-wrap: anywhere` on qualnames | `<details>` |

Breakpoints in `em`. QA script asserts no horizontal scroll, every `p` ≤ 72ch of its own font, exactly one h1 and no skipped heading levels at all five widths.

## Search model

One palette (`<dialog>`) everywhere: input · scope chips **IPython 9.17.1 / All packages / Full text** (bundle scope default on bundle pages, All on home) · prefix hints `pkg:numpy`, `class:`, `def:` · results grouped Symbols / Guide with kind, name, qualname and a package column on the right (cross-bundle hits show their package) · footer keys. The home input is the same search, list-filtering as you type. This is the slot for PLAN.md cross-bundle search; result rows already carry `pkg ver`.

## Where PLAN.md features land

- **Inline members** — right-rail toggle on class/module pages; `<details>` cards fetched on open (`?inline-members=1` / `#m-<name>`), Expand/Collapse all per group, per-member rail index. Islands are no longer rendered unconditionally.
- **Staging / PR preview** — non-dismissible purple banner in the banner stack (stacks with old-version), "staged" tag in the version menu, staged rows + Promote/Discard in contributor mode, home table staged filter.
- **Diagnostics badge** — `0 errors · N warnings` pill beside the version pill on the overview masthead and the Diagnostics strip, both maintainer-only; unresolved/role/substitution nodes get a dotted underline for readers and the orange/red outline + `data-debug` tooltip only under `data-dev`.
- **Cross-bundle search** — palette "All packages" scope with a package column.
- **Version pins** — "pinned link" banner variant (`pinned to 9.16.0; showing 9.17.1`), and the version menu is present even with one version so the state has a stable home.

## Migration note (viewer/src)

- **Layouts:** `BundleLayout.astro` → grid `var(--rail-w) minmax(0,1fr) var(--toc-w)` with `--header-h`; drop the three CSS-only checkbox toggles; drawer = `<button aria-expanded>` + `html[data-nav-open]`. `BaseLayout` gets the sticky `SiteHeader` with package/version slot + section tabs. Add `id="main"` + skip link.
- **Components:** `SiteHeader.astro` (wordmark, `PackageSwitch` w/ version `<details>` menu, `SectionTabs`, search trigger, theme/contributor toggles, login); `BundleSidebar.astro` → `GuideTree` / `ApiTree` (contextual, uses `nav.ts` ancestors; expansion rule = ancestors + siblings + children; `<button class=twisty>` per branch) + `DeveloperSection` gated on `isAuthenticated || localStorage dev`; `OnThisPage.astro` shared by docs and qualname pages (entries from `doc-page.ts` headings or the qualname view model; inline-members checkbox); `TitleBlock.astro` (kind badge, short h1, qualname + copy, source) replacing `header.qa-header`; `MemberGroups.astro` (tables + `<details>` cards) replacing the `.members-toc` chip wall and unconditional `InlineMemberDoc` islands; `SiblingNav.astro`; `VersionBanner.astro` → `BannerStack` with variants `old | staged | pinned`; overview page renders the docs-index `GeneratedDoc` inline and the versions table from `pkgVersions`; `BundleSearch.tsx` gains scope chips, `/`+`Ctrl+K`, and a package column; home `index.astro` becomes input + table + 3 cards (needs ingest-time counts).
- **View models:** `ir-reader.ts` maps `item_type` metaclass → `class`, `function` under a class → `method`; `qualname-page.ts` groups members (constructor/methods/static/attributes/private) and provides one-line summaries + sibling prev/next; `doc-page.ts` provides the toctree trail and never collapses TOC levels.
- **CSS:** replace `global.css:6-82` with the token set; add `[hidden]`, `button{font:inherit}`, global `:focus-visible`, reduced-motion; `.prose` measure rule `main :is(p,ul,ol,dl,blockquote,h1-h4,.admonition){max-width:var(--measure)}`; move diagnostic outlines in `ir-nodes.css` under `html[data-dev]`; one `.btn`/`.pill`/`.kind-badge` set; delete `.members-toc`, `.raw-json-link`, the sidebar collapse-label rules and the `--color-*` fallbacks.
