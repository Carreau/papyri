import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import node from "@astrojs/node";
import cloudflare from "@astrojs/cloudflare";

// Adapter selection is env-switched so the Node and Cloudflare builds
// share a single config:
//
//   PAPYRI_ADAPTER unset / "node"  → @astrojs/node (default; matches the
//                                    historical SSG + Node-SSR build).
//   PAPYRI_ADAPTER=cloudflare      → @astrojs/cloudflare. The build emits
//                                    a Workers-compatible bundle under
//                                    `dist/_worker.js/` plus the static
//                                    HTML under `dist/`. `wrangler dev`
//                                    serves both.
//
// `output: "static"` is preserved either way: static pages keep their
// SSG contract, and only routes marked `prerender = false` end up in
// the adapter's worker bundle. See `viewer/PLAN.md` § M9.1.
const ADAPTER = process.env.PAPYRI_ADAPTER ?? "node";

const adapter =
  ADAPTER === "cloudflare"
    ? cloudflare({
        // The cloudflare adapter's "directory" mode is the right fit here:
        // every prerendered page lands as static HTML next to the worker,
        // so the worker only handles SSR routes.
        platformProxy: { enabled: true },
      })
    : node({ mode: "standalone" });

// Build output layout:
//
//   pnpm build (Node):
//     dist/              static HTML/assets
//     dist/server/       Node entry for SSR routes
//     dist/client/       client-side JS/CSS for SSR pages
//
//   pnpm build:cf (Cloudflare):
//     dist/              static HTML/assets
//     dist/_worker.js/   Workers entry for SSR routes
//
// To run the Node server:        `pnpm build && pnpm serve`
// To run the Cloudflare worker:  `pnpm build:cf && pnpm wrangler dev`
//
// `cloudflare:workers` is a virtual module that only exists inside the
// Workers runtime; under the Node adapter it must be marked external so
// rollup leaves the (dynamic, runtime-guarded) import alone instead of
// trying to bundle it. The Cloudflare adapter knows about it natively.
const viteCfg =
  ADAPTER === "cloudflare"
    ? {}
    : { build: { rollupOptions: { external: ["cloudflare:workers"] } } };

export default defineConfig({
  output: "static",
  adapter,
  integrations: [react()],
  server: { port: 4321 },
  vite: viteCfg,
});
