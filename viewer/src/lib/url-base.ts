/**
 * URL base prefix for the current request (or page, in the browser).
 *
 * Normally "" — the viewer serves its routes from the site root. Inside a PR
 * preview every route is served under `/preview/<owner>/<repo>/<pr>`, and
 * every link and client-side fetch must carry that prefix.
 *
 * Rather than thread the prefix through ~85 `linkFor*` call sites, the prefix
 * is read here, once, at the point where a URL is built (`links.ts`):
 *
 *   - **Server**: the middleware wraps the request in an `AsyncLocalStorage`
 *     store (see `request-context.ts`) and publishes it on `globalThis`. This
 *     module reads it without importing `node:async_hooks`, so it stays safe
 *     to bundle for the browser.
 *   - **Browser**: `BaseLayout` emits `<meta name="papyri-url-base">` and
 *     hydrated islands read it, so a client-rendered link or `fetch()` lands
 *     in the same namespace the page was served from.
 *
 * This module has NO Node.js imports; it is used from React islands.
 */

/** Shape published on `globalThis` by `request-context.ts` (server only). */
interface RequestContextHolder {
  getStore(): { base: string } | undefined;
}

const GLOBAL_KEY = "__papyriRequestContext";

/** Name of the `<meta>` tag carrying the base into hydrated islands. */
export const URL_BASE_META = "papyri-url-base";

let clientBase: string | null = null;

/**
 * Current URL prefix, without a trailing slash ("" outside a preview).
 *
 * Every path returned by `links.ts` is prefixed with this.
 */
export function urlBase(): string {
  if (typeof document !== "undefined") {
    if (clientBase === null) {
      const meta = document.querySelector(`meta[name="${URL_BASE_META}"]`);
      clientBase = meta?.getAttribute("content") ?? "";
    }
    return clientBase;
  }
  const holder = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as
    | RequestContextHolder
    | undefined;
  return holder?.getStore()?.base ?? "";
}

/** Prefix an absolute, root-relative viewer path with the current base. */
export function withBase<T extends string>(path: T): `${string}${T}` {
  return `${urlBase()}${path}` as `${string}${T}`;
}
