import { execSync } from "node:child_process";
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

// Bake the git commit hash at build time so the admin panel can display it.
// Falls back to PAPYRI_COMMIT env var (useful when git is unavailable in CI),
// then to "unknown".
let PAPYRI_BUILD_COMMIT = process.env.PAPYRI_COMMIT ?? "unknown";
try {
  PAPYRI_BUILD_COMMIT = execSync("git rev-parse HEAD", { stdio: ["pipe", "pipe", "ignore"] })
    .toString()
    .trim();
} catch {
  // git not available (e.g. Docker build without .git); keep env var fallback
}

// PAPYRI_SITE sets the canonical origin (e.g. "https://docs.example.com").
// Astro uses this for CSRF origin checks (security.checkOrigin) and canonical
// URL generation. Required when deployed behind a reverse proxy whose external
// hostname differs from the container's internal host.
const PAPYRI_SITE = process.env.PAPYRI_SITE;

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
// Build-time constants injected into import.meta.env for both adapters.
// These are statically replaced by Vite at bundle time, so they work inside
// the Cloudflare Workers bundle where process.env is unavailable at runtime.
const buildDefine = {
  "import.meta.env.PAPYRI_BUILD_COMMIT": JSON.stringify(PAPYRI_BUILD_COMMIT),
  "import.meta.env.PAPYRI_BUILD_ADAPTER": JSON.stringify(ADAPTER),
};

const viteCfg =
  ADAPTER === "cloudflare"
    ? { define: buildDefine }
    : {
        build: { rollupOptions: { external: ["cloudflare:workers"] } },
        define: buildDefine,
      };

export default defineConfig({
  output: "server",
  adapter,
  integrations: [react()],
  server: { port: 4321 },
  vite: viteCfg,
  ...(PAPYRI_SITE ? { site: PAPYRI_SITE } : {}),
});
