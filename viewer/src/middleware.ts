import { defineMiddleware } from "astro:middleware";
import { initStore } from "./lib/storage.ts";
import { initGraph } from "./lib/graph.ts";

// Initialise the storage + graph singletons on every request (idempotent after
// the first call because both singletons are module-level). The `import.meta.env.DEV`
// guard ensures better-sqlite3 (a native Node.js addon) and the local filesystem
// modules are never bundled into the Cloudflare production build.
export const onRequest = defineMiddleware(async (context, next) => {
  // Access the Cloudflare runtime env. In local dev (pnpm dev), runtime is
  // undefined and we fall back to the filesystem / better-sqlite3 path.
  const runtime = (context.locals as unknown as { runtime?: { env?: Record<string, unknown> } })
    .runtime;

  if (runtime?.env?.["BUNDLE_STORE"]) {
    // Cloudflare production: use R2 + D1.
    const { R2Store } = await import("./lib/storage-r2.ts");
    initStore(new R2Store(runtime.env["BUNDLE_STORE"] as ConstructorParameters<typeof R2Store>[0]));
    const { D1Graph } = await import("./lib/graph-d1.ts");
    initGraph(new D1Graph(runtime.env["DB"] as ConstructorParameters<typeof D1Graph>[0]));
  } else if (import.meta.env.DEV) {
    // Local dev: use filesystem + better-sqlite3.
    const { LocalStore } = await import("./lib/storage-local.ts");
    const { LocalGraph } = await import("./lib/graph-local.ts");
    initStore(new LocalStore());
    initGraph(new LocalGraph());
  }

  return next();
});
