<!-- Generated 2026-09-04 against commit 8a9661c with IPython 9.17.1 and papyri 0.0.10 ingested. Screenshot references point at the full capture set produced by tools/screenshots.mjs; the subset committed under shots/ is listed in README.md. -->

# papyri viewer — visual design review (design system, typography, components, content skin, brand, a11y)

Scope: visual system only. Layout / IA is covered by a separate review and is only mentioned where it is a typography (measure) or component concern.
Evidence: pre-captured screenshots in `shots/`, plus `shots/agent-design-*.png` captured for this review, computed styles in `agent-design-probe.json`, and WCAG ratios computed by `agent-design-contrast.mjs` (output reproduced below). All paths are relative to `/home/user/papyri/viewer/src/` unless noted.

## Executive summary

**What is good.** The core palette in `styles/global.css:6-82` is a sound, restrained system: 16.7:1 body text, 7.1:1 muted text, 5.2–5.4:1 accent links, all six admonition title/tint pairs pass AA in both themes, the dark palette is a genuine re-tuning rather than an inversion, Shiki dual-theme code and the masked-SVG admonition icons flip cleanly, and the bundle-page chrome (sidebar, search dialog, version switcher) reads as one product. The specimen pages are an excellent tool and most block constructs (lists, deflists, tables, blockquotes, doctests, footnotes) render calmly and correctly.

**The three biggest problems.**
1. **A second, undefined token vocabulary.** `admin.css`, `login.astro`, `settings.astro`, `PasskeyPanel.tsx`, `validate.astro`, `backref-validate.astro`, `[ver]/index.astro`, `project/[pkg]/index.astro` and `diff.astro` reference 34 custom properties (`--color-muted`, `--color-accent`, `--muted`, `--surface-raised`, `--warn-fg`, `--ok-fg`, …) that are defined **nowhere**, so every one of those rules silently runs on its hard-coded light fallback. Result: admin, login, settings and diagnostics pages are half-dark-mode (grey `#666` text at 3.2:1 on `#0f1419`, a second blue `#2563eb`, light-yellow chips on dark surfaces) and the `Sign in` / `Save` buttons are white-on-`#5ea2eb` at 2.7:1 in dark mode.
2. **Inverted heading hierarchy on every content page.** The page title (`header.qa-header h1`, 20.8px / 500) is *smaller and lighter* than the section headings under it (`section.doc-section h2`, 24px / 600). On API pages the same `<h2>` element has three different looks on one page (`SIGNATURE` 15px uppercase muted, `Summary` 24px bold, `ALIASES` uppercase). There is no type scale — 17 distinct font sizes are in use, six of them for monospace alone, and code blocks fall through to the UA default `monospace 13px` because `pre.code` never sets `font-family`.
3. **Maintainer diagnostics leak into the reader's page.** Unresolved cross-references, inline roles, substitutions and unimplemented nodes all render as loud orange/red outlined boxes with `cursor: help` and a debug tooltip (`ir-nodes.css:186-217, 414-421, 535-563`). In a tutorial paragraph (`ipython-doc-tutorial--desktop-light.png`) "Python tutorial" shouts at a reader who cannot do anything about it. This needs a display-mode gate, not a colour tweak.

Secondary themes: identity is split three ways (pilcrow wordmark, a 944 KB hand-drawn `PAPYRI` favicon, a white-silhouette bundle logo that is invisible on light surfaces); buttons/inputs in React islands render in Arial because `font` is not inherited; six border radii and six shadow recipes; the CSS-only sidebar/TOC toggles are `aria-hidden` yet keyboard-focusable (an axe "critical"); and KaTeX CSS is fetched from a CDN at runtime, which in a sandboxed network fails and expands the math specimen page to 6712 px wide.

---

## 1. Design tokens & colour

### Contrast audit (WCAG 2.x, computed)

Light theme, pairs that matter (full table in `agent-design-contrast.mjs` output):

| pair | fg | bg | ratio | AA |
|---|---|---|---|---|
| body fg on bg | #1a1a1a | #fafafa | 16.67 | pass |
| fg-muted on surface (sidebar, lede, crumb, `.ptype`) | #555 | #fff | 7.46 | pass (AAA) |
| accent link on surface | #2b6cb0 | #fff | 5.42 | pass |
| accent on surface-alt (member chips, crumb chips, active sidebar row) | #2b6cb0 | #eee | 4.67 | pass, thin margin |
| visited link (`color-mix` accent 75% / muted) | ≈#366699 | #fff | 5.97 | pass |
| xref-external | #0f766e | #fff | 5.47 | pass |
| white on accent (node pill active, `.lf-submit`, admin buttons) | #fff | #2b6cb0 | 5.42 | pass |
| **border vs surface (non-text 3:1)** | #e2e2e2 | #fff | **1.30** | fail — inputs/buttons rely on border alone |
| note / tip / important / warning / danger title on tint | — | — | 4.90 / 4.68 / 5.10 / 4.84 / 5.91 | pass |
| **neutral admonition title (versionadded etc.)** | #64748b | #f3f4f6 | **4.32** | fail |
| **admin `#888` muted on bg** | #888 | #fafafa | **3.40** | fail |
| **admin success `#16a34a` on bg / on `#f0fdf4`** | | | **3.16 / 3.15** | fail |
| **`.lf-submit:disabled` white on #9bbfe6** | | | **1.91** | fail |
| page-toc level-2/3 (`opacity .75/.7`, 12 px) | ≈#7e7e7e / #878787 | #fafafa | **3.89 / 3.44** | fail |
| `.ds-onward` (11 px italic, opacity .6) | ≈#999 | #fff | **2.85** | fail |

Dark theme:

| pair | fg | bg | ratio | AA |
|---|---|---|---|---|
| body / muted / accent on surface | | | 13.3 / 6.3 / 6.2 | pass |
| **white on accent #5ea2eb (node pill active, `Sign in`, `Save`, `+ Add passkey`)** | #fff | #5ea2eb | **2.68** | fail |
| **admin tab / th / deploy label `#666` on bg** | #666 | #0f1419 | **3.22** | fail |
| **`.login-card-header p` `#666` on surface** | #666 | #1a1f26 | ≈2.9 | fail |
| **`.diag-link-warn` #b05800 on surface** | | | **3.35** | fail |
| **validate `.diag-summary` #b05800 / `.diag-error` #cc0000 on bg** | | | 3.5 / ≈3.8 | fail |
| **admin error #dc2626 on bg** | | | **3.83** | fail |
| border vs surface (non-text) | #2b333c | #1a1f26 | **1.29** | fail |
| page-toc level-2/3 | | | 4.45 / 4.03 | fail |

### Findings

**P1 — 34 custom properties are referenced but never defined; the whole admin/auth/diagnostics surface runs on hard-coded light fallbacks.**
`grep` across `src/` shows `--color-muted` (16 refs), `--color-border` (12), `--muted` (8), `--color-error` (7), `--color-accent` (7), `--color-success` (6), `--color-warn`, `--color-bg`, `--color-surface`, `--surface-raised`, `--warn-fg`, `--ok-fg`, `--error-fg`, `--error`, `--warning-*`, `--text`, `--hover-bg`, `--accent-soft`, `--color-danger`, `--font-mono` — none appear in `styles/global.css:6-82` or anywhere else. Every `var(--color-x, #fallback)` therefore resolves to the fallback in both themes. Evidence: `agent-design-admin--dark.png` (inactive tabs and `TABLE / ROWS` headers in `#666`, `DEBUG` chip on light `#fffbeb`), `agent-design-login--dark.png` (subtitle in `#666`, `Sign in` button white on light blue, dev-credentials box invisible because `.lf-hint` is `rgba(0,0,0,.03)` — `global.css:1729`), `agent-design-settings--dark.png` (three `#5ea2eb` buttons with white text; `Create token` in a *different* blue `#2563eb`), `agent-design-ipython-validate--dark.png` (`#cc0000` summary line), `agent-design-admin-maintenance--dark.png`. Files: `styles/admin.css` (throughout, e.g. lines 19, 26, 37, 78-81, 187, 265, 391), `pages/login.astro:74`, `pages/settings.astro:95,107-109,128-132`, `components/PasskeyPanel.tsx:196-211`, `pages/project/[pkg]/[ver]/validate.astro:177-189`, `backref-validate.astro:110-116`, `pages/project/[pkg]/[ver]/index.astro:109,113`, `pages/project/[pkg]/index.astro:429-430`, `pages/project/[pkg]/diff.astro:226,268-283`, `global.css:1533,1652-1732`.
Recommendation: delete the second vocabulary. Add the missing semantic tokens to `:root` **once** (see token set below: `--ok`, `--ok-bg`, `--warn`, `--warn-bg`, `--danger`, `--danger-bg`, `--accent-fg`, `--surface-raised`), then sed the files: `--color-muted`/`--muted` → `--fg-muted`; `--color-accent` → `--accent`; `--color-border` → `--border`; `--color-bg`/`--color-surface` → `--surface`/`--surface-alt`; `--color-success*` → `--ok*`; `--color-warn*`/`--warning-*`/`--warn-fg` → `--warn*`; `--color-error*`/`--error`/`--error-fg`/`--color-danger` → `--danger*`; `--ok-fg` → `--ok`; `--accent-soft` → `color-mix(in oklab, var(--accent) 12%, transparent)`; `--text` → `--fg`; `--hover-bg` → `--surface-alt`. Remove every fallback value so a future typo fails visibly. Add an ESLint/stylelint check (`stylelint-declaration-strict-value` or a 10-line script in `pnpm lint`) that every `var(--x)` has a definition in `global.css`.

**P1 — White-on-accent fails in dark mode (2.68:1).**
`--accent` is lightened to `#5ea2eb` for dark so *text* links pass, but the same token is reused as a *fill* behind white text: `.node-type-nav-item.active` (`global.css:1500-1504`), `.lf-submit` (`1677-1678`), `.ext-inv-btn`, `.reingest-btn`, `.ext-inv-badge` (`admin.css:265, 507, 391`), `AccountSettingsPanel` buttons. Evidence: `agent-design-settings--dark.png`, `agent-design-ipython-nodes--dark.png` ("All" pill).
Recommendation: introduce `--accent-fill` (light `#2b6cb0`, dark `#2563eb` → white on it = 5.2:1) and `--accent-fg: #fff`, and use them for every filled control; keep `--accent` for text/underline/border only. Alternative for dark: `--accent-fill: #3b82f6` (white 4.6:1) if a lighter fill is wanted.

**P2 — Hard-coded colours bypass the tokens in 11 places (outside `:root`).**
`ir-nodes.css:78-118` (`.exec-status--*` eight hex pairs + dark overrides), `global.css:840` (`#fff` avatar text), `1502, 1514` (`#fff` pill text), `1533` (`#c0392b`), `1659-1672` (`.lf-error #b00020/#fdecea`, `.lf-success #1b5e20/#e8f5e9` — light-only), `1686` (`#9bbfe6`), `1729` (`rgba(0,0,0,.03)`), `diff.astro:268-274` (`#1a7f37/#b42318/#9a6700`), `UserMenu.tsx:94` (`hsl(h 55% 45%)` generated avatar, ok), and the `github-light/github-dark` Shiki themes (`lib/highlight.ts:15-16`) whose backgrounds (`#fff` / `#24292e`) are forced by `!important` (`ir-nodes.css:31-38`) and do not match `--surface` in dark (`#24292e` vs `#1a1f26`) — visible as a slightly different slab in `ipython-doc-tutorial--desktop-dark.png`.
Recommendation: map `.exec-status--*` to `--ok/--ok-bg`, `--danger/--danger-bg`, `--warn/--warn-bg`; map `.lf-error/.lf-success` to the same; for Shiki set `background-color: transparent !important` on `.shiki span` and let `pre.code` own the background, or pick themes whose bg you override (`github-light-default` / `github-dark-default` with `--surface`).

**P2 — Neutral admonition accent fails AA (4.32:1) and neutral tint is indistinguishable from surface.**
`global.css:30-31` `--adm-neutral-accent: #64748b` on `--adm-neutral-bg: #f3f4f6`. In `agent-design-specimen-admonitions--light--full.png` the `versionadded / versionchanged / deprecated` title bars are the only ones that read as "greyed out". Recommendation: `--adm-neutral-accent: #475569` (5.9:1) and `--adm-neutral-bg: #f1f5f9`; dark values are fine.

**P2 — Faded text via `opacity` breaks AA on small type.**
`global.css:541-555` (`.page-toc-level-2/3/4` at `opacity .85/.75/.7` on 12–11 px text), `doc-switcher.css:43-46` (`.ds-caret` opacity .45), `:75-79` (`.ds-onward` 11 px italic opacity .6), `project/[pkg]/index.astro:378-380` (`.link-pill--secondary` opacity .75). Recommendation: express hierarchy with size/indent only and keep colour at `--fg-muted`; if a third tone is wanted, add `--fg-subtle` (light `#6b7280` → 5.0:1 on `#fafafa`; dark `#8b949e` → 5.9:1) and never go below it for text.

**P2 — Borders are the only affordance on inputs/buttons and they sit at 1.3:1.**
`--border: #e2e2e2` / `#2b333c` is fine as a hairline but every control (`.site-login-link`, `.settings-menu-trigger`, `.bundle-search-trigger`, `.raw-json-link`, `.diag-link`, `.lf-input`, `.ds-trigger`) uses it as its sole boundary. WCAG 1.4.11 asks 3:1 for control boundaries. Recommendation: add `--border-strong` (light `#b8bfc7` → 3.0:1 on white; dark `#4b5563` → 3.1:1 on `#1a1f26`) and use it for interactive controls; keep `--border` for dividers, table rules and cards.

**P3 — Dead / redundant tokens.** `--role-bg` (defined `global.css:34,76`, 0 uses — `code.role` uses `--warn-bg`), `--admonition-bg` (identical to `--surface` in both themes, 3 uses), `--error-border`/`--error-bg` vs `--adm-danger-*` and `--warn-border`/`--warn-bg` vs `--adm-warning-*` are the same values under two names. Collapse to one semantic set (below).

**P3 — Shadows are all black and disappear in dark mode.** Six recipes: `0 6px 20px rgb(0 0 0/18%)` (`global.css:777, 860`), `0 8px 40px rgba(0,0,0,.25)` (`1142`), `0 4px 12px rgba(0,0,0,.1)` (`1360`), `0 2px 8px` (`ir-nodes.css:215`), `0 1px 0 + 0 8px 24px -8px` (`doc-switcher.css:91-93`), `0 8px 24px rgba(0,0,0,.06)` (`login.astro:54`, `settings.astro:83`). In `agent-design-settings-menu--dark.png` / `agent-design-version-switcher--dark.png` the popovers have no visible elevation. Recommendation: two tokens, `--shadow-1: 0 1px 2px rgb(0 0 0/.06), 0 4px 12px rgb(0 0 0/.08)` and `--shadow-2: 0 8px 32px rgb(0 0 0/.18)`, with dark values at `.4/.5` alpha and a 1px `--border-strong` on popovers so elevation survives on dark.

---

## 2. Typography

### What is in use (computed, 1440 × 900, light)

| element | family | size | weight | file |
|---|---|---|---|---|
| home / bundle-index / 404 `h1` | sans | 25.6 px | 700 | `global.css:233` |
| `header.qa-header h1` (API **and** narrative page titles) | mono (API) / sans (docs) | **20.8 px** | **500** | `global.css:308-312` |
| `section.doc-section h2` (Summary, Parameters, Members, every doc `h2`) | sans | **24 px** | **600** | `global.css:343` |
| `section h2` (Signature, Aliases, Referenced by) | sans, uppercase | 15.2 px | 700 | `global.css:330` |
| doc `h3` / `h4` / `h5` | sans | 19.2 / 16.3 / 14.4 px | 600 | `353-374` |
| inline-member `h3` / `h4` | sans / sans uppercase | 16 / 14.4 px | 600 | `937, 976` |
| `.kind` eyebrow, `.sidebar-heading`, `.page-toc-label`, `.backref-group h3` | sans uppercase | 12 / 11.2 / 11.2 / 12.8 px | 400 / 700 / 700 / 500 | `301, 1075, 518, 654` |
| body / `dl.params dd` | sans | 16 / 24 px | 400 | `88-96` |
| inline `code` | `--mono` | 16 px (1em) | | `249` |
| `pre.code` (Shiki) | **UA `monospace`** | **13 px** | | `ir-nodes.css:10` — no `font-family`, `highlight.ts:69` strips the `<code>` |
| `.sig-code`, `dl.params dt`, `.pname` | `--mono` | 14.4 px | | `global.css:590, ir-nodes.css:123` |
| member chips `ul.qualnames`, crumb `code` | `--mono` | 13.6 px | | `global.css:277, 256` |
| sidebar docs list / summary | sans | 12.8 px | | `1250, 1055` |
| sidebar API tree / identity version | `--mono` | 12 px | 500 / 400 | `1266, 1048` |
| search trigger, Raw JSON, `.search-hit-module` | `--mono` | 12.8 / 12.8 / 12 px | | `1093, BundleLayout.astro:190, global.css:1202` |
| card count label / admin debug tag / `.ds-group-head` / `.ds-badge` | mono / sans | 10.4 / 9.9 / **9** / **9 px** | | `1471, admin.css:70, doc-switcher.css:113, 163` |
| login / settings / admin inputs & buttons | **Arial** | 14 px | | `LoginForm.tsx`, `PasskeyPanel.tsx`, `AccountSettingsPanel` — `font` not inherited |

That is 17 sizes (9, 9.9, 10.4, 11.2, 12, 12.8, 13, 13.12, 13.6, 14, 14.4, 15.2, 16, 19.2, 20.8, 24, 25.6) and no ratio between them.

**P1 — Page title is smaller than its section headings.**
`header.qa-header h1` is 1.3rem/500 (`global.css:308-312`); it is used for narrative pages too (`docs/[...doc].astro:89-91` renders `<p class="kind">Doc</p><h1>`), where the body `h2`s are 1.5rem/600 (`global.css:343-352`). Evidence: `papyri-doc-specimens--desktop-light.png` — "Block constructs" (21 px) above "Paragraphs" (24 px bold); `ipython-method--desktop-light.png` — the 21 px qualname is visually subordinate to "Summary"/"Parameters". On API pages the mono qualname is also the *longest* line on the page, so weight 500 was chosen to tame it — the fix is to shrink the h2s, not the h1.
Recommendation (see scale below): `h1` 28 px / 650 everywhere (`qa-header h1 code` mono at 24 px / 600 with `overflow-wrap: anywhere`), `h2` 20 px / 600, `h3` 17 px / 600, `h4` 15 px / 600 + `--fg-muted`. Drop `section.doc-section h2`'s border-bottom on API pages (keep it on narrative pages) so the API page reads as one document with labelled blocks rather than a stack of rules.

**P1 — Three visual treatments for `<h2>` on one API page.**
`[...slug].astro:182-186` `section.signature h2` → uppercase 15 px muted; `:191-195` `section.doc-section h2` → 24 px bold; `:244-247` `section.aliases h2` and `:260-261` `section.backrefs h2` → uppercase again. Evidence: `ipython-module-big--desktop-dark.png` shows `Members` (24 px) … `ALIASES` (15 px caps) for headings of equal rank. Recommendation: one rule for `main h2`; if Signature wants to be quieter, make it an eyebrow-labelled block (`<div class="sig-block"><span class="eyebrow">Signature</span>…`), not a heading.

**P2 — Code blocks use the UA font at 13 px; inline code is 16 px.**
`pre.code` (`ir-nodes.css:10-16`) sets no `font-family`/`font-size`; `highlight.ts:69-71` strips Shiki's `<code>` so the `code { font-family: var(--mono) }` rule never applies. Computed: `pre.code` = `monospace 13px` vs inline `code` = `ui-monospace 16px`, `.sig-code` 14.4 px, `.sidebar-qualnames` 12 px. Evidence: probe `light/tutorial pre_code` vs `code_inline`. Recommendation: `pre.code, pre.code-output { font: 400 0.875rem/1.55 var(--mono); }` (14 px) and inline `code { font-size: 0.925em; }` so inline code sits 1–2 px below the surrounding sans x-height instead of above it (inline mono at 1em looks oversize — visible in `agent-design-specimen-inline--light--full.png`, e.g. `papyri gen` chips taller than the line).

**P2 — Mono vs sans is used inconsistently as a semantic signal.**
Mono = "identifier" works well for qualnames, chips, signatures and the API tree. But it is also used for UI text that is not an identifier: the search trigger placeholder "Search 1395 symbols…" (`global.css:1099`), "Raw JSON" (`BundleLayout.astro:193`), "Type to search…" (`1190`), card count labels "API / DOCS" (`1453`), `.ds-*` everything (`doc-switcher.css:6`), `.admin-commit`. Conversely, narrative-page titles and breadcrumb segments "bundles / IPython 9.17.1" are sans while the qualname segments beside them are mono chips (`ipython-method--desktop-light.png` breadcrumb). Recommendation: mono only for identifiers, versions, paths and code; UI labels in sans. Version strings stay mono (good).

**P2 — Measure.** `.bundle-main` has no max-width (`global.css:227-231`), the grid caps at 96 rem. Computed: `dl.params dd` = 1084 px ≈ 135 characters at 1440 (`ipython-method--desktop-light.png`), 1180 px ≈ 148 characters at 1920 (`agent-design-method-1920--light.png`). Narrative pages with the TOC column get 864 px ≈ 108 characters (`ipython-doc-tutorial--desktop-light.png`). Both are over the 60–90 ch comfort band. This is a layout decision (other review), but from the type side the fix is a prose measure token: `.doc-section p, dl.params dd, li, blockquote { max-width: var(--measure, 72ch); }` while letting `pre`, tables, signatures and the Members grid stay full width.

**P3 — Sub-10 px text.** `.ds-group-head` and `.ds-badge` at 9 px with 0.12 em tracking (`doc-switcher.css:113, 163`), `.admin-debug-tag` 9.9 px (`admin.css:71`), `.bundle-card-count-label` 10.4 px. Floor at 11 px (0.6875 rem).

**P3 — `line-height: 1.5` on 24 px headings gives 36 px boxes; set headings to `line-height: 1.25`. Add `text-wrap: balance` on `h1,h2` and `overflow-wrap: anywhere` on `.qa-header h1 code` (long qualnames currently rely on the grid `min-width:0`).**

---

## 3. Component consistency

**P2 — Six border radii, no rule.** 2 px (`code.param-ref`, `code.role`, `.xref.unresolved`, `.ds-opt`), 3 px (`code`, `.sidebar-list li`, `.ds-trigger`, `.ds-panel`, `.exec-status`), 4 px (`.sig`, `pre.code`, all bordered buttons, logos, `.version-banner`), 6 px (`.bundle-index-card`, `.inline-member`, `.node-entry`, `.text-search-hit`, dropdowns, `.empty`, `.lf-*`), 8 px (`.bundle-card`, `.bundle-search-dialog`, `.info-card`, `.package-logo`, `.settings-must-change`), 10 px (`.login-card`, `.settings-card`), 999 px (`.node-type-nav-item`, `.link-pill`, `.ext-inv-badge`). Recommendation: `--radius-sm: 3px` (inline chips, code), `--radius-md: 6px` (controls, inputs, popovers, small cards), `--radius-lg: 10px` (cards, dialogs), `--radius-pill: 999px`. Home bundle cards (8) and bundle-index cards (6) should be the same component with the same radius and hover (currently one lifts with shadow, `global.css:1359-1364`, the other tints, `1308-1311`).

**P2 — "Bordered chip button" exists in five hand-rolled variants.** `.site-login-link` (sans 14 px, padding .3/.75 rem, `global.css:723`), `.settings-menu-trigger` (16 px glyph, padding .25/.5 rem, `745`), `.raw-json-link` (mono 12.8 px muted, padding .1/.5 rem, `BundleLayout.astro:190`), `.diag-link` (sans 13.6 px muted, padding .2/.6 rem, `[ver]/index.astro:96`), `.sidebar-collapse-label` (24 px square, `global.css:406`), plus `.ds-trigger` (mono 12 px, radius 3, `doc-switcher.css:19`) and `.bundle-search-trigger` (input-look). Hover rules also differ (`border-color: currentColor` vs `var(--accent)`). Recommendation: one `.btn` (+ `.btn--ghost`, `.btn--primary`, `.btn--icon`) in `global.css`: `font: 500 0.875rem/1 var(--sans); padding: .375rem .75rem; border: 1px solid var(--border-strong); border-radius: var(--radius-md); background: var(--surface); color: var(--fg);` hover → `border-color: var(--accent); color: var(--accent)`; `--primary` → `background: var(--accent-fill); color: var(--accent-fg); border-color: transparent`.

**P2 — Islands render buttons and inputs in Arial.** `LoginForm.tsx`, `PasskeyPanel.tsx`, `AccountSettingsPanel`, `ReingestPanel`, `ExternalInventoryPanel` inputs/buttons compute to `font-family: Arial` (probe `dark/login lf_input`, `lf_submit`, `dark/admin_inventories ext_inv_btn`) because there is no `button, input, select, textarea { font: inherit; }` reset. Evidence: `login--desktop-light.png` — "Sign in" and the placeholder text are visibly a different face from the labels. One line in `global.css` after the `*` reset.

**P2 — Icons come from three systems and the Unicode ones render inconsistently.** Unicode: `⚙` (`SettingsMenu.tsx:94`), `⌕` (`BundleSearch.tsx:99`), `⬅ ⮕` (`BundleLayout.astro:133-149`), `☰ ×` (`:123-124`), `¶` (`SiteHeader.astro:15`, `login.astro:31`), `✓ ✗ ⚠ ○ ?` (`render-node.ts:78-93`), `↩` (`:379`), `↗` (`ir-nodes.css:226`), `▾ ▸` (`DocSwitcher.tsx:134`, `IRStatsPanel.tsx`), `→ ←` (doc nav, cards). Masked SVG: admonition icons and `a.ext-link::after` (`ir-nodes.css:241-361, 615-629`). Inline SVG: passkey icon (`LoginForm.tsx:128-142`), project link pills. In the screenshots `⬅/⮕` render as heavy black arrows in a 24 px box (`ipython-method--desktop-light.png`, top of sidebar) while `⌕` is a hairline glyph at 16 px — they read as two different weights, and `⬅` (U+2B05) is an emoji-presentation candidate on Android/Windows. Recommendation: one 16 px stroke icon set (Feather/Lucide, already the style of the admonition icons) inlined as `<svg>` sprites or CSS masks with `currentColor`: `settings`, `search`, `panel-left-close/open`, `menu`, `x`, `check`, `alert-triangle`, `circle`, `corner-down-left`, `arrow-up-right`, `chevron-down/right`, `arrow-left/right`.

**P2 — Focus-visible is defined for 4 controls only.** `global.css:760, 821, 892`, `doc-switcher.css:37, 147`. Everything else (all links, the search trigger, `.raw-json-link`, `.site-login-link`, pills, checkbox labels) falls back to the UA ring (`agent-design-focus-sidebar--light.png` shows the Chromium 1 px black auto outline on the `DOCS` heading link — inconsistent with the 2 px accent ring on the cog). Recommendation: a global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }` and remove the per-component copies; add `.sidebar-collapse-cb:focus-visible ~ .sidebar-collapse-label` (and toc/toggle equivalents) so the CSS-only toggles show focus.

**P2 — Hover states are inconsistent across identical patterns.** Sidebar links underline on hover (`global.css:1245`); page-toc links change colour only (`568`); member chips and crumb chips underline the *link* but the visible chip is the inner `code` so the underline sits under a grey box; `.bundle-identity` tints its background; `.bundle-card` lifts 2 px; `.link-pill` tints and recolours. Pick two: text links → underline; boxed links (chips, cards, pills) → `border-color: var(--accent)` + `background: var(--surface-alt)`; never transform.

**P3 — `.sidebar-heading` is sometimes a link, sometimes not.** `BundleSidebar.astro:157-158` wraps "Docs" in `<a>` when an index exists, so it renders in accent blue while "Browse"/"API" are grey (`ipython-method--desktop-light.png`). Keep headings grey; put an "Index" item first in the list instead.

**P3 — Settings menu labels are lowercase sentence fragments** ("dark mode", "hide types", `SettingsMenu.tsx:105-132`) while every other UI label is Title/Sentence case. Use "Dark theme", "Hide type annotations", "Hide private members", "Inline member docs".

**P3 — Spacing rhythm.** Vertical margins mix `0.25/0.35/0.4/0.5/0.55/0.6/0.75/0.85/1/1.25/1.5/2 rem` and pixel values (`12/14/20/28/32 px`) in login/settings. Adopt a 4 px grid: `--space-1: .25rem … --space-6: 2rem`.

---

## 4. Content rendering skin (`ir-nodes.css`)

**P1 — Diagnostic styling is shown to readers.**
Four node states get "warning box" treatment by default: `.xref.unresolved` (`ir-nodes.css:186-196`: `outline: 2px solid var(--warn-border)`, tinted bg, `cursor: help`, hover tooltip `200-217`), `code.role` (`414-421`, same outline), `.substitution` (`535-543`), `span/div.unimplemented` (`545-563`, red). Evidence: `ipython-doc-tutorial--desktop-light.png` ("Python tutorial" orange box mid-sentence), `papyri-func-examples--desktop-light.png` (`int`, `None`, `print`, `os` boxes), `agent-design-specimen-crossrefs--light--full.png` (eight boxes in a list), `ipython-validate--desktop-light.png` (where the box style *is* appropriate). For a reader, an unresolved `:class:` is simply text; the current treatment tells them something is broken that they cannot fix, and the `title`/tooltip exposes internal `RefInfo(module=…, kind=…)` strings.
Recommendation: (a) reader default — `.xref.unresolved { color: inherit; text-decoration: underline dotted var(--fg-subtle); text-underline-offset: 3px; }` and `code.role` → identical to plain `code`; no `cursor: help`, no `title`. (b) A `Diagnostics` toggle in the ⚙ menu that sets `html[data-diagnostics]` and *only then* applies the outlined boxes and the `data-debug` tooltip. Keep two tones under that mode: `broken-local` → `--danger` (build error), cross-package unresolved → `--warn`. This also gives the planned "diagnostics badge" (PLAN.md) a home: the badge count and the outlined boxes are the same mode. Maintainers reviewing bundles keep everything they have today.

**P2 — Blue is used for non-links.** `.pname` (`ir-nodes.css:128-132`), `.sig-annotation/.sig-return` (`global.css:612-615`), `.search-hit-label`, `.bundle-index-card-title` are all `--accent` but not clickable (or clickable as a whole card). In `papyri-func-examples--desktop-light.png` `int`, `float | bool`, `Any` in the signature look like links next to real xrefs. Recommendation: `.pname { color: var(--fg); font-weight: 600 }`; `.sig-annotation, .sig-return, .ptype { color: var(--type, #0f766e / #4fd1c5) }` — or reuse `--sig-keyword` purple for types and italic for `def`; reserve `--accent` + underline-on-hover for things that navigate. (When annotations become xrefs later they get the link style naturally.)

**P2 — Parameters list hierarchy is flat.** `dl.params dt` 14.4 px mono, `dd` 16 px sans indented 1.25 rem (`ir-nodes.css:120-142`). The description is larger than its term, and `optional` / `default` info is only in the italic `.ptype`. Recommendation: `dt` at 15 px with `.pname` 600, `.ptype` in `--fg-muted` after a thin ` : `; `dd` 15 px `--fg` with `margin-left: 1rem` and `max-width: var(--measure)`; add `dl.params > dt + dd { margin-bottom: .6rem }` for rhythm; optionally a 2 px `--border` left rule on `dd` to group multi-paragraph descriptions.

**P2 — Code block / signature / output boxes are three slightly different boxes.** `pre.code` radius 4 padding .75/1 rem; `.sig` radius 4 padding .75/1 rem but `background: var(--surface)` with `.sig-kind-badge` floating above; `pre.code-output` joins with `border-top: none` and radius `0 0 4 4` — good — but has `font-size: .875em` while `pre.code` is 13 px UA (see §2). Unify on one `--radius-md` code surface token (`--code-bg: #f6f8fa` light / `#161b22` dark) distinct from `--surface` so code reads as code on white cards (today `pre.code` on `.inline-member` is white-on-white with only a hairline).

**P2 — KaTeX CSS is a runtime CDN dependency.** `components/Head.astro:38` links `https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css`. In this sandbox the browser fetch fails (`net::ERR_CONNECTION_RESET`) and the unstyled KaTeX markup (`.katex-mathml` + SVG sqrt paths) blows the specimen page out to **6712 px** wide (`agent-design-specimen-tables-and-math--light--full.png`; `document.documentElement.scrollWidth === 6712`, widest element `path` inside `.katex`). Any reader behind a corporate proxy / CSP / offline gets the same. `katex` is already in `node_modules`; recommend `import "katex/dist/katex.min.css"` in `BaseLayout`/`BundleLayout` so Astro bundles it, and `div.math { overflow-x: auto; max-width: 100% }` is already there but should also apply to `span.math` containers (`.katex-display { overflow: auto hidden }`). I could not verify dark-mode KaTeX rendering for this reason; `ir-nodes.css:398-409` `color: inherit` looks correct.

**P3 — Rubric renders as a headless admonition.** `aside.admonition-rubric` (`ir-nodes.css:316-319`) gets a note title bar and no body — in `agent-design-specimen-admonitions--light--full.png` "Further reading" is a lone blue bar. Render `rubric` as `<p class="rubric">` styled like an `h4`.

**P3 — Tables.** `table.ir-table` is solid: hairline grid, header on `--surface`, 0.025 stripe. Two nits: `font-size: .95em` on top of 16 px body gives 15.2 px, another size — use 15 px (`.9375rem`); header row needs `border-bottom: 2px solid var(--border-strong)` to separate from body.

**P3 — Figures.** `figure.fig img` white surface + border (`ir-nodes.css:571-577`) is right for matplotlib PNGs on dark (`papyri-example--desktop-dark.png`), but the border radius 4 clips nothing; add `padding: .25rem` so the plot's own white doesn't touch the border, and a `<figcaption>` slot.

**P3 — External xref**: teal + dashed + `↗` (`ir-nodes.css:221-231`) while `a.ext-link` uses the masked external-link icon (`615-629`). Two "leaves the site" icons; use the mask for both.

---

## 5. Brand / identity

**P2 — Three identities.** Header wordmark `¶ papyri` (`SiteHeader.astro:15`, `global.css:690-711`, pilcrow in accent); login card mark `¶` at 32 px (`login.astro:31, 61-67`); favicon `public/favicon.png` = a 2048 × 2048, **944 KB** hand-lettered "PAPYRI" with pyramid/palm illustration (`Head.astro:36`) that is unreadable at 16/32 px and shares nothing with the pilcrow; the papyri bundle's own logo (`assets/papyri-logo 2.png`, per `viewer/TODO.md`) is a white silhouette. Recommendation: commit to the pilcrow. Ship `public/favicon.svg` (pilcrow, `--accent` on a 6 px-radius white/`#1a1f26` square with `prefers-color-scheme` media inside the SVG) plus a 32 px and 180 px PNG; drop the 944 KB file. Use the same mark on the login card. Set `<meta name="theme-color">` to `#fafafa`/`#0f1419`.

**P2 — Bundle logos on unpadded surfaces (TODO.md item).** `.bundle-logo` / `.bundle-card-logo` (`global.css:1014-1020, 1372-1378`) draw the PNG directly on `--surface`. Evidence: `home--desktop-light.png` — the papyri card logo is a faint smear; `papyri-doc-specimens--desktop-light.png` sidebar; in dark the IPython logo shows a white rectangle. Recommendation: wrap in `.logo-frame { background: var(--surface-alt); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 3px; }` with `img { mix-blend-mode: normal }`; for known-light logos let the bundle manifest say `logo_bg: dark|light|auto` later, but the neutral frame alone fixes both current cases.

**P2 — Empty / error states are inconsistent.** `/project/nope/1.0/` renders a full bundle shell with a `NO` monogram, "nope 1.0", empty Browse/API sections and two diagnostics buttons (`404--desktop-light.png`) instead of `pages/404.astro`; the actual 404 page (`p.crumb` + `h1` + `p.lede`) and the home empty state (`.empty` dashed box, `global.css:242-247`, `index.astro:37-42`) are two more styles; text-search with no query shows just an input (`ipython-text-search--desktop-light.png`); `.nodes-error` uses an undefined `--color-danger`. Recommendation: one `EmptyState.astro` (icon, title 17 px/600, one-line muted body, optional action button) used for 404, no-bundles, no-results, no-images, no-tokens, no-passkeys.

**P3 — Login and settings cards** (`radius 10, shadow .06, 32 px padding, Arial controls`) are visually a different product from the docs chrome (`radius 4/6, no shadow, system font`). Fold them into the card + `.btn` tokens above; the pilcrow mark and centered heading are fine.

---

## 6. Accessibility

No axe-core is installed in the sandbox; the checks below are manual/scripted (`agent-design-probe.json → a11y, tabStops`).

**P1 — `aria-hidden` inputs are keyboard-focusable (axe: `aria-hidden-focus`, critical).** `layouts/BundleLayout.astro:115-119` — the three CSS-only toggle checkboxes carry `aria-hidden="true"` but are not `tabindex="-1"` and not `display:none`; they are tab stops 3, 4, 5 on every bundle page (probe `tabStops`), invisible (`opacity:0`, 1 px, `global.css:143-152`), and hidden from the accessibility tree, so a screen-reader user lands on nothing three times and a sighted keyboard user sees focus vanish. Their `<label>`s are not focusable, so the collapse affordances are unreachable *by name*. Fix: remove `aria-hidden`; keep the visually-hidden class; give the inputs `aria-label="Collapse navigation sidebar"` (move it from the label); add `.sidebar-collapse-cb:focus-visible ~ .sidebar-collapse-label { outline: 2px solid var(--accent) }`; and `aria-controls="bundle-sidebar"` + `aria-expanded` cannot be expressed on a checkbox, so document that the label text swaps (`Collapse` / `Expand`) or move to a 20-line `<button aria-expanded>` island.

**P2 — Heading order.** Sidebar section headings are `<h3>` (`BundleSidebar.astro:157, 186, 201, 214, 225`) and precede the page `<h1>` in DOM order on every bundle page: `h3 Docs, h3 Browse, h3 API, h1 …` (probe `a11y.*.hs`). Inline member cards nest `h3 → h4` under the `h2 Members`, which is fine, but their `<h3>` accessible name is `"ask_yes_nofunction"` (kind badge concatenated without a separator). Fix: sidebar headings → `<p class="sidebar-heading" id="nav-docs">` with `<nav aria-labelledby="nav-docs">`; badge → `<span class="inline-member-kind" aria-hidden="true">` or prefix with a space/`·`.

**P2 — Landmarks.** Bundle pages expose 3–4 unlabeled `<nav>` (`BundleSidebar.astro:156, 185, 200, 213, 224`) plus the sidebar `<aside aria-label="Bundle navigation">`; the search dialog's `ul[role=listbox]` is always in the DOM; on the class page there are ~100 `role="group" aria-label="Function signature"` (`Signature.astro:23`) which is noisy but harmless. `<main>` exists on all pages (good); no skip link. Fix: `aria-labelledby` on each `<nav>`; add `<a class="skip-link" href="#main">Skip to content</a>` before the header; drop `role="group"` inside inline member cards.

**P2 — Colour-only signalling.** Exec status badges rely on colour + a single glyph (`✓/✗/⚠`) with `aria-label` (good) but the glyphs are 12 px; the version switcher current item is accent tint only; `.node-type-nav-item.debug` dashed border only; sidebar `is-ancestor` is weight 500 vs 400. Add text or shape: `aria-current="page"` on the active switcher option, a `(debug)` suffix on debug pills, and `font-weight: 600` + left rule for ancestors.

**P2 — No `prefers-reduced-motion` rule** (probe `reducedMotionRules: 0`). Motion is small (`.bundle-card:hover transform`, `.ds-caret` rotate, 0.1–0.2 s colour transitions) so this is P2: add `@media (prefers-reduced-motion: reduce) { *, ::before, ::after { transition-duration: 0s !important; animation: none !important; } .bundle-card:hover { transform: none } }`.

**P3 — Tooltip via `::after` + `title`** on unresolved xrefs is mouse-only and the span is not focusable; under the diagnostics mode proposed above make the span `tabindex="0"` with `aria-describedby` to a visually-hidden element, or drop the tooltip in favour of the validate page.

**P3 — `dialog::backdrop` at `rgba(0,0,0,.35)`** is barely visible on the dark theme (`agent-design-search-dialog--dark.png`); use `rgb(0 0 0 / .55)` in dark.

---

## Proposed token set

Replace `global.css:6-82` and every ad-hoc `--color-*` with this. Values were chosen to keep the current look and pass the ratios noted.

| token | light | dark | notes |
|---|---|---|---|
| `--bg` | `#fafafa` | `#0f1419` | page |
| `--surface` | `#ffffff` | `#1a1f26` | sidebar, cards, header |
| `--surface-alt` | `#eeeeee` | `#242b33` | chips, hover rows |
| `--surface-raised` | `#ffffff` | `#20262e` | popovers, dialogs (was undefined) |
| `--code-bg` | `#f6f8fa` | `#161b22` | `pre.code`, `.sig`, output |
| `--fg` | `#1a1a1a` | `#e6e6e6` | 16.7 / 14.8 |
| `--fg-muted` | `#555555` | `#9aa0a6` | 7.5 / 6.3 on surface |
| `--fg-subtle` | `#6b7280` | `#8b949e` | 5.0 / 5.9 — the *floor* for text; replaces every `opacity` fade |
| `--border` | `#e2e2e2` | `#2b333c` | dividers, table rules |
| `--border-strong` | `#b8bfc7` | `#4b5563` | 3:1 control boundaries |
| `--accent` | `#2b6cb0` | `#5ea2eb` | text links, underlines, focus ring |
| `--accent-fill` | `#2b6cb0` | `#2563eb` | filled buttons / active pills (white text 5.4 / 5.2) |
| `--accent-fg` | `#ffffff` | `#ffffff` | text on `--accent-fill` |
| `--accent-soft` | `color-mix(in oklab, var(--accent) 12%, transparent)` | same | selected rows, `.ds-opt--current`, param highlight |
| `--link-visited` | `#366699` | `#6da2da` | replaces the `color-mix` at `global.css:114` |
| `--xref-external` | `#0f766e` | `#4fd1c5` | keep |
| `--type` | `#6b46c1` | `#b794f4` | annotations, `def`, `.ptype` (was `--sig-keyword`) |
| `--ok` / `--ok-bg` | `#15803d` / `#eefaf1` | `#4ade80` / `#0f2418` | exec success, admin success, validate ok (replaces `#16a34a`, `#2d7a2d`, `#276749`, `#1b5e20`) |
| `--warn` / `--warn-bg` | `#b45309` / `#fffbeb` | `#fbbf24` / `#2a1f00` | unresolved (diag mode), version banner, debug tag, `--warn-fg`/`#b05800` |
| `--danger` / `--danger-bg` | `#b91c1c` / `#fef2f2` | `#f87171` / `#2d0f0f` | broken-local, errors, `Drop`/`Clear` buttons, `.lf-error`, `#cc0000`, `#dc2626`, `#b00020`, `#c0392b` |
| `--info` / `--info-bg` | `#2b6cb0` / `#eef4fb` | `#5ea2eb` / `#15212e` | note admonition (alias of accent) |
| `--adm-neutral` / `--adm-neutral-bg` | `#475569` / `#f1f5f9` | `#94a3b8` / `#1c2128` | fixes 4.32:1 |
| `--adm-important` / `-bg` | `#7c3aed` / `#f5f0fe` | `#b794f4` / `#1f1830` | keep |
| `--table-stripe` | `rgb(0 0 0 / .025)` | `rgb(255 255 255 / .03)` | keep |
| `--shadow-1` | `0 1px 2px rgb(0 0 0/.06), 0 4px 12px rgb(0 0 0/.08)` | `0 1px 2px rgb(0 0 0/.4), 0 4px 12px rgb(0 0 0/.4)` | cards hover, popovers (+ `--border-strong`) |
| `--shadow-2` | `0 8px 32px rgb(0 0 0/.18)` | `0 8px 32px rgb(0 0 0/.55)` | dialog |
| `--radius-sm/md/lg/pill` | `3px / 6px / 10px / 999px` | same | |
| `--space-1…6` | `.25 / .5 / .75 / 1 / 1.5 / 2 rem` | same | |
| `--measure` | `72ch` | same | prose max-width |
| `--sans` / `--mono` | as today | | add `font-feature-settings: "calt" 0` on `--mono` to stop ligatures in signatures |

Delete: `--role-bg`, `--admonition-bg`, `--warn-border`, `--error-border`, `--error-bg`, `--math-error-*` (→ `--danger`), `--sig-keyword` (→ `--type`), `--adm-note-*`, `--adm-tip-*`, `--adm-warning-*`, `--adm-danger-*` (→ the semantic pairs above; admonitions map `note→info, tip→ok, warning→warn, danger→danger`).

## Proposed type scale

Base 16 px, ratio ≈ 1.2, four mono sizes.

| step | size | weight / lh | used for |
|---|---|---|---|
| `--text-xs` | 11 px (0.6875 rem) | 700 / 1.3, uppercase, `.06em` | eyebrows: `.kind`, `.sidebar-heading`, `.page-toc-label`, card count labels, `.ds-group-head`, debug tag |
| `--text-sm` | 13 px (0.8125 rem) | 400 / 1.45 | sidebar lists, page TOC, crumbs, meta lines, card summaries, buttons (500), search results |
| `--text-base` | 16 px (1 rem) | 400 / 1.55 | body, `dl.params dd`, admonition body, table cells (15 px allowed in tables) |
| `--text-md` | 17 px (1.0625 rem) | 600 / 1.3 | `h4`, inline-member card title, empty-state title |
| `--text-lg` | 20 px (1.25 rem) | 600 / 1.25 | `h3` (docs), `h2` on API pages (Summary, Parameters, Members, Signature, Aliases, Referenced by — one style) |
| `--text-xl` | 24 px (1.5 rem) | 600 / 1.2 | `h2` on narrative pages |
| `--text-2xl` | 28 px (1.75 rem) | 650 / 1.15 | `h1` everywhere (`.qa-header h1 code` → 24 px / 600 mono, `overflow-wrap: anywhere`) |
| `--mono-xs` | 12 px | 400 / 1.5 | sidebar API tree, `.ds-*`, version strings |
| `--mono-sm` | 13 px | 400 / 1.5 | chips (`ul.qualnames code`, crumb code), `.search-hit-module`, backref pkg |
| `--mono-base` | 14 px | 400 / 1.55 | `pre.code`, `pre.code-output`, `.sig-code`, `dl.params dt`, deflist terms |
| inline `code` | `0.925em` of context | | so inline code never exceeds surrounding x-height |

Heading rules once: `h1,h2,h3,h4 { line-height: 1.25; text-wrap: balance; margin: 1.5em 0 .5em }`; `h2` gets a `border-bottom` only inside `.doc-section` on narrative pages.

---

## Quick wins (each < 1 h)

1. Add `button, input, select, textarea { font: inherit; color: inherit }` to the `global.css` reset — fixes Arial in login/settings/admin.
2. `pre.code, pre.code-output { font: 400 .875rem/1.55 var(--mono) }` — fixes UA-monospace-13px code blocks.
3. Swap `header.qa-header h1` to `1.75rem/600` (mono `1.5rem` inside `code`) and `section.doc-section h2` to `1.25rem` on API pages — fixes inverted hierarchy.
4. Define the missing tokens (`--ok*`, `--warn*`, `--danger*`, `--accent-fill`, `--accent-fg`, `--surface-raised`, `--border-strong`, `--fg-subtle`) in `:root` + dark, then `sed` the 34 undefined names to them and delete every `var(--x, #fallback)` fallback.
5. `--accent-fill` on `.node-type-nav-item.active`, `.lf-submit`, `.ext-inv-btn`, `.reingest-btn`, `.ext-inv-badge` — fixes white-on-`#5ea2eb`.
6. Remove `aria-hidden="true"` from the three toggle inputs in `BundleLayout.astro:115-119`; add `.sidebar-collapse-cb:focus-visible ~ .sidebar-collapse-label, .toc-collapse-cb:focus-visible ~ .toc-collapse-label, .sidebar-toggle-cb:focus-visible ~ .sidebar-toggle-label { outline: 2px solid var(--accent); outline-offset: 2px }`.
7. Global `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`; delete the four per-component copies.
8. `@media (prefers-reduced-motion: reduce)` block (5 lines).
9. Gate `.xref.unresolved`, `code.role`, `.substitution`, `.unimplemented` boxes + tooltip behind `html[data-diagnostics]`; default them to `text-decoration: underline dotted var(--fg-subtle)`; add a "Diagnostics" checkbox to `SettingsMenu.tsx` (same pattern as `hideTypes`).
10. `.pname { color: var(--fg); font-weight: 600 }`, `.sig-annotation, .sig-return, .ptype { color: var(--type) }` — stops non-links looking like links.
11. `--adm-neutral-accent: #475569; --adm-neutral-bg: #f1f5f9` (light).
12. Replace `opacity` on `.page-toc-level-*`, `.ds-onward`, `.ds-caret`, `.link-pill--secondary` with `color: var(--fg-subtle)`.
13. `import "katex/dist/katex.min.css"` in the layouts instead of the jsdelivr `<link>` (`Head.astro:38`); add `.katex-display { overflow: auto hidden }`.
14. Replace `public/favicon.png` (944 KB, 2048²) with an SVG pilcrow mark + 32 px PNG; add `<meta name="theme-color">`.
15. Wrap `.bundle-logo` / `.bundle-card-logo` in a `.logo-frame` with `background: var(--surface-alt); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 3px` — closes the TODO.md logo item for both current bundles.

