// Vite-specific `?raw` query — imports a file's contents as a UTF-8
// string at build time. Used by the viewer's SSR `PUT /api/bundle`
// handler to inline `papyri-ingest/migrations/0000_init.sql` so the
// bundled chunk doesn't have to fs.readdirSync a `migrations/` dir
// that's no longer next to it after bundling.
//
// See `bundle.ts` for the call site. astro/vite both honour this query
// without extra config.

declare module "*?raw" {
  const content: string;
  export default content;
}
