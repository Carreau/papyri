/**
 * Per-request context (server only).
 *
 * Carries the active PR preview — if any — through the whole render of one
 * request, so that:
 *
 *   - `getBackends()` opens the preview's own SQLite + blob directory instead
 *     of the main store, without every page having to pass it down, and
 *   - `links.ts` prefixes every URL it builds with the preview's base path
 *     (see `url-base.ts`).
 *
 * The store is published on `globalThis` so `url-base.ts` — which is also
 * bundled for the browser — can read it without importing `node:async_hooks`.
 *
 * The middleware buffers the response body inside `runInRequestContext` so the
 * store is guaranteed to still be active while Astro renders, even if the
 * platform would otherwise pull the body after the middleware returned.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { previewBase, type PreviewRef } from "./preview.ts";

export interface RequestContext {
  /** Preview namespace this request is served from, null for the main store. */
  preview: PreviewRef | null;
  /** URL prefix for every link on the page ("" for the main store). */
  base: string;
}

const GLOBAL_KEY = "__papyriRequestContext";

// One AsyncLocalStorage per process, reused across hot reloads in dev.
const storage: AsyncLocalStorage<RequestContext> = (() => {
  const existing = (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  if (existing) return existing as AsyncLocalStorage<RequestContext>;
  const created = new AsyncLocalStorage<RequestContext>();
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = created;
  return created;
})();

/** Run `fn` with `ctx` as the active request context. */
export function runInRequestContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** Context of the in-flight request, or null outside one. */
export function currentRequestContext(): RequestContext | null {
  return storage.getStore() ?? null;
}

/** Preview namespace of the in-flight request, or null on the main store. */
export function currentPreview(): PreviewRef | null {
  return storage.getStore()?.preview ?? null;
}

/** Build the context for a preview request. */
export function previewContext(preview: PreviewRef): RequestContext {
  return { preview, base: previewBase(preview) };
}
