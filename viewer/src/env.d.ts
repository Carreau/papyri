/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Git commit SHA baked in at build time (see astro.config.mjs). */
  readonly PAPYRI_BUILD_COMMIT: string;
  /** Astro adapter baked in at build time (currently always "node"). */
  readonly PAPYRI_BUILD_ADAPTER: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
