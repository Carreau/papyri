import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  integrations: [react()],
  // SSR mode: pages are rendered on request, not pre-built.
  // The @astrojs/cloudflare adapter targets Cloudflare Workers.
  // For local dev (`pnpm dev`), Astro runs in Node.js and
  // Astro.locals.runtime is undefined — the middleware falls back
  // to the local filesystem + better-sqlite3 path.
  output: "server",
  adapter: cloudflare({
    // nodejs_compat enables Node.js built-ins (fs, path, etc.) in the Worker.
    // These are used by the local dev fallback; in production only R2/D1 are hit.
    platformProxy: {
      enabled: true,
    },
  }),
  server: { port: 4321 },
});
