/// <reference types="astro/client" />

// Cloudflare Worker bindings available via Astro.locals.runtime.env when
// deployed with @astrojs/cloudflare.
interface CloudflareBindings {
  /** R2 bucket holding ingested bundle blobs. */
  BUNDLE_STORE: unknown;
  /** D1 database holding the papyri cross-link graph + token table. */
  DB: unknown;
}

type Runtime = import("@astrojs/cloudflare").Runtime<CloudflareBindings>;

declare namespace App {
  interface Locals extends Runtime {}
}
