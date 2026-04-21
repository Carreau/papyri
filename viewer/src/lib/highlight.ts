// Server-side syntax highlighting for Code IR nodes.
//
// Shiki produces fully self-contained HTML with inline `style="color: …"`
// spans, so the output can be embedded directly into the page without any
// client-side JS. We cache a single highlighter instance per process (the
// Astro build is one process) to avoid re-loading grammars per page.
//
// The IR `Code` node carries no language discriminator today (see
// papyri/nodes.py:228), so `python` is the hard-coded default. If/when the
// IR grows a language tag, the second argument to `highlight` is the only
// thing that needs to change.

import { createHighlighter, type Highlighter } from "shiki";

const THEME = "github-light";
const DEFAULT_LANG = "python";
// Keep this list tight; Shiki loads grammars eagerly when the highlighter is
// created. Adding rarely-used languages is cheap but not free.
const LANGS = ["python", "text", "console"] as const;
type Lang = (typeof LANGS)[number] | string;

let _highlighter: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (_highlighter === null) {
    _highlighter = createHighlighter({
      themes: [THEME],
      langs: [...LANGS],
    });
  }
  return _highlighter;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Highlight `code` as `lang` (defaults to python). Returns HTML that is
 * intended to be used as the innerHTML of a `<pre class="code">` — the
 * returned string is the body only, not the surrounding `<pre>`.
 *
 * On any failure (unknown language, highlighter init error) we fall back to
 * an escaped `<code>` block so the page still renders.
 */
export async function highlight(code: string, lang: Lang = DEFAULT_LANG): Promise<string> {
  let hl: Highlighter;
  try {
    hl = await getHighlighter();
  } catch {
    return `<code>${escapeHtml(code)}</code>`;
  }
  const loaded = hl.getLoadedLanguages();
  const effective: string = loaded.includes(lang) ? lang : DEFAULT_LANG;
  try {
    // `codeToHtml` wraps in its own `<pre class="shiki ..."><code>…</code></pre>`.
    // We want only the inner `<code>…</code>` so the outer `<pre class="code">`
    // wrapper from IrNode keeps styling control. `codeToHast` would be cleaner
    // but requires an extra serializer dep; string-splicing the result is fine.
    const full = hl.codeToHtml(code, { lang: effective, theme: THEME });
    const m = full.match(/<code[^>]*>([\s\S]*?)<\/code>/);
    if (m) return m[1];
    return full;
  } catch {
    return `<code>${escapeHtml(code)}</code>`;
  }
}
