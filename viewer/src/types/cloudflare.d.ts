// Minimal declaration for the `cloudflare:workers` virtual module so the
// Node-adapter `astro check` build doesn't error on the dynamic import in
// `src/pages/api/health.json.ts`. The module is provided by the Workers
// runtime (and by @astrojs/cloudflare during a CF build); the declaration
// here only exists to keep TypeScript happy across both adapters.
//
// We intentionally type `env` loosely as a record. Once M9.2 starts
// reading bindings for real, this declaration tightens to:
//   export const env: { GRAPH_DB: D1Database; BLOBS: R2Bucket }
// (which will pull in `@cloudflare/workers-types` for the binding types).

declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
