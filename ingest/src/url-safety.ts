/**
 * URL scheme allowlist for href/src attributes.
 *
 * IR-derived URLs (`Link.url`, `Image.url`) come from docstrings, so a value
 * like `javascript:alert(1)` or `data:text/html,…` must never reach an `href`
 * or `src`. Relative URLs and fragments (no scheme) are always allowed; any
 * absolute URL must use an allowlisted scheme.
 *
 * This is the single source of truth shared by ingest-time bundle rejection
 * (`assertSafeUrls`) and the viewer's render-time sanitisation. The renderer
 * still applies it defensively: a bundle may reach the renderer without having
 * passed ingest/pack validation (e.g. a re-ingest of older raw bytes), so the
 * render layer cannot assume URLs were already vetted.
 */
const SAFE_URL_SCHEMES = new Set(["http", "https", "mailto"]);

export function isSafeUrl(url: string): boolean {
  // Browsers ignore embedded control chars and whitespace when resolving a
  // scheme (`java\tscript:…` parses as `javascript:`), so drop every char up
  // to and including space (0x20) plus the C1 control range before testing
  // the prefix. Done by codepoint to avoid control-char literals in source.
  let stripped = "";
  for (const ch of url) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x20 && !(code >= 0x7f && code <= 0x9f)) stripped += ch;
  }
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(stripped);
  // No scheme → relative URL or fragment; always safe.
  if (!m) return true;
  return SAFE_URL_SCHEMES.has(m[1]!.toLowerCase());
}
