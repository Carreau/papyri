import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import node from "@astrojs/node";

// `output: "static"` keeps SSG as the default for every existing page
// (qualname pages, bundle indexes, docs, examples, search manifests).
// The Node adapter is attached so individual routes can opt into SSR
// via `export const prerender = false;` — see `src/pages/api/*`.
//
// Build output layout with this config:
//   dist/              static HTML/assets as before
//   dist/server/       server bundle for the SSR routes only
//   dist/client/       client-side JS/CSS for SSR pages
//
// For a pure-SSG deploy (the current Cloudflare Pages target), the SSR
// endpoints are still built into `dist/server/` but never invoked; the
// static host just doesn't serve those routes. To run the server
// locally: `pnpm build && node ./dist/server/entry.mjs`.
export default defineConfig({
  output: "static",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  server: { port: 4321 },
});
