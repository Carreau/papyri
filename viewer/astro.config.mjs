import { execSync } from "node:child_process";
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import node from "@astrojs/node";

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

// Build-time constants injected into import.meta.env.
// Statically replaced by Vite at bundle time.
const buildDefine = {
  "import.meta.env.PAPYRI_BUILD_COMMIT": JSON.stringify(PAPYRI_BUILD_COMMIT),
  "import.meta.env.PAPYRI_BUILD_ADAPTER": JSON.stringify("node"),
};

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [react()],
  server: { port: 4321 },
  vite: { define: buildDefine },
  // All mutating endpoints carry their own bearer-token / session-cookie
  // checks, so the Origin cross-check adds no security while breaking PUT
  // requests forwarded by a reverse proxy whose external host differs from
  // localhost:4321.
  security: { checkOrigin: false },
  ...(PAPYRI_SITE ? { site: PAPYRI_SITE } : {}),
});
