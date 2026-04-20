# Deploying the viewer (Cloudflare Workers SSR)

The viewer has moved from Astro SSG (static pre-build) to Astro SSR running
as a Cloudflare Worker. Pages are rendered on request; bundle data is read
from Cloudflare R2 and the cross-link graph from Cloudflare D1.

## Architecture

```
  Library maintainer
  └─ papyri gen → ~/.papyri/data/<pkg>_<ver>/
  └─ papyri upload --token <TOKEN>  →  upload-api/ Worker
                                           │
                                           ├─ stores bundle ZIP → R2  bundles/<pkg>/<ver>.zip
                                           └─ triggers GitHub Actions ingest workflow
                                                       │
                                                       ├─ papyri ingest → decoded CBOR → R2  ingest/<pkg>/<ver>/…
                                                       └─ papyri export-to-d1 | wrangler d1 execute → D1

  End-user browser
  └─ GET /<pkg>/<ver>/<qualname>/  →  viewer/ Worker
                                         ├─ reads ingest/<pkg>/<ver>/module/<qualname> from R2
                                         └─ queries cross-link graph from D1
```

## One-time Cloudflare setup

1. **Create an R2 bucket** named `papyri-bundles`.
2. **Create a D1 database** named `papyri-graph`. Note the database ID.
3. **Set up the D1 schema**:
   ```sh
   # Graph tables (documents, destinations, links):
   wrangler d1 execute papyri-graph --remote \
     --file papyri/graphstore_schema.sql

   # Token tables:
   papyri token schema \
     | wrangler d1 execute papyri-graph --remote --file /dev/stdin
   ```
4. **Update `wrangler.toml`** in `viewer/` and `upload-api/` with your
   Cloudflare `account_id` and the D1 `database_id`.
5. **Deploy the upload API**:
   ```sh
   cd upload-api
   pnpm install
   wrangler secret put GITHUB_TOKEN   # fine-grained PAT, Actions:write
   wrangler deploy
   ```
6. **Deploy the viewer**:
   ```sh
   cd viewer
   pnpm install --frozen-lockfile
   pnpm build
   wrangler deploy
   ```

## Shared R2 bucket

Both the upload API and the viewer bind to the **same** R2 bucket
(`papyri-bundles`). The upload API writes to `bundles/` and the ingest
pipeline writes to `ingest/`. The viewer reads from `ingest/` only.

## GitHub Actions secrets

| Secret | Used by |
|---|---|
| `CLOUDFLARE_API_TOKEN` | ingest.yml — `wrangler d1 execute` |
| `CLOUDFLARE_ACCOUNT_ID` | ingest.yml + rclone |
| `R2_ACCESS_KEY_ID` | ingest.yml — rclone |
| `R2_SECRET_ACCESS_KEY` | ingest.yml — rclone |

The upload API also needs `GITHUB_TOKEN` set as a **wrangler secret** (not a
GitHub Actions secret) so the Worker can dispatch the ingest workflow.

## Local development

`pnpm dev` starts the Astro dev server in Node.js mode. In this mode,
`Astro.locals.runtime` is undefined, so the middleware falls back to:
- `~/.papyri/ingest/` for bundle files (via `LocalStore` + `node:fs`)
- `~/.papyri/ingest/papyri.db` for the graph (via `LocalGraph` + `better-sqlite3`)

This matches the pre-4a behaviour — run `papyri gen` + `papyri ingest` locally
and `pnpm dev` serves them as before.

To test against actual R2/D1 locally, use `wrangler dev` with bindings
configured in `viewer/wrangler.toml`. Remote bindings are supported with
`wrangler dev --remote`.

## Ingesting a bundle without the upload API

For local testing or CI-based ingest, you can skip the upload API and run
the ingest pipeline directly:

```sh
# Generate
papyri gen examples/papyri.toml --no-infer

# Ingest locally
papyri ingest ~/.papyri/data/papyri_<ver>

# Push ingested blobs to R2
rclone sync ~/.papyri/ingest/papyri/<ver>/ \
  r2:papyri-bundles/ingest/papyri/<ver>/

# Export graph to D1
papyri export-to-d1 \
  | wrangler d1 execute papyri-graph --remote --file /dev/stdin
```
