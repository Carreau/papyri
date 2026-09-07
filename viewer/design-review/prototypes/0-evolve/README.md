# Direction 0 — Evolve

Keep today's shell (`.bundle-layout` grid, `aside.bundle-sidebar`, `header.site-header`, `main.bundle-main`,
the IR-node class hooks) and apply the shared token set, the type scale and **every quick win from both
reviews**. The `<style>` block in each page is a candidate drop-in for `global.css` + `ir-nodes.css`
(same section order, same selectors); the markup is the live server's, extracted with Playwright and
edited only where a quick win needs it (list below).

**Optimises for:** lowest migration risk — one CSS file swap plus ~10 template edits; every class name
survives; reviewers can diff against `global.css`. **Costs:** the global 180-row API tree, the
one-column card home and the per-route sidebar stay; the class page still needs the summaries that only
the inline-member islands fetch today; nothing here gives rustdoc-style "siblings + members" orientation.

Files: `class.html`, `function.html`, `doc.html`, `overview.html`, `home.html`, and `evolve.css`
(the stylesheet shared by all five pages, section-for-section aligned with `global.css` + `ir-nodes.css`).
The extractor, build script and per-width screenshots were produced during the review and are not committed.
No horizontal overflow at any width (measured); prose 733 px ≈ 72ch; h1 28 px > h2 20/24 px.

## Page anatomy (main column, top → bottom; `[TOC]` = right column ≥ 80em, `<details>` under the h1 below)

- **Overview** — crumb · masthead (logo-frame, name, version pill "v9.17.1 LATEST", summary, PyPI/GitHub/upstream/licence pills) · jump row (Guide · API reference · Most referenced) · **docs index body inlined** · Versions `<details>` · *(contributor)* diagnostics strip.
- **Class / module** — trail · title block (`kind` = class, short `<h1><code>`, qualname line + copy, source) · **Summary** · Signature (h2 kept for AT, visually hidden) · Members *(count)* → Methods table (name · kind · first sentence, public first) → `Private (18)` folded → inline cards when enabled · See also / Aliases / Referenced by. `[TOC]` Summary · Signature · Members → Methods/Private · Aliases.
- **Function / method** — trail · title block (`kind` = method) · Signature · Summary · Parameters · Returns · Aliases · ‹ previous / next › member. No TOC (< 4 sections).
- **Narrative** — trail from the toctree (`IPython 9.17.1 › Tutorial › Introducing IPython`) · h1 only (path chip + Raw JSON are contributor-only) · sections at `--measure` with code/tables full width · Previous/Next cards. `[TOC]` all h2 + h3, highlight-only, "Next →" line.
- **Home** — product statement h1 · lede with `/` hint · filter input · sort/meta row · card grid (monogram in `.logo-frame`, one muted counts line, "versions →").

**Sidebar** — identity → version pill (always, carries latest/older/staged) → *(contributor)* warnings badge → summary → search trigger → **contextual**: API expanded on API pages (tree, no inner scroll, active row centred on load, Docs folded to top-level entries); Docs expanded on doc/overview pages (API folded) → **Developer** disclosure only under `html[data-dev]` (Raw JSON, nodes, math, code, images, ref diagnostics, IR stats). Headings are `<p>`/`<summary>` with `nav[aria-labelledby]`; collapse state persisted.

**Responsive** — `< 40em` fixed overlay drawer with the close control pinned; `40–64em` 15 rem rail; `64–80em` 17 rem, TOC becomes `<details>`; `≥ 80em` 19 rem + 15 rem TOC; cap 96 rem, header full-bleed. Members rows fold to two lines `< 48em`; `ul.qualnames` one column `< 40em`.

**Search** — one palette (header trigger, sidebar trigger, `/`, Ctrl/⌘ K) with scope tabs *Symbols · this bundle / Text · this bundle / Packages · all*; `numpy:` prefix reserved for cross-package scoping. Static mock; arrow keys + Enter work.

**PLAN.md features** — *inline members*: `<details class="inline-member">` per member, Expand/Collapse all, `↓` anchors in the table, fetched on open (island gated on the flag); *staging banner*: `VersionBanner` slot above `<main>` kept, plus a `.version-pill-tag--staged` variant; *diagnostics badge*: `.diag-badge` in the identity block + overview strip (contributor-only); *cross-bundle search*: Packages tab / `pkg:` prefix; *version pins*: version-pill states; the inline "pinned to X, showing Y" xref style is **not** designed here.

## Finding → fix in this prototype

| P1 | Resolved | How / what remains |
|---|---|---|
| D: 34 undefined tokens, second vocabulary | **Full** for the pages here | one `:root` set; admin/login/settings not prototyped — needs the `sed` pass |
| D: white-on-`#5ea2eb` in dark | Full | `--accent-fill` on scope pills, skip link, `.btn--primary` |
| D: h1 smaller than h2; three h2 looks | Full | 28/20/24 scale, one `main h2` rule; Signature h2 hidden visually |
| D: diagnostics shown to readers | Full | dotted underline by default; boxes + tooltip only under `data-dev` |
| D: `aria-hidden` focusable toggles | Full | attribute removed, `aria-label` on inputs, focus ring on labels |
| L IA-1 / SB-3: developer nav, Raw JSON, Browse | Full | Developer disclosure + `.dev-only`, rendered only in contributor mode |
| L §2.3: empty overview | **Partial** | docs index inlined, jump row, versions; "API reference" still lands on the root module; "Most referenced" is a mock |
| L §2.3: diagnostics only content | Full | contributor-only strip + badge |
| L §2.4/2.5: summary after members | Full | Summary first on class page (module page uses the same template) |
| L §2.5: flat member wall | **Partial** | public-first table with summaries + folded private; methods vs attributes/properties not separable — IR `item_type` is `function` for all 98 |
| L §2.5: islands always fetched | Partial | `<details>` cards shown for 6 members; gating the fetch is a template change, not CSS |
| L SB-1: nested scroll hides active | Full (a, b) | inner `max-height` gone, active row centred; (c) sibling collapse **not** done — tree is still 180 rows |
| L SB-2: sidebar order | Full | contextual order + folds |
| L RG-1: no measure | Full | `--measure` on prose; code/tables/signature/members full width |
| L RG-2: mobile horizontal scroll | Full | `overflow-wrap: anywhere` + `<wbr>` in qualnames; 0 overflow at 390 |
| L NA-1: three searches, no shortcut, no skip link | **Partial** | shortcuts, skip link, `id="main"`, scope tabs — Text/Packages results need a new island + API |

## Markup changes required (everything else is `evolve.css`)

| Change | File |
|---|---|
| Skip link, `id="main"`, `data-page`, drop `aria-hidden` + add `aria-label` on toggles, SVG chevrons, Raw JSON moved to sidebar Developer, `hasToc` for qualname pages | `viewer/src/layouts/BundleLayout.astro` |
| Header search trigger, theme + contributor toggles; settings menu gains "Contributor mode" / "Diagnostics overlay", Title-case labels | `components/SiteHeader.astro`, `components/SettingsMenu.tsx` |
| `<p class="sidebar-heading">` / `<details class="sidebar-fold">`, `aria-labelledby`, contextual order, Developer section, `.logo-frame`, version pill always rendered, drop Browse and the Tutorials heuristic | `components/BundleSidebar.astro`, `components/DocSwitcher.tsx`, `lib/nav.ts` |
| Summary before Signature/Members; short `<h1>` + `.qualname` line with copy; kind mapping (METAHASTRAITS→class, FUNCTION→method when qualname has `.` after `:`); public-first members list with `.member-kind` + `.member-summary`; `<details class="members-private">`; inline cards as `<details class="inline-member">` fetched on open; page-toc slot; sibling nav | `pages/project/[pkg]/[ver]/[...slug].astro`, `components/InlineMemberDoc.astro`, `lib/ir-reader.ts` (kind), `lib/qualname-page.ts` (summary per member) |
| Trail crumb from toc ancestors; drop kind label + path chip (contributor-only); remove top prev/next; prev/next as cards with `.doc-page-nav-dir`; scroll-spy highlight-only; `<details class="page-toc-inline">` | `pages/project/[pkg]/[ver]/docs/[...doc].astro`, `lib/doc-page.ts` |
| Masthead, jump row, docs index rendered inline, Versions `<details>`, diagnostics strip `.dev-only` | `pages/project/[pkg]/[ver]/index.astro` |
| h1 statement, one counts line, `.logo-frame`, meta row | `pages/index.astro`, `components/BundleCard.astro` |
| `/` and Ctrl/⌘ K, scope tabs, footer hints | `components/BundleSearch.tsx` |
| Returns rendered as a section (gen-side numpydoc bug, flagged in layout review §2.6) | `papyri/` gen, not viewer |

Migration order: land `evolve.css` as `global.css` + `ir-nodes.css` (pure CSS, no template change needed
beyond the `data-page` attribute — without it narrative h2s fall back to 20 px), then the
`BundleLayout`/`SiteHeader`/`BundleSidebar` edits, then the page templates one route at a time.
