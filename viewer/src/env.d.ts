/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Git commit SHA baked in at build time (see astro.config.mjs). */
  readonly PAPYRI_BUILD_COMMIT: string;
  /** Adapter used at build time: "node" or "cloudflare". */
  readonly PAPYRI_BUILD_ADAPTER: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
